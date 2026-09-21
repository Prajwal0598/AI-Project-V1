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
    const [merchants, orders, revenueAgg, customers] = await Promise.all([
      this.prisma.business.count(),
      this.prisma.order.count(),
      this.prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES } }, _sum: { total: true } }),
      this.prisma.customer.count(),
    ]);
    return { merchants, orders, revenue: revenueAgg._sum.total ?? 0, customers };
  }

  /** Per-merchant breakdown — order count, revenue, and basic onboarding status, newest business first. */
  async businesses() {
    const businesses = await this.prisma.business.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, industry: true, createdAt: true, whatsappPhoneNumberId: true, instagramPageId: true },
    });

    const [orderCounts, revenueAggs] = await Promise.all([
      this.prisma.order.groupBy({ by: ["businessId"], _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ["businessId"], where: { status: { in: REVENUE_STATUSES } }, _sum: { total: true } }),
    ]);
    const orderCountByBusiness = new Map(orderCounts.map((o) => [o.businessId, o._count._all]));
    const revenueByBusiness = new Map(revenueAggs.map((r) => [r.businessId, r._sum.total ?? 0]));

    return businesses.map((b) => ({
      id: b.id,
      name: b.name,
      industry: b.industry,
      createdAt: b.createdAt,
      whatsappConnected: !!b.whatsappPhoneNumberId,
      instagramConnected: !!b.instagramPageId,
      orders: orderCountByBusiness.get(b.id) ?? 0,
      revenue: revenueByBusiness.get(b.id) ?? 0,
    }));
  }
}
