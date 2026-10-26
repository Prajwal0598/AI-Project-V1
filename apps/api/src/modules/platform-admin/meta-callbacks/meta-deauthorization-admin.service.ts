import { BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type WhatsAppConnectionStatus } from "@prisma/client";
import { PrismaService } from "../../../database/prisma.service";
import { captureException } from "../../../common/error-reporting.helper";
import { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { CALLBACK_KIND, STATUS_NO_ACTION_UNVERIFIED } from "../../integrations/meta-callbacks/meta-callbacks.service";
import { NOT_LIVE, revokeConnections, unsubscribeRevoked, type RevokedConnection } from "../../integrations/meta-callbacks/meta-connection-revocation";
import { ID_PATTERN } from "./meta-callback-admin.dto";
import { orderCallbackEvents } from "./meta-callback-event-order";
import {
  DEAUTH_DISCONNECT_METHODS, DEAUTH_RESOLVED_STATUS,
  type DeauthOutcome, type DeauthVerificationMethod, type ListDeauthorizationsQueryDto, type PreviewDeauthorizationDto, type ResolveDeauthorizationDto,
} from "./meta-deauthorization-admin.dto";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const AWAITING = STATUS_NO_ACTION_UNVERIFIED;

// never includes the Facebook user id: an operator reviewing a deauthorization has no use for it and must not need to handle it
const REQUEST_SELECT = {
  id: true, kind: true, status: true, matchedBusinessIds: true, connectionsRevoked: true, resolvedByUserId: true, resolutionReference: true,
  verificationMethod: true, resolutionReason: true, createdAt: true, updatedAt: true, completedAt: true,
} as const;
const INTERNAL_SELECT = { ...REQUEST_SELECT, metaUserId: true } as const;
type RequestRow = Prisma.MetaCallbackRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

interface CandidateState {
  id: string;
  name: string;
  connectionStatus: WhatsAppConnectionStatus;
  stillLinked: boolean;
  connectedAfterEvent: boolean;
  eligible: boolean;
}

/**
 * Platform-admin review of Meta deauthorization events recorded as NO_ACTION_UNVERIFIED: a callback matched a stored link while
 * identity matching is unverified, so nothing was changed automatically. A human decides, off-system, which candidate business (if any)
 * really belongs to the account that removed the app. This is separate from data-deletion review and can never delete anything:
 * the only effects are disconnecting the WhatsApp connection of businesses the admin names and revoking their link to the account.
 * A candidate is only ever a suggestion; naming it, with the merchant's own confirmation recorded, is what authorises the disconnect.
 */
@Injectable()
export class MetaDeauthorizationAdminService {
  private readonly logger = new Logger(MetaDeauthorizationAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiService,
  ) {}

  list(query: ListDeauthorizationsQueryDto) {
    return this.prisma.metaCallbackRequest.findMany({
      where: { kind: CALLBACK_KIND.DEAUTHORIZATION, status: query.status ?? AWAITING },
      orderBy: { createdAt: "desc" },
      take: query.take ?? 25,
      select: REQUEST_SELECT,
    });
  }

  /** One event with its audit history (which holds candidate business ids, never a user id). */
  async get(id: string) {
    this.assertId(id);
    const request = await this.prisma.metaCallbackRequest.findFirst({
      where: { id, kind: CALLBACK_KIND.DEAUTHORIZATION },
      select: { ...REQUEST_SELECT, events: { orderBy: { createdAt: "asc" }, select: { id: true, action: true, fromStatus: true, toStatus: true, actorUserId: true, detail: true, createdAt: true } } },
    });
    if (!request) throw new NotFoundException("Request not found.");
    return { ...request, events: orderCallbackEvents(request.events) };
  }

  /** Dry run: the candidates, whether each could still be disconnected, and what the chosen outcome would do. Writes nothing. */
  async previewResolution(id: string, dto: PreviewDeauthorizationDto) {
    const request = await this.loadRequest(this.prisma, id);
    this.validateCombination(dto, false);
    const named = dto.businessIds ?? [];

    const candidates = await this.assess(this.prisma, request, await this.candidateIds(this.prisma, request.id));
    const warnings: { code: string; message: string }[] = [];
    if (request.status !== AWAITING) warnings.push({ code: "NOT_AWAITING_REVIEW", message: `This event is already ${request.status} and cannot be resolved again.` });
    if (!request.metaUserId) warnings.push({ code: "IDENTIFIER_DELETED", message: "The Facebook identifier for this event was deleted, so no connection can be disconnected from it. Close it as NO_CHANGE." });
    for (const businessId of named) {
      const state = candidates.find((c) => c.id === businessId);
      if (!state) warnings.push({ code: "NOT_A_CANDIDATE", message: `${businessId} is not a candidate of this event.` });
      else if (!state.stillLinked) warnings.push({ code: "LINK_NO_LONGER_ACTIVE", message: `${businessId} is no longer linked to this account, so its current connection is not the one this event concerns.` });
      else if (state.connectedAfterEvent) warnings.push({ code: "RECONNECTED_AFTER_EVENT", message: `${businessId} was connected again after this event was received, so it is a different connection.` });
    }

    return {
      dryRun: true,
      requestId: request.id,
      status: request.status,
      outcome: dto.outcome,
      confirmationRequired: this.confirmationFor(dto.outcome, request.id),
      candidates: candidates.map((c) => ({ id: c.id, name: c.name, connectionStatus: c.connectionStatus, stillLinked: c.stillLinked, connectedAfterEvent: c.connectedAfterEvent, eligibleToDisconnect: c.eligible, wouldDisconnect: c.eligible && named.includes(c.id) && !NOT_LIVE.includes(c.connectionStatus) })),
      warnings,
      proposedAction: dto.outcome === "DISCONNECT_VERIFIED"
        ? "Disconnect the WhatsApp connection of the named businesses only, and revoke their link to this Facebook account."
        : "Change nothing. The event is closed with the reason and reference you record.",
      notAffected: "Businesses, customers, conversations, orders and payment records are never deleted. Candidates you do not name are never touched.",
    };
  }

  /** Disconnects only the named, eligible businesses. All changes and the audit entry commit together or not at all. */
  async resolve(id: string, dto: ResolveDeauthorizationDto, actorUserId: string) {
    this.validateCombination(dto, true);
    const request = await this.loadRequest(this.prisma, id);
    if (dto.confirm !== this.confirmationFor(dto.outcome, request.id)) throw new BadRequestException(`Confirmation text does not match. Send exactly: ${this.confirmationFor(dto.outcome, request.id)}`);
    if (request.status !== AWAITING) return this.replayOrConflict(request, dto);

    const businessIds = dto.businessIds ?? [];
    let revoked: RevokedConnection[];
    try {
      revoked = await this.prisma.$transaction(async (tx) => {
        // the claim takes the row lock: of two simultaneous resolutions exactly one proceeds, the other sees it is no longer awaiting review
        const claimed = await tx.metaCallbackRequest.updateMany({
          where: { id, kind: CALLBACK_KIND.DEAUTHORIZATION, status: AWAITING },
          data: { resolvedByUserId: actorUserId, resolutionReference: dto.resolutionReference, verificationMethod: dto.verificationMethod, resolutionReason: dto.reason ?? null },
        });
        if (claimed.count !== 1) throw new ConflictException("This event has already been resolved.");

        let connections: RevokedConnection[] = [];
        if (dto.outcome === "DISCONNECT_VERIFIED") {
          // serialises with another resolution or a reconnect touching the same businesses, so the checks below describe the rows we then change
          await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" IN (${Prisma.join([...businessIds].sort())}) ORDER BY "id" FOR UPDATE`;
          const fresh = await this.loadRequest(tx, id);
          if (!fresh.metaUserId) throw new ConflictException("The Facebook identifier for this event was deleted, so nothing can be disconnected from it. Close it as NO_CHANGE.");
          const candidates = await this.assess(tx, fresh, await this.candidateIds(tx, id));
          for (const businessId of businessIds) {
            const state = candidates.find((c) => c.id === businessId);
            // an unknown business and another tenant's business are indistinguishable, so ids cannot be probed
            if (!state) throw new NotFoundException("Business not found among this event's candidates.");
            if (!state.stillLinked) throw new ConflictException("A named business is no longer linked to this account. Preview again.");
            if (state.connectedAfterEvent) throw new ConflictException("A named business was connected again after this event was received. Preview again.");
          }
          connections = await revokeConnections(tx, businessIds);
          await tx.metaUserLink.updateMany({ where: { metaUserId: fresh.metaUserId, businessId: { in: businessIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "DEAUTHORIZED" } });
        }

        const status = DEAUTH_RESOLVED_STATUS[dto.outcome];
        await tx.metaCallbackRequest.update({ where: { id }, data: { status, matchedBusinessIds: businessIds, connectionsRevoked: connections.length, completedAt: new Date() } });
        await tx.metaCallbackEvent.create({
          data: {
            requestId: id, action: "RESOLVED", fromStatus: AWAITING, toStatus: status, actorUserId,
            detail: { outcome: dto.outcome, businessIds, connectionsRevoked: connections.length, verificationMethod: dto.verificationMethod, resolutionReference: dto.resolutionReference, reason: dto.reason ?? null },
          },
        });
        return connections;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      if (err instanceof ConflictException) {
        // a concurrent resolution may have used the very same reference — that is a retry, not a conflict
        const latest = await this.loadRequest(this.prisma, id);
        if (latest.status !== AWAITING) return this.replayOrConflict(latest, dto);
      }
      if (err instanceof HttpException) throw err;
      this.logger.error(`Resolution of Meta deauthorization ${id} failed and was rolled back (${err instanceof Error ? err.name : "UnknownError"})`);
      captureException(err, { requestId: id });
      throw new InternalServerErrorException("The resolution failed and was rolled back; nothing was changed. It is safe to retry with the same resolutionReference.");
    }

    this.logger.log(`Meta deauthorization ${id} resolved as ${DEAUTH_RESOLVED_STATUS[dto.outcome]}: ${revoked.length} connection(s) revoked`);
    await unsubscribeRevoked(this.meta, this.logger, revoked);
    return this.result(await this.loadRequest(this.prisma, id), false);
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new NotFoundException("Request not found.");
  }

  /** Only deauthorization events: a data-deletion request is a different event and is never resolved here. */
  private async loadRequest(client: Prisma.TransactionClient | PrismaService, id: string) {
    this.assertId(id);
    const request = await client.metaCallbackRequest.findFirst({ where: { id, kind: CALLBACK_KIND.DEAUTHORIZATION }, select: INTERNAL_SELECT });
    if (!request) throw new NotFoundException("Request not found.");
    return request;
  }

  /** The businesses the callback matched when it was received (written by the callback itself, never by an admin). */
  private async candidateIds(client: Prisma.TransactionClient | PrismaService, requestId: string): Promise<string[]> {
    const event = await client.metaCallbackEvent.findFirst({ where: { requestId, action: "PROCESSED", toStatus: AWAITING }, orderBy: { createdAt: "desc" }, select: { detail: true } });
    const ids = (event?.detail as { candidateBusinessIds?: unknown } | null)?.candidateBusinessIds;
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
  }

  private async assess(client: Prisma.TransactionClient | PrismaService, request: { metaUserId: string | null; createdAt: Date }, candidateIds: string[]): Promise<CandidateState[]> {
    if (!candidateIds.length) return [];
    const businesses = await client.business.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true, whatsappConnectionStatus: true, whatsappConnectedAt: true }, orderBy: { id: "asc" } });
    const links = request.metaUserId
      ? await client.metaUserLink.findMany({ where: { metaUserId: request.metaUserId, revokedAt: null, businessId: { in: candidateIds } }, select: { businessId: true } })
      : [];
    const linked = new Set(links.map((l) => l.businessId));
    return businesses.map((b) => {
      const stillLinked = linked.has(b.id);
      const connectedAfterEvent = !!b.whatsappConnectedAt && b.whatsappConnectedAt > request.createdAt;
      return { id: b.id, name: b.name, connectionStatus: b.whatsappConnectionStatus, stillLinked, connectedAfterEvent, eligible: stillLinked && !connectedAfterEvent };
    });
  }

  private confirmationFor(outcome: DeauthOutcome, requestId: string): string {
    return `${outcome} ${requestId}`;
  }

  private validateCombination(dto: PreviewDeauthorizationDto & { verificationMethod?: DeauthVerificationMethod; reason?: string }, applying: boolean): void {
    const count = dto.businessIds?.length ?? 0;
    if (dto.outcome === "DISCONNECT_VERIFIED") {
      if (count < 1) throw new BadRequestException("DISCONNECT_VERIFIED requires the businessIds whose connection you independently verified.");
      if (dto.reason) throw new BadRequestException("reason only applies to NO_CHANGE.");
      if (dto.verificationMethod && !DEAUTH_DISCONNECT_METHODS.includes(dto.verificationMethod)) throw new BadRequestException("DISCONNECT_VERIFIED requires the merchant's own confirmation: MERCHANT_WRITTEN_CONFIRMATION or EMAIL_FROM_REGISTERED_ADDRESS.");
    } else {
      if (count > 0) throw new BadRequestException("NO_CHANGE cannot name businesses.");
      if (applying && !dto.reason) throw new BadRequestException("NO_CHANGE requires a reason.");
    }
  }

  /** Same outcome, reference, verification method, businesses and reason as the stored resolution: a retry, so answer as before. Anything else is a real conflict. */
  private replayOrConflict(request: RequestRow, dto: ResolveDeauthorizationDto) {
    const sameBusinesses = [...request.matchedBusinessIds].sort().join(",") === [...(dto.businessIds ?? [])].sort().join(",");
    const same = request.status === DEAUTH_RESOLVED_STATUS[dto.outcome] && request.resolutionReference === dto.resolutionReference && request.verificationMethod === dto.verificationMethod && sameBusinesses && (request.resolutionReason ?? null) === (dto.reason ?? null);
    if (same) return this.result(request, true);
    throw new ConflictException(`This event is already ${request.status}.`);
  }

  private result(request: RequestRow, alreadyResolved: boolean) {
    return {
      requestId: request.id,
      status: request.status,
      alreadyResolved,
      matchedBusinessIds: request.matchedBusinessIds,
      connectionsRevoked: request.connectionsRevoked,
      resolutionReason: request.resolutionReason,
      completedAt: request.completedAt,
    };
  }
}
