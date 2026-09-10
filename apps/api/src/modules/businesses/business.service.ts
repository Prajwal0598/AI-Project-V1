import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Business, OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { encryptSecret, isCredentialEncryptionConfigured } from "../../common/crypto.helper";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  // never return encrypted credential ciphertext to the client — only whether one is configured
  private sanitize(business: Business) {
    const { whatsappAccessTokenEncrypted, instagramAccessTokenEncrypted, postmarkServerTokenEncrypted, ...rest } = business;
    return {
      ...rest,
      whatsappAccessTokenConfigured: !!whatsappAccessTokenEncrypted,
      instagramAccessTokenConfigured: !!instagramAccessTokenEncrypted,
      postmarkServerTokenConfigured: !!postmarkServerTokenEncrypted,
    };
  }

  async findAll() {
    const businesses = await this.prisma.business.findMany({ orderBy: { createdAt: "desc" } });
    return businesses.map((b) => this.sanitize(b));
  }

  async get(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.sanitize(business);
  }

  async stats(businessId: string) {
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - now.getDay());
    startOfThisWeek.setHours(0, 0, 0, 0);
    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

    const [leads, customers, conversations, openConversations, orders, revenueAgg, revenueThisWeekAgg, revenueLastWeekAgg, recentPaidOrders] = await Promise.all([
      this.prisma.customer.count({ where: { businessId, type: "LEAD" } }),
      this.prisma.customer.count({ where: { businessId, type: "CUSTOMER" } }),
      this.prisma.conversation.count({ where: { businessId } }),
      this.prisma.conversation.count({ where: { businessId, status: "OPEN" } }),
      this.prisma.order.count({ where: { businessId } }),
      this.prisma.order.aggregate({
        where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] } },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] }, createdAt: { gte: startOfThisWeek } },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] }, createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
        _sum: { total: true },
      }),
      this.prisma.order.findMany({
        where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] }, createdAt: { gte: startOfLastWeek } },
        select: { createdAt: true, total: true },
      }),
    ]);

    // buckets each day (Mon-first, matching the chart's day labels) for the sales performance graph
    const thisWeekSeries = new Array(7).fill(0);
    const lastWeekSeries = new Array(7).fill(0);
    for (const order of recentPaidOrders) {
      const isThisWeek = order.createdAt >= startOfThisWeek;
      const weekStart = isThisWeek ? startOfThisWeek : startOfLastWeek;
      const sundayFirstIndex = Math.floor((order.createdAt.getTime() - weekStart.getTime()) / 86_400_000);
      if (sundayFirstIndex < 0 || sundayFirstIndex > 6) continue;
      const dayIndex = (sundayFirstIndex + 6) % 7; // remap Sunday-first bucket to Mon-first, matching the chart labels
      const bucket = isThisWeek ? thisWeekSeries : lastWeekSeries;
      bucket[dayIndex] += Number(order.total);
    }

    return {
      leads, customers, conversations, openConversations, orders,
      revenue: revenueAgg._sum.total ?? 0,
      revenueThisWeek: revenueThisWeekAgg._sum.total ?? 0,
      revenueLastWeek: revenueLastWeekAgg._sum.total ?? 0,
      revenueSeries: { thisWeek: thisWeekSeries, lastWeek: lastWeekSeries },
    };
  }

  async create(input: CreateBusinessDto) {
    return this.prisma.business.create({
      data: {
        name: input.name.trim(),
        industry: input.industry?.trim() || null,
        website: input.website?.trim() || null,
        timezone: input.timezone?.trim() || "Asia/Kolkata"
      }
    });
  }

  async update(businessId: string, input: UpdateBusinessDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    const settingCredential = input.whatsappAccessToken !== undefined || input.instagramAccessToken !== undefined || input.postmarkServerToken !== undefined;
    if (settingCredential && !isCredentialEncryptionConfigured()) {
      throw new BadRequestException("CREDENTIALS_ENCRYPTION_KEY is not configured on the server — per-business channel credentials are unavailable until it is set.");
    }

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.industry !== undefined && { industry: input.industry?.trim() || null }),
        ...(input.website !== undefined && { website: input.website?.trim() || null }),
        ...(input.timezone !== undefined && { timezone: input.timezone.trim() }),
        ...(input.whatsappPhoneNumberId !== undefined && { whatsappPhoneNumberId: input.whatsappPhoneNumberId?.trim() || null }),
        ...(input.instagramPageId !== undefined && { instagramPageId: input.instagramPageId?.trim() || null }),
        ...(input.supportEmail !== undefined && { supportEmail: input.supportEmail?.trim().toLowerCase() || null }),
        ...(input.autonomyMaxOrderValue !== undefined && { autonomyMaxOrderValue: input.autonomyMaxOrderValue }),
        ...(input.whatsappAccessToken !== undefined && { whatsappAccessTokenEncrypted: input.whatsappAccessToken.trim() ? encryptSecret(input.whatsappAccessToken.trim()) : null }),
        ...(input.instagramAccessToken !== undefined && { instagramAccessTokenEncrypted: input.instagramAccessToken.trim() ? encryptSecret(input.instagramAccessToken.trim()) : null }),
        ...(input.postmarkServerToken !== undefined && { postmarkServerTokenEncrypted: input.postmarkServerToken.trim() ? encryptSecret(input.postmarkServerToken.trim()) : null }),
      },
    });
    return this.sanitize(updated);
  }

  async activity(businessId: string, limit = 20) {
    return this.prisma.activityEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true } } },
    });
  }

  async aiActions(businessId: string, limit = 50) {
    return this.prisma.aiActionLog.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  /** conversations -> orders -> paid -> delivered, the core commerce funnel */
  async funnel(businessId: string) {
    const [conversations, conversationsWithOrder, ordersPaid, ordersDelivered] = await Promise.all([
      this.prisma.conversation.count({ where: { businessId } }),
      this.prisma.conversation.count({ where: { businessId, orders: { some: {} } } }),
      this.prisma.order.count({ where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] } } }),
      this.prisma.order.count({ where: { businessId, fulfillmentStatus: "DELIVERED" } }),
    ]);
    return { conversations, conversationsWithOrder, ordersPaid, ordersDelivered };
  }

  /** revenue split by the channel it came in through — WhatsApp/Instagram/Email */
  async revenueByChannel(businessId: string) {
    const orders = await this.prisma.order.findMany({
      where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] } },
      select: { total: true, conversation: { select: { channel: true } } },
    });
    const byChannel = new Map<string, number>();
    for (const order of orders) {
      const channel = order.conversation?.channel ?? "UNKNOWN";
      byChannel.set(channel, (byChannel.get(channel) ?? 0) + Number(order.total));
    }
    return Object.fromEntries(byChannel);
  }

  /** repeat-purchase rate and average order value across paying customers */
  async customerMetrics(businessId: string) {
    const paidOrders = await this.prisma.order.findMany({
      where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] } },
      select: { customerId: true, total: true },
    });
    if (paidOrders.length === 0) return { payingCustomers: 0, repeatPurchaseRate: 0, averageOrderValue: 0 };

    const ordersPerCustomer = new Map<string, number>();
    let totalRevenue = 0;
    for (const order of paidOrders) {
      ordersPerCustomer.set(order.customerId, (ordersPerCustomer.get(order.customerId) ?? 0) + 1);
      totalRevenue += Number(order.total);
    }
    const payingCustomers = ordersPerCustomer.size;
    const repeatCustomers = [...ordersPerCustomer.values()].filter((count) => count > 1).length;
    return {
      payingCustomers,
      repeatPurchaseRate: Math.round((repeatCustomers / payingCustomers) * 1000) / 10, // percentage, 1 decimal
      averageOrderValue: Math.round((totalRevenue / paidOrders.length) * 100) / 100,
    };
  }

  /** how conversations resolved — sale/support/escalated/lost/abandoned/still open */
  async conversationOutcomes(businessId: string) {
    const grouped = await this.prisma.conversation.groupBy({
      by: ["outcome"],
      where: { businessId },
      _count: { _all: true },
    });
    return Object.fromEntries(grouped.map((g) => [g.outcome, g._count._all]));
  }
}
