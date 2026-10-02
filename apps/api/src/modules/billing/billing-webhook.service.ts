import { Injectable, Logger } from "@nestjs/common";
import { Prisma, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

export interface RazorpayBillingWebhookPayload {
  event: string;
  payload?: {
    subscription?: { entity?: { id?: string; customer_id?: string; current_start?: number; current_end?: number } };
  };
}

// real Razorpay Subscriptions webhook events (https://razorpay.com/docs/webhooks/payloads/subscriptions/) —
// never invented. Events not listed here (e.g. subscription.updated, .paused, .resumed — V1 never pauses a
// subscription) are logged and marked processed, but don't change Relay's internal status.
const STATUS_BY_EVENT: Partial<Record<string, SubscriptionStatus>> = {
  "subscription.activated": SubscriptionStatus.ACTIVE,
  "subscription.charged": SubscriptionStatus.ACTIVE,
  "subscription.pending": SubscriptionStatus.PAYMENT_FAILED, // card charge failed, Razorpay is retrying
  "subscription.halted": SubscriptionStatus.PAST_DUE, // all retries exhausted
  "subscription.cancelled": SubscriptionStatus.CANCELLED,
  "subscription.completed": SubscriptionStatus.EXPIRED, // ran out of billing cycles (not expected in practice — see INDEFINITE_MONTHLY_TOTAL_COUNT)
};

function toDate(unixSeconds: number | undefined): Date | undefined {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000) : undefined;
}

@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: a duplicate providerEventId is a no-op (unique constraint), never a second state transition. */
  async ingest(providerEventId: string, body: RazorpayBillingWebhookPayload): Promise<void> {
    const entity = body.payload?.subscription?.entity;
    const providerSubscriptionId = entity?.id;
    // resolve the business strictly from our own DB's provider id, never from anything the request claims about itself
    const subscription = providerSubscriptionId
      ? await this.prisma.subscription.findUnique({ where: { providerSubscriptionId } })
      : null;

    try {
      await this.prisma.billingEvent.create({
        data: { providerEventId, businessId: subscription?.businessId ?? null, eventType: body.event, payload: body as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        this.logger.log(`Ignoring duplicate Razorpay billing webhook delivery: ${providerEventId}`);
        return;
      }
      throw error;
    }

    if (!subscription) {
      this.logger.warn(`Razorpay billing webhook "${body.event}" references unknown subscription ${providerSubscriptionId ?? "(none)"} — ignoring.`);
      await this.markProcessed(providerEventId);
      return;
    }

    const newStatus = STATUS_BY_EVENT[body.event];
    if (newStatus) {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: newStatus,
          ...(entity?.customer_id ? { providerCustomerId: entity.customer_id } : {}),
          ...(toDate(entity?.current_start) ? { currentPeriodStart: toDate(entity?.current_start) } : {}),
          ...(toDate(entity?.current_end) ? { currentPeriodEnd: toDate(entity?.current_end) } : {}),
          ...(newStatus === SubscriptionStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
        },
      });
    } else {
      this.logger.log(`Razorpay billing webhook "${body.event}" for business ${subscription.businessId} — logged, no status change.`);
    }

    await this.markProcessed(providerEventId);
  }

  private async markProcessed(providerEventId: string): Promise<void> {
    await this.prisma.billingEvent.update({ where: { providerEventId }, data: { processedAt: new Date() } });
  }
}
