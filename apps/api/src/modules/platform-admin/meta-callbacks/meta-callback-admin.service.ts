import { BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../database/prisma.service";
import { captureException } from "../../../common/error-reporting.helper";
import { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { CALLBACK_KIND, STATUS_MESSAGES } from "../../integrations/meta-callbacks/meta-callbacks.service";
import { NOT_LIVE, revokeConnections, unsubscribeRevoked, type RevokedConnection } from "../../integrations/meta-callbacks/meta-connection-revocation";
import { ID_PATTERN, type ListMetaCallbacksQueryDto, type PreviewResolutionDto, type ResolveMetaCallbackDto } from "./meta-callback-admin.dto";
import { orderCallbackEvents } from "./meta-callback-event-order";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const PENDING = "PENDING_REVIEW";

const REQUEST_SELECT = {
  id: true, kind: true, status: true, confirmationCode: true, metaUserId: true, matchedBusinessIds: true, connectionsRevoked: true,
  resolvedByUserId: true, resolutionReference: true, verificationMethod: true, createdAt: true, updatedAt: true, completedAt: true,
} as const;

type RequestRow = Prisma.MetaCallbackRequestGetPayload<{ select: typeof REQUEST_SELECT }>;
/**
 * Platform-admin review of Meta data-deletion requests that could not be matched to a verified connection automatically
 * (status PENDING_REVIEW). The service never guesses which workspace a Facebook account belongs to: a human establishes that
 * off-system, names the workspaces, and confirms. What a resolution can do is deliberately narrow — disconnect the WhatsApp
 * connection of the workspaces named and remove the Facebook identifier. It cannot delete a business, customers or orders.
 * Deauthorization and data deletion stay separate: only DATA_DELETION requests can be resolved here.
 */
@Injectable()
export class MetaCallbackAdminService {
  private readonly logger = new Logger(MetaCallbackAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiService,
  ) {}

  list(query: ListMetaCallbacksQueryDto) {
    return this.prisma.metaCallbackRequest.findMany({
      where: { ...(query.kind ? { kind: query.kind } : {}), ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: query.take ?? 25,
      select: REQUEST_SELECT,
    });
  }

  /** One request with its full audit history. Contains the Facebook user id while it is still held, so platform admins only. */
  async get(id: string) {
    this.assertId(id);
    const request = await this.prisma.metaCallbackRequest.findUnique({
      where: { id },
      select: { ...REQUEST_SELECT, events: { orderBy: { createdAt: "asc" }, select: { id: true, action: true, fromStatus: true, toStatus: true, actorUserId: true, detail: true, createdAt: true } } },
    });
    if (!request) throw new NotFoundException("Request not found.");
    return { ...request, events: orderCallbackEvents(request.events) };
  }

  /** Dry run: what resolving would do, and what would stop it. Writes nothing. */
  async previewResolution(id: string, dto: PreviewResolutionDto) {
    const request = await this.loadDeletionRequest(id);
    this.validateCombination(dto);
    const businessIds = dto.businessIds ?? [];

    const businesses = businessIds.length
      ? await this.prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true, whatsappConnectionStatus: true } })
      : [];
    const links = request.metaUserId ? await this.prisma.metaUserLink.findMany({ where: { metaUserId: request.metaUserId }, select: { businessId: true } }) : [];
    const linkedBusinessIds = [...new Set(links.map((l) => l.businessId))];

    const warnings: { code: string; message: string }[] = [];
    if (request.status !== PENDING) warnings.push({ code: "NOT_PENDING", message: `This request is already ${request.status} and cannot be resolved again.` });
    if (dto.outcome === "NO_DATA_HELD" && linkedBusinessIds.length) warnings.push({ code: "LINKED_BUSINESSES_EXIST", message: "This Facebook account is now linked to a workspace, so it cannot be closed as no data held." });
    if (dto.outcome === "COMPLETED" && linkedBusinessIds.some((b) => !businessIds.includes(b))) warnings.push({ code: "LINKED_BUSINESSES_NOT_INCLUDED", message: "This Facebook account is also linked to workspaces you did not include; include them to proceed." });
    if (businesses.length !== businessIds.length) warnings.push({ code: "UNKNOWN_BUSINESS", message: "One or more business ids do not exist." });

    return {
      dryRun: true,
      requestId: request.id,
      status: request.status,
      outcome: dto.outcome,
      confirmationRequired: `RESOLVE ${request.confirmationCode}`,
      businesses: businesses.map((b) => ({ id: b.id, name: b.name, connectionStatus: b.whatsappConnectionStatus, wouldDisconnect: !NOT_LIVE.includes(b.whatsappConnectionStatus) })),
      currentlyLinkedBusinessIds: linkedBusinessIds,
      warnings,
      notAffected: "Customers, conversations, orders and payment records of every workspace are untouched. Only the named workspaces' WhatsApp connection and the Facebook identifier are removed.",
      publicStatusMessage: STATUS_MESSAGES[dto.outcome],
    };
  }

  /** Destructive for the named workspaces' WhatsApp connection only. All changes and the audit entry commit together or not at all. */
  async resolve(id: string, dto: ResolveMetaCallbackDto, actorUserId: string) {
    this.validateCombination(dto);
    const request = await this.loadDeletionRequest(id);
    if (dto.confirm !== `RESOLVE ${request.confirmationCode}`) throw new BadRequestException("Confirmation text does not match. Send exactly: RESOLVE <confirmationCode>.");
    if (request.status !== PENDING) return this.replayOrConflict(request, dto);

    const businessIds = dto.businessIds ?? [];
    if (businessIds.length) {
      // an unknown id and another tenant's id are indistinguishable here and nothing is written, so ids cannot be probed
      const found = await this.prisma.business.count({ where: { id: { in: businessIds } } });
      if (found !== businessIds.length) throw new NotFoundException("Business not found.");
    }

    let revoked: RevokedConnection[];
    try {
      revoked = await this.prisma.$transaction(async (tx) => {
        // the claim takes the row lock: of two simultaneous resolutions exactly one proceeds, the other sees it is no longer pending
        const claimed = await tx.metaCallbackRequest.updateMany({
          where: { id, status: PENDING },
          data: { resolvedByUserId: actorUserId, resolutionReference: dto.resolutionReference, verificationMethod: dto.verificationMethod },
        });
        if (claimed.count !== 1) throw new ConflictException("This request has already been resolved.");

        const userId = request.metaUserId;
        const links = userId ? await tx.metaUserLink.findMany({ where: { metaUserId: userId }, select: { businessId: true } }) : [];
        const linked = [...new Set(links.map((l) => l.businessId))];
        if (dto.outcome === "NO_DATA_HELD" && linked.length) throw new ConflictException("This Facebook account is now linked to a workspace, so it cannot be closed as no data held. Preview again.");
        if (dto.outcome === "COMPLETED" && linked.some((b) => !businessIds.includes(b))) throw new ConflictException("This Facebook account is also linked to workspaces you did not include. Preview again and include them.");

        const connections = await revokeConnections(tx, businessIds);
        if (userId) {
          await tx.metaUserLink.deleteMany({ where: { metaUserId: userId } });
          // the identifier is the data being deleted: every audit row that held it (this request's and any earlier one) stops holding it
          await tx.metaCallbackRequest.updateMany({ where: { metaUserId: userId }, data: { metaUserId: null } });
        }
        await tx.metaCallbackRequest.update({
          where: { id },
          data: { status: dto.outcome, matchedBusinessIds: businessIds, connectionsRevoked: connections.length, completedAt: new Date() },
        });
        await tx.metaCallbackEvent.create({
          data: {
            requestId: id, action: "RESOLVED", fromStatus: PENDING, toStatus: dto.outcome, actorUserId,
            detail: { businessIds, connectionsRevoked: connections.length, verificationMethod: dto.verificationMethod, resolutionReference: dto.resolutionReference },
          },
        });
        return connections;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      if (err instanceof ConflictException) {
        // a concurrent resolution may have used the very same reference — that is a retry, not a conflict
        const latest = await this.loadDeletionRequest(id);
        if (latest.status !== PENDING) return this.replayOrConflict(latest, dto);
      }
      if (err instanceof HttpException) throw err;
      this.logger.error(`Resolution of Meta request ${id} failed and was rolled back (${err instanceof Error ? err.name : "UnknownError"})`);
      captureException(err, { requestId: id });
      throw new InternalServerErrorException("The resolution failed and was rolled back; nothing was changed. It is safe to retry with the same resolutionReference.");
    }

    this.logger.log(`Meta deletion request ${id} resolved as ${dto.outcome}: ${revoked.length} connection(s) revoked`);
    await unsubscribeRevoked(this.meta, this.logger, revoked);
    return this.result(await this.loadDeletionRequest(id), false);
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new NotFoundException("Request not found.");
  }

  private async loadDeletionRequest(id: string) {
    this.assertId(id);
    const request = await this.prisma.metaCallbackRequest.findUnique({ where: { id }, select: REQUEST_SELECT });
    // a deauthorization record is a different event and is never resolved here
    if (!request || request.kind !== CALLBACK_KIND.DATA_DELETION || !request.confirmationCode) throw new NotFoundException("Request not found.");
    return request;
  }

  private validateCombination(dto: PreviewResolutionDto & { verificationMethod?: string }): void {
    const count = dto.businessIds?.length ?? 0;
    if (dto.outcome === "COMPLETED") {
      if (count < 1) throw new BadRequestException("COMPLETED requires the businessIds whose WhatsApp connection belongs to this Facebook account.");
      if (dto.verificationMethod === "RECORDS_SEARCH_NO_MATCH") throw new BadRequestException("RECORDS_SEARCH_NO_MATCH only applies to NO_DATA_HELD.");
    } else {
      if (count > 0) throw new BadRequestException("NO_DATA_HELD cannot name businesses; use COMPLETED if a workspace is linked to this Facebook account.");
      if (dto.verificationMethod && dto.verificationMethod !== "RECORDS_SEARCH_NO_MATCH") throw new BadRequestException("NO_DATA_HELD requires verificationMethod RECORDS_SEARCH_NO_MATCH.");
    }
  }

  /** Same outcome, reference, verification method and named businesses as the stored resolution: a retry, so answer as before. Anything else is a real conflict. */
  private replayOrConflict(request: RequestRow, dto: ResolveMetaCallbackDto) {
    const sameBusinesses = [...request.matchedBusinessIds].sort().join(",") === [...(dto.businessIds ?? [])].sort().join(",");
    const same = request.status === dto.outcome && request.resolutionReference === dto.resolutionReference && request.verificationMethod === dto.verificationMethod && sameBusinesses;
    if (same) return this.result(request, true);
    throw new ConflictException(`This request is already ${request.status}.`);
  }

  private result(request: RequestRow, alreadyResolved: boolean) {
    return {
      requestId: request.id,
      confirmationCode: request.confirmationCode,
      status: request.status,
      alreadyResolved,
      matchedBusinessIds: request.matchedBusinessIds,
      connectionsRevoked: request.connectionsRevoked,
      completedAt: request.completedAt,
      publicStatusMessage: STATUS_MESSAGES[request.status] ?? null,
    };
  }
}
