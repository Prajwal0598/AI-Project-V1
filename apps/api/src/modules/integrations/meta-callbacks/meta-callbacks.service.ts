import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../../database/prisma.service";
import { primaryWebOrigin } from "../../../common/cors.helper";
import { captureException } from "../../../common/error-reporting.helper";
import { parseMetaSignedRequest, type MetaSignedRequestPayload } from "../../../common/meta-signed-request.helper";
import { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { isCallbackIdentityMatchVerified, readMetaAppConfig } from "./meta-app-config";
import { revokeConnections, unsubscribeRevoked, type RevokedConnection } from "./meta-connection-revocation";

export const CALLBACK_KIND = { DEAUTHORIZATION: "DEAUTHORIZATION", DATA_DELETION: "DATA_DELETION" } as const;
export const CONFIRMATION_CODE_PATTERN = /^[a-f0-9]{32}$/;
/** A deauthorization matched a stored link, but identity matching is unverified, so nothing was changed. */
export const STATUS_NO_ACTION_UNVERIFIED = "NO_ACTION_UNVERIFIED";
export const REASON_IDENTITY_MATCH_UNVERIFIED = "IDENTITY_MATCH_UNVERIFIED";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

// plain-language outcome shown on the public status page; fixed text only, so nothing about any merchant or person can leak into it
export const STATUS_MESSAGES: Record<string, string> = {
  PENDING_REVIEW: "We received your request. We could not automatically confirm which RelayShift workspace, if any, this Facebook account belongs to, so a member of our team will review it manually before anything is changed.",
  COMPLETED: "We removed the Facebook account identifier we held for this account and disconnected any WhatsApp connection it had authorised. Records that merchants keep about their own customers, and order and payment records kept for tax and accounting, are not covered by this request and are retained.",
  NO_DATA_HELD: "We reviewed your request and found no data linked to this Facebook account.",
};
const FALLBACK_STATUS_MESSAGE = "We received your request and are processing it.";

export interface DeletionStatusView {
  confirmationCode: string;
  status: string;
  message: string;
  receivedAt: Date;
  completedAt: Date | null;
}

/**
 * Handles the two callbacks Meta sends when a Facebook user removes the app (deauthorization) or asks for their data to be
 * deleted (data deletion). They are separate events with separate audit rows and endpoints and are never treated as one.
 *
 * Meta identifies the person only by an app-scoped user id. That id is matched against MetaUserLink, which is written solely
 * from identities Meta itself vouched for to our server (see MetaUserLinkService). No link means no match: nothing is changed
 * and a deletion request is parked for a platform admin to review (MetaCallbackAdminService). Even a link is only trusted to act
 * on its own once META_CALLBACK_IDENTITY_MATCH_VERIFIED=true; until then a match is recorded and parked for review exactly like
 * no match. Neither callback can delete a business, its customers, or its orders.
 */
@Injectable()
export class MetaCallbacksService {
  private readonly logger = new Logger(MetaCallbacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiService,
  ) {}

  /** The user removed RelayShift from their Facebook account: stop using the connection(s) they authorised. */
  async handleDeauthorization(signedRequest: unknown): Promise<{ success: true }> {
    const { userId, issuedAt } = this.verify(signedRequest);
    const dedupeKey = this.dedupeKey(CALLBACK_KIND.DEAUTHORIZATION, userId, issuedAt);
    if (await this.findByDedupeKey(dedupeKey)) return { success: true };
    const actOnMatch = isCallbackIdentityMatchVerified();

    let revoked: RevokedConnection[] = [];
    try {
      revoked = await this.prisma.$transaction(async (tx) => {
        // inserting the audit row first makes the unique dedupeKey a lock: a concurrent duplicate waits here, then fails with P2002
        const request = await tx.metaCallbackRequest.create({
          data: { kind: CALLBACK_KIND.DEAUTHORIZATION, dedupeKey, metaUserId: userId, signedRequestIssuedAt: issuedAt, status: "IN_PROGRESS", events: { create: { action: "RECEIVED" } } },
        });
        const links = await tx.metaUserLink.findMany({ where: { metaUserId: userId, revokedAt: null } });
        const businessIds = [...new Set(links.map((l) => l.businessId))];
        if (links.length && !actOnMatch) {
          await tx.metaCallbackRequest.update({ where: { id: request.id }, data: { status: STATUS_NO_ACTION_UNVERIFIED, completedAt: new Date() } });
          await tx.metaCallbackEvent.create({ data: { requestId: request.id, action: "PROCESSED", fromStatus: "IN_PROGRESS", toStatus: STATUS_NO_ACTION_UNVERIFIED, detail: { matchedBusinesses: 0, reason: REASON_IDENTITY_MATCH_UNVERIFIED, candidateBusinessIds: businessIds } } });
          return [];
        }
        const connections = await revokeConnections(tx, businessIds);
        if (links.length) await tx.metaUserLink.updateMany({ where: { id: { in: links.map((l) => l.id) } }, data: { revokedAt: new Date(), revokedReason: "DEAUTHORIZED" } });
        const status = links.length ? "COMPLETED" : "NO_MATCH";
        await tx.metaCallbackRequest.update({
          where: { id: request.id },
          data: { status, matchedBusinessIds: businessIds, connectionsRevoked: connections.length, completedAt: new Date() },
        });
        await tx.metaCallbackEvent.create({ data: { requestId: request.id, action: "PROCESSED", fromStatus: "IN_PROGRESS", toStatus: status, detail: { matchedBusinesses: businessIds.length, connectionsRevoked: connections.length } } });
        return connections;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      if (this.isDuplicate(err)) return { success: true };
      throw this.failed("deauthorization", err);
    }

    this.logger.log(`Meta deauthorization processed: ${revoked.length} connection(s) revoked`);
    await unsubscribeRevoked(this.meta, this.logger, revoked);
    return { success: true };
  }

  /** The user asked for the data Facebook gave us about them to be deleted. Returns the JSON shape Meta requires. */
  async handleDataDeletion(signedRequest: unknown): Promise<{ url: string; confirmation_code: string }> {
    const { userId, issuedAt } = this.verify(signedRequest);
    const dedupeKey = this.dedupeKey(CALLBACK_KIND.DATA_DELETION, userId, issuedAt);

    const existing = await this.findByDedupeKey(dedupeKey);
    if (existing?.confirmationCode) return this.deletionResponse(existing.confirmationCode);
    const actOnMatch = isCallbackIdentityMatchVerified();

    const confirmationCode = randomBytes(16).toString("hex");
    let revoked: RevokedConnection[] = [];
    try {
      revoked = await this.prisma.$transaction(async (tx) => {
        const request = await tx.metaCallbackRequest.create({
          data: { kind: CALLBACK_KIND.DATA_DELETION, dedupeKey, confirmationCode, metaUserId: userId, signedRequestIssuedAt: issuedAt, status: "IN_PROGRESS", events: { create: { action: "RECEIVED" } } },
        });
        const links = await tx.metaUserLink.findMany({ where: { metaUserId: userId } });

        if (!links.length || !actOnMatch) {
          // no verified association (or one nobody has confirmed against a real Meta callback): do not guess which merchant this person is — park it for a platform admin
          await tx.metaCallbackRequest.update({ where: { id: request.id }, data: { status: "PENDING_REVIEW" } });
          const detail = links.length
            ? { matchedBusinesses: 0, reason: REASON_IDENTITY_MATCH_UNVERIFIED, candidateBusinessIds: [...new Set(links.map((l) => l.businessId))] }
            : { matchedBusinesses: 0, reason: "NO_VERIFIED_ASSOCIATION" };
          await tx.metaCallbackEvent.create({ data: { requestId: request.id, action: "PROCESSED", fromStatus: "IN_PROGRESS", toStatus: "PENDING_REVIEW", detail } });
          return [];
        }

        const matchedBusinessIds = [...new Set(links.map((l) => l.businessId))];
        const activeBusinessIds = [...new Set(links.filter((l) => !l.revokedAt).map((l) => l.businessId))];
        const connections = await revokeConnections(tx, activeBusinessIds);
        await tx.metaUserLink.deleteMany({ where: { metaUserId: userId } });
        // the identifier was the data being deleted: earlier audit rows (including this one) stop holding it too — retries match on dedupeKey
        await tx.metaCallbackRequest.updateMany({ where: { metaUserId: userId }, data: { metaUserId: null } });
        await tx.metaCallbackRequest.update({
          where: { id: request.id },
          data: { status: "COMPLETED", matchedBusinessIds, connectionsRevoked: connections.length, completedAt: new Date() },
        });
        await tx.metaCallbackEvent.create({ data: { requestId: request.id, action: "PROCESSED", fromStatus: "IN_PROGRESS", toStatus: "COMPLETED", detail: { matchedBusinesses: matchedBusinessIds.length, connectionsRevoked: connections.length } } });
        return connections;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      if (this.isDuplicate(err)) {
        const winner = await this.findByDedupeKey(dedupeKey);
        if (winner?.confirmationCode) return this.deletionResponse(winner.confirmationCode);
      }
      throw this.failed("data deletion", err);
    }

    this.logger.log(`Meta data-deletion request received: ${revoked.length} connection(s) revoked`);
    await unsubscribeRevoked(this.meta, this.logger, revoked);
    return this.deletionResponse(confirmationCode);
  }

  /** Public, read-only. Looked up by the unguessable confirmation code only; returns no identifier of any person or merchant. */
  async getDeletionStatus(confirmationCode: string): Promise<DeletionStatusView> {
    if (!CONFIRMATION_CODE_PATTERN.test(confirmationCode)) throw new NotFoundException("Request not found.");
    const request = await this.prisma.metaCallbackRequest.findUnique({
      where: { confirmationCode },
      select: { confirmationCode: true, kind: true, status: true, createdAt: true, completedAt: true },
    });
    if (!request || request.kind !== CALLBACK_KIND.DATA_DELETION || !request.confirmationCode) throw new NotFoundException("Request not found.");
    return {
      confirmationCode: request.confirmationCode,
      status: request.status,
      message: STATUS_MESSAGES[request.status] ?? FALLBACK_STATUS_MESSAGE,
      receivedAt: request.createdAt,
      completedAt: request.completedAt,
    };
  }

  private verify(signedRequest: unknown): MetaSignedRequestPayload {
    const { appSecret } = readMetaAppConfig();
    // never skipped, unlike the message webhooks: these callbacks change state, so an unconfigured secret must fail closed
    if (!appSecret) throw new ServiceUnavailableException("Meta callbacks are not configured on this server.");
    const parsed = parseMetaSignedRequest(signedRequest, appSecret);
    if (parsed.ok) return parsed.payload;
    this.logger.warn(`Rejected a Meta callback (${parsed.reason})`);
    if (parsed.reason === "bad_signature") throw new ForbiddenException("Invalid signature.");
    throw new BadRequestException("Invalid signed request.");
  }

  private dedupeKey(kind: string, userId: string, issuedAt: Date | null): string {
    return createHash("sha256").update(`${kind}:${userId}:${issuedAt?.getTime() ?? ""}`).digest("hex");
  }

  private findByDedupeKey(dedupeKey: string) {
    return this.prisma.metaCallbackRequest.findUnique({ where: { dedupeKey }, select: { confirmationCode: true } });
  }

  private deletionResponse(confirmationCode: string) {
    return { url: `${primaryWebOrigin(process.env.WEB_ORIGIN)}/data-deletion/status?code=${confirmationCode}`, confirmation_code: confirmationCode };
  }

  private isDuplicate(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }

  private failed(what: string, err: unknown): InternalServerErrorException {
    this.logger.error(`Meta ${what} callback failed and was rolled back (${err instanceof Error ? err.name : "UnknownError"})`);
    captureException(err, { callback: what });
    return new InternalServerErrorException("The request could not be processed. It is safe to retry.");
  }
}
