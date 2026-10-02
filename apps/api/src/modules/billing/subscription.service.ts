import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { RazorpayBillingProvider } from "./razorpay-billing.provider";

// Relay's own default plan — centrally defined here (never scattered as hard-coded amounts across call sites),
// overridable via env for a different default trial length without a code change
const DEFAULT_PLAN_CODE = process.env.RELAY_DEFAULT_PLAN_CODE?.trim() || "RELAY_PRO";
const DEFAULT_PLAN_NAME = "Relay Pro";
const DEFAULT_PLAN_AMOUNT = 299900; // paise — ₹2,999.00
const DEFAULT_PLAN_CURRENCY = "INR";
const DEFAULT_PLAN_INTERVAL = "monthly";
const DEFAULT_TRIAL_DAYS = Number(process.env.RELAY_TRIAL_DAYS ?? 7);

// subscription states where an existing Razorpay subscription is still "live" — checkout must never create a
// second overlapping one while any of these holds, per spec: "Do not create overlapping trials"
const LIVE_STATUSES: SubscriptionStatus[] = [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.PAST_DUE];

@Injectable()
export class SubscriptionService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayBillingProvider,
  ) {}

  /** Idempotent — upserts the single V1 plan on every boot so a fresh environment never needs a manual seed step. */
  async onModuleInit() {
    await this.prisma.subscriptionPlan.upsert({
      where: { code: DEFAULT_PLAN_CODE },
      create: { code: DEFAULT_PLAN_CODE, name: DEFAULT_PLAN_NAME, amount: DEFAULT_PLAN_AMOUNT, currency: DEFAULT_PLAN_CURRENCY, billingInterval: DEFAULT_PLAN_INTERVAL, trialDays: DEFAULT_TRIAL_DAYS },
      update: {}, // never overwrite an operator's manual price/trial edits on restart
    });
  }

  async getPlans() {
    return this.prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  }

  async getSubscription(businessId: string) {
    return this.prisma.subscription.findUnique({ where: { businessId }, include: { plan: true } });
  }

  private async ensureRazorpayPlanId(planId: string): Promise<string> {
    const plan = await this.prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: planId } });
    if (plan.razorpayPlanId) return plan.razorpayPlanId;
    const razorpayPlanId = await this.razorpay.createPlan({ name: plan.name, amount: plan.amount, currency: plan.currency, billingInterval: plan.billingInterval });
    await this.prisma.subscriptionPlan.update({ where: { id: plan.id }, data: { razorpayPlanId } });
    return razorpayPlanId;
  }

  /** Starts (or safely re-opens) checkout for this business's subscription — never creates a second live
   * Razorpay subscription while one already exists. Returns what the frontend needs to open Razorpay Checkout;
   * never marks anything ACTIVE itself — only the webhook does that. */
  async checkout(businessId: string) {
    const existing = await this.prisma.subscription.findUnique({ where: { businessId } });
    if (existing && LIVE_STATUSES.includes(existing.status) && existing.providerSubscriptionId) {
      return { subscriptionId: existing.providerSubscriptionId, razorpayKeyId: this.razorpay.getPublicKeyId() };
    }

    const plan = await this.prisma.subscriptionPlan.findFirst({ where: { code: DEFAULT_PLAN_CODE, isActive: true } });
    if (!plan) throw new NotFoundException("No active subscription plan is configured.");
    const razorpayPlanId = await this.ensureRazorpayPlanId(plan.id);

    const now = new Date();
    const trialEnd = plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000) : null;
    const subscription = await this.razorpay.createSubscription({ razorpayPlanId, businessId, startAt: trialEnd ?? undefined });

    await this.prisma.subscription.upsert({
      where: { businessId },
      create: {
        businessId, planId: plan.id, providerSubscriptionId: subscription.id,
        status: trialEnd ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
        trialStart: trialEnd ? now : null, trialEnd, currentPeriodEnd: trialEnd,
      },
      update: {
        planId: plan.id, providerSubscriptionId: subscription.id,
        status: trialEnd ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
        trialStart: trialEnd ? now : null, trialEnd, currentPeriodEnd: trialEnd,
        cancelAtPeriodEnd: false, cancelledAt: null,
      },
    });

    return { subscriptionId: subscription.id, razorpayKeyId: this.razorpay.getPublicKeyId() };
  }

  /** Cancel-at-period-end (V1 default): flips a flag only — the merchant keeps access through currentPeriodEnd.
   * The actual Razorpay cancel call happens later, via the billing sweep, once that period genuinely ends —
   * which is also what makes resume() below possible with zero Razorpay-side calls to undo. */
  async cancel(businessId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { businessId } });
    if (!subscription) throw new NotFoundException("No subscription found for this business.");
    if (!LIVE_STATUSES.includes(subscription.status)) throw new BadRequestException(`Subscription is ${subscription.status.toLowerCase()} and cannot be cancelled.`);
    if (subscription.cancelAtPeriodEnd) throw new ConflictException("Cancellation is already scheduled.");
    return this.prisma.subscription.update({ where: { businessId }, data: { cancelAtPeriodEnd: true }, include: { plan: true } });
  }

  async resume(businessId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { businessId } });
    if (!subscription) throw new NotFoundException("No subscription found for this business.");
    if (!subscription.cancelAtPeriodEnd) throw new BadRequestException("This subscription isn't scheduled for cancellation.");
    if (subscription.currentPeriodEnd && subscription.currentPeriodEnd <= new Date()) throw new BadRequestException("This subscription's final period has already ended and cannot be resumed.");
    return this.prisma.subscription.update({ where: { businessId }, data: { cancelAtPeriodEnd: false }, include: { plan: true } });
  }

  /** Billing history derived straight from the BillingEvent ledger — no separate audit table. */
  async history(businessId: string, page = 1, pageSize = 20) {
    const where = { businessId, eventType: { in: ["subscription.charged", "subscription.activated"] } };
    const [items, total] = await Promise.all([
      this.prisma.billingEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.billingEvent.count({ where }),
    ]);
    return {
      items: items.map((event) => {
        const payment = (event.payload as { payload?: { payment?: { entity?: { amount?: number; currency?: string; status?: string } } } })?.payload?.payment?.entity;
        return { id: event.id, eventType: event.eventType, amount: payment?.amount ?? null, currency: payment?.currency ?? null, paymentStatus: payment?.status ?? null, createdAt: event.createdAt };
      }),
      total, page, pageSize,
    };
  }
}
