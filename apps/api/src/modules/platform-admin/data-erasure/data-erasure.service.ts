import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { OrderStatus, Prisma } from "@prisma/client";
import type { DataErasureRequest } from "@prisma/client";
import { PrismaService } from "../../../database/prisma.service";
import { captureException } from "../../../common/error-reporting.helper";
import type { ExecuteErasureDto, PreviewErasureDto } from "./data-erasure.dto";

// the customer row is kept (orders must keep pointing at something) but holds no personal data afterwards
export const ERASED_CUSTOMER_LABEL = "Deleted customer";
// an IN_PROGRESS request this old was abandoned by a crashed process; a retry may take it over
export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;
const OPEN_ORDER_STATUSES: OrderStatus[] = [OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT, OrderStatus.PAID];
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

type Db = Prisma.TransactionClient;

export interface ErasureCounts {
  identities: number;
  conversations: number;
  messages: number;
  carts: number;
  cartItems: number;
  customerSignals: number;
  opportunities: number;
  suggestions: number;
  activityEvents: number;
  aiActionLogsScrubbed: number;
  leadScores: number;
  ordersRetained: number;
  deliveryAddressesRemoved: number;
  customerRecordsAnonymised: number;
}

interface ErasurePlan {
  counts: ErasureCounts;
  openOrders: number;
  conversationIds: string[];
}

/** What this process does NOT reach — returned with every preview/result so the operator can answer the requester honestly. */
export function externalProcessingNotes(): string[] {
  const backupDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
  return [
    `Database backups: copies of the erased data can remain in the daily database backups until each backup expires (${backupDays} days). Backups are not edited.`,
    "Background jobs: queued jobs hold record ids only and exit without sending anything once the record no longer exists.",
    "Meta (WhatsApp/Instagram): messages already delivered to the customer's device, the merchant's own WhatsApp account or Meta's systems are outside RelayShift's control.",
    "OpenAI: content already sent to OpenAI for replies or drafts is governed by OpenAI's own retention; RelayShift stores no separate copy of it.",
    "Postmark: email copies held by Postmark follow Postmark's retention settings.",
    "Razorpay: payment records are held by Razorpay. The matching RelayShift order rows are retained (see retainedRecords).",
    "Logs and error reports: held by Railway and Sentry under their own retention settings.",
  ];
}

function retainedRecords(ordersRetained: number) {
  return {
    orders: ordersRetained,
    reason: "Order, payment and total records are kept for tax, accounting and dispute purposes. Their delivery address is removed and they are linked only to an anonymised customer record.",
  };
}

/**
 * Production erasure of ONE customer's personal data inside ONE merchant's account. Platform-admin only (see the
 * controller). Everything it touches is filtered by businessId AND customerId, so a customer id that belongs to another
 * merchant matches nothing. The customer row is anonymised rather than deleted because Order -> Customer cascades: deleting
 * the row would delete the order and payment records that must be retained.
 */
@Injectable()
export class DataErasureService {
  private readonly logger = new Logger(DataErasureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Dry run: reports exactly what execute() would delete, scrub or retain. Writes nothing. */
  async preview(dto: PreviewErasureDto) {
    await this.requireCustomer(dto.businessId, dto.customerId);
    const { counts, openOrders } = await this.buildPlan(this.prisma, dto.businessId, dto.customerId);
    const priorRequests = await this.prisma.dataErasureRequest.findMany({
      where: { businessId: dto.businessId, customerId: dto.customerId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { requestReference: true, status: true, completedAt: true },
    });
    return {
      dryRun: true,
      businessId: dto.businessId,
      customerId: dto.customerId,
      confirmationRequired: `ERASE ${dto.customerId}`,
      counts,
      retainedRecords: retainedRecords(counts.ordersRetained),
      warnings: openOrders > 0
        ? [{ code: "OPEN_ORDERS", count: openOrders, message: "This customer has orders that are unpaid, awaiting approval or paid but not delivered. Erasing removes their delivery address; execute needs acknowledgeOpenOrders=true." }]
        : [],
      priorRequests,
      externalProcessing: externalProcessingNotes(),
    };
  }

  /** Destructive run. All database changes and the audit record commit together or not at all. */
  async execute(dto: ExecuteErasureDto, executedByUserId: string) {
    if (dto.confirm !== `ERASE ${dto.customerId}`) throw new BadRequestException("Confirmation text does not match. Send exactly: ERASE <customerId>.");
    await this.requireCustomer(dto.businessId, dto.customerId);

    const openOrders = await this.prisma.order.count({ where: { businessId: dto.businessId, customerId: dto.customerId, status: { in: OPEN_ORDER_STATUSES } } });
    if (openOrders > 0 && !dto.acknowledgeOpenOrders) {
      throw new ConflictException(`This customer has ${openOrders} open order(s). Erasing removes their delivery address. Re-send with acknowledgeOpenOrders=true once the merchant has been told.`);
    }

    const claim = await this.claim(dto, executedByUserId);
    if ("completed" in claim) return this.toResult(claim.completed, true);
    const requestId = claim.requestId;

    try {
      const counts = await this.prisma.$transaction(async (tx) => {
        const plan = await this.buildPlan(tx, dto.businessId, dto.customerId);
        const { businessId, customerId } = dto;
        const result: ErasureCounts = { ...plan.counts };

        // audit rows keep their action/result/order link but lose every link back to the person and any free-text reason
        const logScope: Prisma.AiActionLogWhereInput[] = [{ customerId }];
        if (plan.conversationIds.length) logScope.push({ conversationId: { in: plan.conversationIds } });
        result.aiActionLogsScrubbed = (await tx.aiActionLog.updateMany({ where: { businessId, OR: logScope }, data: { customerId: null, conversationId: null, reason: null } })).count;

        result.opportunities = (await tx.opportunity.deleteMany({ where: { businessId, customerId } })).count; // cascades suggestions and outcomes
        result.customerSignals = (await tx.customerSignal.deleteMany({ where: { businessId, customerId } })).count;
        result.activityEvents = (await tx.activityEvent.deleteMany({ where: { businessId, customerId } })).count; // summaries name the contact
        result.carts = (await tx.cart.deleteMany({ where: { businessId, customerId } })).count; // cascades cart items
        result.conversations = (await tx.conversation.deleteMany({ where: { businessId, customerId } })).count; // cascades messages; orders keep a null conversation
        result.identities = (await tx.identity.deleteMany({ where: { businessId, customerId } })).count;
        result.leadScores = (await tx.leadScore.deleteMany({ where: { customerId, customer: { businessId } } })).count;
        await tx.order.updateMany({ where: { businessId, customerId }, data: { shippingAddress: Prisma.DbNull } });

        const anonymised = await tx.customer.updateMany({
          where: { id: customerId, businessId },
          data: { firstName: ERASED_CUSTOMER_LABEL, lastName: null, email: null, phone: null, tags: [], proactiveMessagingOptOut: true },
        });
        if (anonymised.count !== 1) throw new NotFoundException("Customer not found for this business.");
        result.customerRecordsAnonymised = anonymised.count;

        await tx.dataErasureRequest.update({
          where: { id: requestId },
          data: { status: "COMPLETED", counts: result as unknown as Prisma.InputJsonValue, completedAt: new Date(), failureReason: null },
        });
        return result;
      }, TRANSACTION_OPTIONS);

      this.logger.log(`Erasure ${requestId} completed for business ${dto.businessId}, customer ${dto.customerId}`);
      return { requestId, status: "COMPLETED" as const, alreadyCompleted: false, counts, retainedRecords: retainedRecords(counts.ordersRetained), externalProcessing: externalProcessingNotes() };
    } catch (err) {
      await this.markFailed(requestId, err);
      this.logger.error(`Erasure ${requestId} failed and was rolled back (${err instanceof Error ? err.name : "UnknownError"})`);
      captureException(err, { requestId, businessId: dto.businessId, customerId: dto.customerId });
      throw new InternalServerErrorException("The erasure failed and was rolled back; no data was changed. It is safe to retry with the same requestReference.");
    }
  }

  private async requireCustomer(businessId: string, customerId: string): Promise<void> {
    // identical answer for "no such customer" and "customer of another merchant", so ids cannot be probed across tenants
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found for this business.");
  }

  /** The one definition of what an erasure touches; preview and execute both use it so they can never disagree. */
  private async buildPlan(db: Db, businessId: string, customerId: string): Promise<ErasurePlan> {
    const conversationIds = (await db.conversation.findMany({ where: { businessId, customerId }, select: { id: true } })).map((c) => c.id);
    const logScope: Prisma.AiActionLogWhereInput[] = [{ customerId }];
    if (conversationIds.length) logScope.push({ conversationId: { in: conversationIds } });

    const counts: ErasureCounts = {
      identities: await db.identity.count({ where: { businessId, customerId } }),
      conversations: conversationIds.length,
      messages: await db.message.count({ where: { conversation: { businessId, customerId } } }),
      carts: await db.cart.count({ where: { businessId, customerId } }),
      cartItems: await db.cartItem.count({ where: { cart: { businessId, customerId } } }),
      customerSignals: await db.customerSignal.count({ where: { businessId, customerId } }),
      opportunities: await db.opportunity.count({ where: { businessId, customerId } }),
      suggestions: await db.suggestion.count({ where: { opportunity: { businessId, customerId } } }),
      activityEvents: await db.activityEvent.count({ where: { businessId, customerId } }),
      aiActionLogsScrubbed: await db.aiActionLog.count({ where: { businessId, OR: logScope } }),
      leadScores: await db.leadScore.count({ where: { customerId, customer: { businessId } } }),
      ordersRetained: await db.order.count({ where: { businessId, customerId } }),
      deliveryAddressesRemoved: await db.order.count({ where: { businessId, customerId, shippingAddress: { not: Prisma.DbNull } } }),
      customerRecordsAnonymised: 1,
    };
    const openOrders = await db.order.count({ where: { businessId, customerId, status: { in: OPEN_ORDER_STATUSES } } });
    return { counts, openOrders, conversationIds };
  }

  /**
   * Idempotency: (businessId, customerId, requestReference) is unique. A COMPLETED request is returned as-is without touching
   * anything; a FAILED one (or an abandoned IN_PROGRESS one) can be retried; a live IN_PROGRESS one is refused.
   */
  private async claim(dto: ExecuteErasureDto, executedByUserId: string): Promise<{ requestId: string } | { completed: DataErasureRequest }> {
    const key = { businessId: dto.businessId, customerId: dto.customerId, requestReference: dto.requestReference };
    const existing = await this.prisma.dataErasureRequest.findUnique({ where: { businessId_customerId_requestReference: key } });

    if (existing?.status === "COMPLETED") return { completed: existing };

    if (existing) {
      const abandoned = existing.status === "IN_PROGRESS" && Date.now() - existing.updatedAt.getTime() > STALE_IN_PROGRESS_MS;
      if (existing.status === "IN_PROGRESS" && !abandoned) throw new ConflictException("This erasure request is already in progress.");
      // compare-and-swap on updatedAt: of two simultaneous retries exactly one takes the request over
      const taken = await this.prisma.dataErasureRequest.updateMany({
        where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
        data: { status: "IN_PROGRESS", executedByUserId, requestedBy: dto.requestedBy, verificationMethod: dto.verificationMethod, failureReason: null },
      });
      if (taken.count !== 1) throw new ConflictException("This erasure request is already in progress.");
      return { requestId: existing.id };
    }

    try {
      const created = await this.prisma.dataErasureRequest.create({
        data: { ...key, requestedBy: dto.requestedBy, verificationMethod: dto.verificationMethod, status: "IN_PROGRESS", executedByUserId },
      });
      return { requestId: created.id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ConflictException("This erasure request is already in progress.");
      throw err;
    }
  }

  private async markFailed(requestId: string, err: unknown): Promise<void> {
    try {
      await this.prisma.dataErasureRequest.updateMany({
        where: { id: requestId, status: "IN_PROGRESS" },
        data: { status: "FAILED", failureReason: err instanceof Error ? err.name : "UnknownError" }, // the error class only, never its message or any row data
      });
    } catch (markErr) {
      this.logger.error(`Could not mark erasure ${requestId} as failed (${markErr instanceof Error ? markErr.name : "UnknownError"})`);
    }
  }

  private toResult(request: DataErasureRequest, alreadyCompleted: boolean) {
    const counts = request.counts as unknown as ErasureCounts | null;
    return {
      requestId: request.id,
      status: request.status as "COMPLETED",
      alreadyCompleted,
      counts,
      retainedRecords: retainedRecords(counts?.ordersRetained ?? 0),
      externalProcessing: externalProcessingNotes(),
    };
  }
}
