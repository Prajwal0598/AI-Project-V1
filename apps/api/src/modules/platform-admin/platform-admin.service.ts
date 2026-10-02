import { Injectable } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

// counts as "real" revenue the same way BusinessService.stats() does for a single business
const REVENUE_STATUSES = [OrderStatus.PAID, OrderStatus.FULFILLED];

@Injectable()
export class PlatformAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform-wide totals across every business — the founder's "how's Relay doing overall" snapshot. */
  async overview() {
    const [merchants, orders, revenueAgg, customers, paidSubscriptions] = await Promise.all([
      this.prisma.business.count(),
      this.prisma.order.count(),
      this.prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES } }, _sum: { total: true } }),
      this.prisma.customer.count(),
      this.prisma.subscription.findMany({ where: { status: "ACTIVE" }, select: { plan: { select: { amount: true } } } }),
    ]);
    // Relay's own recurring revenue — derived only from subscriptions actually ACTIVE right now, never projected/estimated
    const paidMRR = paidSubscriptions.reduce((sum, s) => sum + s.plan.amount, 0);
    return { merchants, orders, revenue: revenueAgg._sum.total ?? 0, customers, paidMRR };
  }

  /** Per-merchant breakdown — order count, revenue, basic onboarding status, and Relay's own billing state for that merchant, newest business first. */
  async businesses() {
    const businesses = await this.prisma.business.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, industry: true, createdAt: true, whatsappPhoneNumberId: true, instagramPageId: true },
    });

    const [orderCounts, revenueAggs, subscriptions, lastBillingEvents] = await Promise.all([
      this.prisma.order.groupBy({ by: ["businessId"], _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ["businessId"], where: { status: { in: REVENUE_STATUSES } }, _sum: { total: true } }),
      this.prisma.subscription.findMany({ include: { plan: { select: { code: true, name: true } } } }),
      this.prisma.billingEvent.findMany({ where: { businessId: { not: null } }, orderBy: { createdAt: "desc" }, distinct: ["businessId"], select: { businessId: true, eventType: true, createdAt: true } }),
    ]);
    const orderCountByBusiness = new Map(orderCounts.map((o) => [o.businessId, o._count._all]));
    const revenueByBusiness = new Map(revenueAggs.map((r) => [r.businessId, r._sum.total ?? 0]));
    const subscriptionByBusiness = new Map(subscriptions.map((s) => [s.businessId, s]));
    const lastBillingEventByBusiness = new Map(lastBillingEvents.map((e) => [e.businessId as string, e]));

    return businesses.map((b) => {
      const subscription = subscriptionByBusiness.get(b.id);
      const lastBillingEvent = lastBillingEventByBusiness.get(b.id);
      return {
        id: b.id,
        name: b.name,
        industry: b.industry,
        createdAt: b.createdAt,
        whatsappConnected: !!b.whatsappPhoneNumberId,
        instagramConnected: !!b.instagramPageId,
        orders: orderCountByBusiness.get(b.id) ?? 0,
        revenue: revenueByBusiness.get(b.id) ?? 0,
        billing: subscription ? {
          plan: subscription.plan.name,
          status: subscription.status,
          providerSubscriptionId: subscription.providerSubscriptionId,
          trialEnd: subscription.trialEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          lastBillingEvent: lastBillingEvent ? { type: lastBillingEvent.eventType, at: lastBillingEvent.createdAt } : null,
        } : null,
      };
    });
  }
}
