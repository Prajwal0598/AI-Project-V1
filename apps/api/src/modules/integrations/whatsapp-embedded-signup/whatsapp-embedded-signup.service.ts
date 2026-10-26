import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { WhatsAppConnectionStatus } from "@prisma/client";
import { PrismaService } from "../../../database/prisma.service";
import { encryptSecret, decryptSecret } from "../../../common/crypto.helper";
import { MetaGraphApiService } from "./meta-graph-api.service";
import { CompleteEmbeddedSignupDto } from "./dto/complete-embedded-signup.dto";
import { MetaUserLinkService } from "../meta-callbacks/meta-user-link.service";
import { readMetaAppConfig } from "../meta-callbacks/meta-app-config";

export interface EmbeddedSignupServerConfig {
  /** False while any server variable Embedded Signup needs is missing; `missing` lists their names (never values). */
  ready: boolean;
  missing: string[];
  /** Public Meta App ID the server uses — the browser compares it with NEXT_PUBLIC_META_APP_ID to catch two different apps. */
  appId: string | null;
}

export interface WhatsAppConnectionStatusView {
  status: WhatsAppConnectionStatus;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
  connectedAt: Date | null;
  lastValidatedAt: Date | null;
  lastErrorMessage: string | null;
  config: EmbeddedSignupServerConfig;
}

const SETUP_FIELDS_SELECT = {
  whatsappConnectionStatus: true, whatsappPhoneNumberId: true, whatsappDisplayPhoneNumber: true,
  metaBusinessId: true, whatsappBusinessAccountId: true, whatsappConnectedAt: true,
  whatsappLastValidatedAt: true, whatsappLastErrorMessage: true,
} as const;

/**
 * Orchestrates Meta WhatsApp Embedded Signup (§7 of the spec): validates the onboarding result belongs to the
 * authenticated business, performs the required server-to-server Meta calls via MetaGraphApiService, and only
 * ever marks the connection CONNECTED once phone registration AND webhook subscription have both actually
 * succeeded. Every step is persisted immediately so a failure partway through leaves an accurate
 * RETRY_REQUIRED/SETUP_REQUIRED status rather than silently reporting CONNECTED.
 *
 * businessId always comes from the authenticated caller (never the request body) — see the controller.
 */
@Injectable()
export class WhatsAppEmbeddedSignupService {
  private readonly logger = new Logger(WhatsAppEmbeddedSignupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiService,
    private readonly links: MetaUserLinkService,
  ) {}

  private toView(business: {
    whatsappConnectionStatus: WhatsAppConnectionStatus; whatsappPhoneNumberId: string | null; whatsappDisplayPhoneNumber: string | null;
    metaBusinessId: string | null; whatsappBusinessAccountId: string | null; whatsappConnectedAt: Date | null;
    whatsappLastValidatedAt: Date | null; whatsappLastErrorMessage: string | null;
  }, businessName?: string): WhatsAppConnectionStatusView {
    const { appId, missing } = readMetaAppConfig();
    return {
      status: business.whatsappConnectionStatus,
      phoneNumberId: business.whatsappPhoneNumberId,
      displayPhoneNumber: business.whatsappDisplayPhoneNumber,
      businessName: businessName ?? null,
      connectedAt: business.whatsappConnectedAt,
      lastValidatedAt: business.whatsappLastValidatedAt,
      lastErrorMessage: business.whatsappLastErrorMessage,
      config: { ready: missing.length === 0, missing, appId },
    };
  }

  async getStatus(businessId: string): Promise<WhatsAppConnectionStatusView> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { ...SETUP_FIELDS_SELECT, name: true } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.toView(business, business.name);
  }

  /** Records a failure at whatever step it happened, choosing RETRY_REQUIRED (the authorization itself was
   * bad/expired — start over) vs SETUP_REQUIRED (authorized fine, but server-side setup didn't finish). */
  private async fail(businessId: string, status: "RETRY_REQUIRED" | "SETUP_REQUIRED", error: unknown): Promise<never> {
    const message = error instanceof Error ? error.message : "WhatsApp connection setup failed.";
    await this.prisma.business.update({
      where: { id: businessId },
      data: { whatsappConnectionStatus: status, whatsappLastErrorMessage: message },
    });
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException(message);
  }

  async completeOnboarding(businessId: string, input: CompleteEmbeddedSignupDto): Promise<WhatsAppConnectionStatusView> {
    // a configuration problem is not the merchant's failed attempt, so name it up front instead of recording RETRY_REQUIRED
    const { missing } = readMetaAppConfig();
    if (missing.length) {
      throw new ServiceUnavailableException(`WhatsApp Embedded Signup is not configured on the server. Missing: ${missing.join(", ")}.`);
    }

    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    // idempotent reconnect: the exact same account is already fully connected — just re-validate instead of
    // re-running the whole handshake (and never treat this as an error just because nothing changed)
    if (business.whatsappConnectionStatus === WhatsAppConnectionStatus.CONNECTED
      && business.whatsappBusinessAccountId === input.wabaId
      && business.whatsappPhoneNumberId === input.phoneNumberId) {
      await this.prisma.business.update({ where: { id: businessId }, data: { whatsappLastValidatedAt: new Date() } });
      return this.getStatus(businessId);
    }

    await this.prisma.business.update({ where: { id: businessId }, data: { whatsappConnectionStatus: WhatsAppConnectionStatus.ONBOARDING, whatsappLastErrorMessage: null } });

    let accessToken: string;
    try {
      accessToken = await this.meta.exchangeCodeForToken(input.code);
    } catch (err) {
      return this.fail(businessId, "RETRY_REQUIRED", err);
    }
    await this.prisma.business.update({ where: { id: businessId }, data: { whatsappConnectionStatus: WhatsAppConnectionStatus.AUTHORIZED } });

    await this.prisma.business.update({ where: { id: businessId }, data: { whatsappConnectionStatus: WhatsAppConnectionStatus.CONFIGURING } });
    try {
      await this.meta.registerPhoneNumber(input.phoneNumberId, accessToken);
    } catch (err) {
      return this.fail(businessId, "SETUP_REQUIRED", err);
    }

    try {
      await this.meta.subscribeAppToWaba(input.wabaId, accessToken);
    } catch (err) {
      return this.fail(businessId, "SETUP_REQUIRED", err);
    }
    await this.prisma.business.update({ where: { id: businessId }, data: { whatsappConnectionStatus: WhatsAppConnectionStatus.WEBHOOK_CONNECTED } });

    let phoneDetails;
    try {
      phoneDetails = await this.meta.getPhoneNumberDetails(input.phoneNumberId, accessToken);
    } catch (err) {
      return this.fail(businessId, "SETUP_REQUIRED", err);
    }

    // whatsappPhoneNumberId is globally unique — surface a clear conflict instead of a raw DB constraint error
    // if this exact number is already connected to a DIFFERENT business
    const owner = await this.prisma.business.findUnique({ where: { whatsappPhoneNumberId: input.phoneNumberId } });
    if (owner && owner.id !== businessId) {
      return this.fail(businessId, "RETRY_REQUIRED", new BadRequestException("This WhatsApp number is already connected to a different Relay account."));
    }

    const now = new Date();
    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        whatsappPhoneNumberId: input.phoneNumberId,
        whatsappBusinessAccountId: input.wabaId,
        whatsappDisplayPhoneNumber: phoneDetails.displayPhoneNumber,
        whatsappAccessTokenEncrypted: encryptSecret(accessToken),
        whatsappConnectionStatus: WhatsAppConnectionStatus.CONNECTED,
        whatsappConnectedAt: now,
        whatsappLastValidatedAt: now,
        whatsappLastErrorMessage: null,
      },
    });
    await this.recordConnectionIdentity(businessId, accessToken);
    this.logger.log(`WhatsApp Embedded Signup completed for business ${businessId}`);
    return this.toView(updated, updated.name);
  }

  /**
   * Retires the links that described the previous connection and records who Meta says the new token belongs to. Meta's
   * deauthorization/data-deletion callbacks can only find this business through that id. Failure here never fails the
   * onboarding: the connection simply stays unassociated and such callbacks fall back to platform-admin review.
   */
  private async recordConnectionIdentity(businessId: string, accessToken: string): Promise<void> {
    let identityId: string | null = null;
    try {
      identityId = (await this.meta.getTokenIdentity(accessToken)).id;
    } catch (err) {
      this.logger.warn(`Could not read the Meta identity of the new connection for business ${businessId} (${err instanceof Error ? err.name : "UnknownError"})`);
    }
    await this.links.replaceConnectionLinks(businessId, identityId);
  }

  async disconnect(businessId: string): Promise<WhatsAppConnectionStatusView> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    if (business.whatsappBusinessAccountId && business.whatsappAccessTokenEncrypted) {
      // best-effort — never blocks the local disconnect below
      try {
        await this.meta.deauthorize(business.whatsappBusinessAccountId, decryptSecret(business.whatsappAccessTokenEncrypted));
      } catch (err) {
        this.logger.warn(`Meta deauthorization failed during disconnect for business ${businessId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        whatsappPhoneNumberId: null,
        whatsappBusinessAccountId: null,
        whatsappDisplayPhoneNumber: null,
        metaBusinessId: null,
        whatsappAccessTokenEncrypted: null,
        whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
        whatsappConnectedAt: null,
        whatsappLastValidatedAt: null,
        whatsappLastErrorMessage: null,
      },
    });
    return this.toView(updated, updated.name);
  }
}
