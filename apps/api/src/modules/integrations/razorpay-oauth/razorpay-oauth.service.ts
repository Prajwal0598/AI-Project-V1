import { Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RazorpayConnectionStatus } from "@prisma/client";
import { PrismaService } from "../../../database/prisma.service";
import { encryptSecret, decryptSecret } from "../../../common/crypto.helper";
import { RazorpayOAuthApiService } from "./razorpay-oauth-api.service";

export interface RazorpayConnectionStatusView {
  status: RazorpayConnectionStatus;
  accountId: string | null;
  connectedAt: Date | null;
  lastErrorMessage: string | null;
}

// short-lived, purpose-scoped JWT used as the OAuth `state` param — Razorpay's redirect callback is a plain
// browser navigation (no Authorization header from our SPA), so this is how we both (a) identify which
// business initiated the connection and (b) get CSRF protection, without a separate stateful DB table
const STATE_PURPOSE = "razorpay_oauth_state";
const STATE_TTL = "10m";

interface StatePayload {
  businessId: string;
  purpose: typeof STATE_PURPOSE;
}

const SETUP_FIELDS_SELECT = {
  razorpayConnectionStatus: true, razorpayAccountId: true, razorpayConnectedAt: true, razorpayLastErrorMessage: true,
} as const;

function redirectUri(): string {
  const base = process.env.API_PUBLIC_URL?.trim() || `http://localhost:${process.env.PORT || 4000}`;
  return `${base}/api/integrations/razorpay/callback`;
}

/**
 * Orchestrates Razorpay OAuth (Technology Partner) connect/disconnect — the payments equivalent of
 * WhatsAppEmbeddedSignupService. Requires RAZORPAY_OAUTH_CLIENT_ID/SECRET (a Partner Application, only
 * obtainable once Relay is an approved Razorpay Technology Partner — see docs/app-overview.md). businessId
 * always comes from the authenticated caller for buildAuthorizeUrl/disconnect; handleCallback instead trusts
 * only the signed `state` it itself issued, since that request is an unauthenticated browser redirect from
 * Razorpay, not a fetch call from our own frontend.
 */
@Injectable()
export class RazorpayOAuthService {
  private readonly logger = new Logger(RazorpayOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpayOAuth: RazorpayOAuthApiService,
    private readonly jwt: JwtService,
  ) {}

  private toView(business: {
    razorpayConnectionStatus: RazorpayConnectionStatus; razorpayAccountId: string | null;
    razorpayConnectedAt: Date | null; razorpayLastErrorMessage: string | null;
  }): RazorpayConnectionStatusView {
    return {
      status: business.razorpayConnectionStatus,
      accountId: business.razorpayAccountId,
      connectedAt: business.razorpayConnectedAt,
      lastErrorMessage: business.razorpayLastErrorMessage,
    };
  }

  async getStatus(businessId: string): Promise<RazorpayConnectionStatusView> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: SETUP_FIELDS_SELECT });
    if (!business) throw new NotFoundException("Business not found.");
    return this.toView(business);
  }

  buildAuthorizeUrl(businessId: string): string {
    const state = this.jwt.sign({ businessId, purpose: STATE_PURPOSE } satisfies StatePayload, { expiresIn: STATE_TTL });
    return this.razorpayOAuth.buildAuthorizeUrl(state, redirectUri());
  }

  /** Called from the public GET /integrations/razorpay/callback route Razorpay redirects the browser to.
   * Returns the businessId purely so the controller can log it — the frontend never receives it directly,
   * it just gets redirected back to Settings and re-fetches its own status via the authenticated endpoint. */
  async handleCallback(code: string, state: string): Promise<{ businessId: string }> {
    let payload: StatePayload;
    try {
      payload = this.jwt.verify<StatePayload>(state);
    } catch {
      throw new UnauthorizedException("This connection link has expired or is invalid — please try connecting again.");
    }
    if (payload.purpose !== STATE_PURPOSE) throw new UnauthorizedException("Invalid connection request.");
    const { businessId } = payload;

    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    let tokens;
    try {
      tokens = await this.razorpayOAuth.exchangeCodeForToken(code, redirectUri());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Razorpay connection failed.";
      await this.prisma.business.update({ where: { id: businessId }, data: { razorpayConnectionStatus: RazorpayConnectionStatus.RETRY_REQUIRED, razorpayLastErrorMessage: message } });
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(message);
    }

    const now = new Date();
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        razorpayAccountId: tokens.razorpayAccountId ?? business.razorpayAccountId,
        razorpayAccessTokenEncrypted: encryptSecret(tokens.accessToken),
        razorpayRefreshTokenEncrypted: encryptSecret(tokens.refreshToken),
        razorpayPublicToken: tokens.publicToken,
        razorpayTokenExpiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000),
        razorpayConnectionStatus: RazorpayConnectionStatus.CONNECTED,
        razorpayConnectedAt: now,
        razorpayLastErrorMessage: null,
      },
    });
    this.logger.log(`Razorpay OAuth connected for business ${businessId}`);
    return { businessId };
  }

  async disconnect(businessId: string): Promise<RazorpayConnectionStatusView> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    if (business.razorpayAccessTokenEncrypted) {
      // best-effort — never blocks the local disconnect below
      try {
        await this.razorpayOAuth.revokeToken(decryptSecret(business.razorpayAccessTokenEncrypted), "access_token");
      } catch (err) {
        this.logger.warn(`Razorpay token revocation failed during disconnect for business ${businessId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        razorpayAccountId: null,
        razorpayAccessTokenEncrypted: null,
        razorpayRefreshTokenEncrypted: null,
        razorpayPublicToken: null,
        razorpayTokenExpiresAt: null,
        razorpayConnectionStatus: RazorpayConnectionStatus.DISCONNECTED,
        razorpayConnectedAt: null,
        razorpayLastErrorMessage: null,
      },
    });
    return this.toView(updated);
  }
}
