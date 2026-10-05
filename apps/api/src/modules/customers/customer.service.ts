import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { CustomerSignalType, CustomerType, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { BusinessService } from "../businesses/business.service";
import { ConversationService } from "../conversations/conversation.service";
import { OrderService } from "../orders/order.service";
import { OpportunityService } from "../opportunities/opportunity.service";
import { CustomerSignalService } from "../customer-signals/customer-signal.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CreateIdentityDto } from "./dto/create-identity.dto";

// order statuses that count as a real, placed order (DRAFT is an internal precursor, never customer-visible)
const PLACED_STATUSES: OrderStatus[] = [OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.FULFILLED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];
// only actually-paid revenue counts toward lifetime value / average order value — mirrors BusinessService.customerMetrics()
const PAID_STATUSES: OrderStatus[] = [OrderStatus.PAID, OrderStatus.FULFILLED];
// no interaction in this many days -> the customer is surfaced as "Inactive" in the profile header
const ACTIVE_WINDOW_DAYS = 30;

interface OrderAggRow { customerId: string; status: OrderStatus; _sum: { total: Prisma.Decimal | null }; _count: { _all: number }; _max: { createdAt: Date | null } }

function buildOrderSummary(rows: OrderAggRow[]) {
  let totalOrders = 0, totalSpent = 0, paidCount = 0;
  let lastOrderAt: Date | null = null;
  for (const row of rows) {
    if (PLACED_STATUSES.includes(row.status)) {
      totalOrders += row._count._all;
      if (row._max.createdAt && (!lastOrderAt || row._max.createdAt > lastOrderAt)) lastOrderAt = row._max.createdAt;
    }
    if (PAID_STATUSES.includes(row.status)) {
      totalSpent += Number(row._sum.total ?? 0);
      paidCount += row._count._all;
    }
  }
  return {
    totalOrders,
    totalSpent: Math.round(totalSpent * 100) / 100,
    averageOrderValue: paidCount > 0 ? Math.round((totalSpent / paidCount) * 100) / 100 : 0,
    lastOrderAt,
  };
}

function primaryChannelOf(identities: { channel: string; isPrimary: boolean }[]): string | null {
  return identities.find((i) => i.isPrimary)?.channel ?? identities[0]?.channel ?? null;
}

function isActive(lastActivityAt: Date | null): boolean {
  if (!lastActivityAt) return false;
  return Date.now() - lastActivityAt.getTime() <= ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly business: BusinessService,
    private readonly conversations: ConversationService,
    private readonly orders: OrderService,
    private readonly opportunities: OpportunityService,
    private readonly customerSignals: CustomerSignalService,
  ) {}

  private async assertBusiness(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
  }

  private async assertCustomer(customerId: string, businessId: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    return customer;
  }

  async list(businessId: string, search?: string) {
    await this.assertBusiness(businessId);
    const term = search?.trim();
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(term ? { OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { id: term },
        { identities: { some: { identifier: { contains: term, mode: "insensitive" } } } }
      ] } : {})
    };
    const customers = await this.prisma.customer.findMany({
      where,
      include: { identities: true, leadScore: true, _count: { select: { conversations: true, orders: true } } },
      orderBy: [{ updatedAt: "desc" }]
    });
    if (customers.length === 0) return [];

    const ids = customers.map((c) => c.id);
    // two O(1) aggregate queries (not one per customer) so this list stays fast regardless of customer count
    const [orderRows, activityRows] = await Promise.all([
      this.prisma.order.groupBy({ by: ["customerId", "status"], where: { customerId: { in: ids } }, _sum: { total: true }, _count: { _all: true }, _max: { createdAt: true } }),
      this.prisma.activityEvent.groupBy({ by: ["customerId"], where: { customerId: { in: ids } }, _max: { createdAt: true } }),
    ]);
    const ordersByCustomer = new Map<string, OrderAggRow[]>();
    for (const row of orderRows) ordersByCustomer.set(row.customerId, [...(ordersByCustomer.get(row.customerId) ?? []), row as unknown as OrderAggRow]);
    const lastActivityByCustomer = new Map(activityRows.map((r) => [r.customerId, r._max.createdAt]));

    return customers.map((c) => {
      const summary = buildOrderSummary(ordersByCustomer.get(c.id) ?? []);
      const lastActivityAt = lastActivityByCustomer.get(c.id) ?? null;
      return {
        ...c,
        ...summary,
        lastActivityAt,
        primaryChannel: primaryChannelOf(c.identities),
        status: isActive(lastActivityAt) ? "ACTIVE" : "INACTIVE",
      };
    });
  }

  async create(businessId: string, input: CreateCustomerDto) {
    await this.assertBusiness(businessId);
    if (!input.firstName?.trim() && !input.email?.trim() && !input.phone?.trim()) {
      throw new BadRequestException("Provide at least a name, email, or phone number.");
    }
    return this.prisma.customer.create({
      data: {
        businessId,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        email: input.email?.trim().toLowerCase() || null,
        phone: input.phone?.trim() || null,
        type: input.type ?? CustomerType.LEAD,
        tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? []
      }
    });
  }

  /** Fast, deterministic Customer 360 profile — summary/insight/preferences only; conversations/orders/activity are separately paginated. */
  async get(customerId: string, businessId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
      include: { identities: true, leadScore: true },
    });
    if (!customer) throw new NotFoundException("Customer not found.");

    const [orderRows, latestOpportunity, recentSignals, recentActivity, budgetConversations, topProductRows, latestAddressOrder] = await Promise.all([
      this.prisma.order.groupBy({ by: ["status"], where: { customerId, businessId }, _sum: { total: true }, _count: { _all: true }, _max: { createdAt: true } }),
      this.opportunities.latestActiveForCustomer(businessId, customerId),
      this.customerSignals.recentForCustomer(businessId, customerId, 10),
      this.business.activity(businessId, 1, customerId),
      this.prisma.conversation.findMany({ where: { customerId, businessId, assistedBuyingContext: { not: Prisma.DbNull } }, select: { assistedBuyingContext: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 5 }),
      this.prisma.orderItem.groupBy({ by: ["productId", "name"], where: { productId: { not: null }, order: { customerId, businessId } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: "desc" } }, take: 5 }),
      // there's no standalone Customer.address field — the merchant-facing address is whatever they last
      // actually shipped an order to, taken verbatim from Order.shippingAddress, never a separately-typed field
      this.prisma.order.findFirst({ where: { customerId, businessId, shippingAddress: { not: Prisma.DbNull } }, orderBy: { createdAt: "desc" }, select: { shippingAddress: true } }),
    ]);

    const summary = buildOrderSummary(orderRows.map((r) => ({ ...r, customerId })) as OrderAggRow[]);
    const lastActivityAt = recentActivity[0]?.createdAt ?? null;
    const lastShippingAddress = (latestAddressOrder?.shippingAddress as { address?: string } | null)?.address ?? null;

    // customer-STATED budget: the latest maxPrice they actually typed, taken verbatim from persisted conversation context — never inferred
    let statedBudget: number | null = null;
    for (const conv of budgetConversations) {
      const maxPrice = (conv.assistedBuyingContext as { filters?: { maxPrice?: number } } | null)?.filters?.maxPrice;
      if (typeof maxPrice === "number") { statedBudget = maxPrice; break; }
    }

    const insight = this.buildInsight(latestOpportunity, recentSignals, customer.leadScore);

    return {
      ...customer,
      summary: { ...summary, lastActivityAt },
      firstInteractionAt: customer.createdAt,
      lastInteractionAt: lastActivityAt ?? customer.updatedAt,
      primaryChannel: primaryChannelOf(customer.identities),
      status: isActive(lastActivityAt) ? "ACTIVE" : "INACTIVE",
      lastShippingAddress,
      insight,
      preferences: {
        statedBudget,
        frequentlyPurchased: topProductRows.map((r) => ({ productId: r.productId, name: r.name, quantity: r._sum.quantity ?? 0 })),
        recentlyViewed: recentSignals
          .filter((s) => s.type === CustomerSignalType.PRODUCT_VIEWED && s.product)
          .map((s) => ({ productId: s.product!.id, name: s.product!.name, category: s.product!.category?.name ?? null, viewedAt: s.createdAt }))
          .filter((v, i, arr) => arr.findIndex((x) => x.productId === v.productId) === i)
          .slice(0, 5),
      },
    };
  }

  /** Deterministic, no new LLM call: prefers an active Opportunity+Suggestion, falls back to raw signals, then lead score — never invents an insight. */
  private buildInsight(
    opportunity: Awaited<ReturnType<OpportunityService["latestActiveForCustomer"]>>,
    signals: Awaited<ReturnType<CustomerSignalService["recentForCustomer"]>>,
    leadScore: { score: number; reason: string | null } | null,
  ) {
    if (opportunity) {
      return {
        source: "OPPORTUNITY" as const,
        type: opportunity.type,
        priority: opportunity.priority,
        reason: opportunity.reason,
        suggestedAction: opportunity.suggestion?.editedMessage ?? opportunity.suggestion?.message ?? null,
        timestamp: opportunity.createdAt,
        opportunityId: opportunity.id,
      };
    }
    const latestSignal = signals[0];
    if (latestSignal) {
      const productName = (latestSignal as { product?: { name: string } | null }).product?.name;
      return {
        source: "SIGNAL" as const,
        type: latestSignal.type,
        priority: null,
        reason: productName ? `${latestSignal.type === "PRODUCT_ENQUIRY" ? "Asked about" : "Viewed"} ${productName}` : "Recent product interest",
        suggestedAction: null,
        timestamp: latestSignal.createdAt,
        opportunityId: null,
      };
    }
    if (leadScore?.reason) {
      return {
        source: "LEAD_SCORE" as const,
        type: null,
        priority: null,
        reason: leadScore.reason,
        suggestedAction: null,
        timestamp: null,
        opportunityId: null,
      };
    }
    return null;
  }

  async getOrders(customerId: string, businessId: string, page = 1, pageSize = 20) {
    await this.assertCustomer(customerId, businessId);
    return this.orders.listForCustomer(customerId, businessId, page, pageSize);
  }

  async getConversations(customerId: string, businessId: string, page = 1, pageSize = 20) {
    await this.assertCustomer(customerId, businessId);
    return this.conversations.listForCustomer(customerId, businessId, page, pageSize);
  }

  /** Merges ActivityEvent (conversation/order lifecycle) with CustomerSignal (product interest) into one chronological timeline — nothing invented, both sources capped to keep this fast. */
  async getActivity(customerId: string, businessId: string, page = 1, pageSize = 20) {
    await this.assertCustomer(customerId, businessId);
    const [events, signals] = await Promise.all([
      this.business.activity(businessId, 100, customerId),
      this.customerSignals.recentForCustomer(businessId, customerId, 100),
    ]);
    const merged = [
      ...events.map((e) => ({ id: e.id, kind: "EVENT" as const, type: e.type as string, summary: e.summary, createdAt: e.createdAt })),
      ...signals.map((s) => ({
        id: s.id, kind: "SIGNAL" as const, type: s.type as string,
        summary: s.product ? `${s.type === "PRODUCT_ENQUIRY" ? "Asked about" : s.type === "BACK_IN_STOCK_WANTED" ? "Wants a restock alert for" : "Viewed"} ${s.product.name}` : s.type.replace(/_/g, " ").toLowerCase(),
        createdAt: s.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = merged.length;
    const items = merged.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    return { items, total, page, pageSize };
  }

  async update(customerId: string, businessId: string, input: { proactiveMessagingOptOut?: boolean }) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    return this.prisma.customer.update({
      where: { id: customerId },
      data: { ...(input.proactiveMessagingOptOut !== undefined && { proactiveMessagingOptOut: input.proactiveMessagingOptOut }) },
    });
  }

  async addIdentity(customerId: string, businessId: string, input: CreateIdentityDto) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    try {
      return await this.prisma.identity.create({
        data: { customerId, businessId: customer.businessId, channel: input.channel, identifier: input.identifier.trim(), displayName: input.displayName?.trim() || null, isPrimary: Boolean(input.isPrimary) }
      });
    } catch (error) {
      // P2002 = unique violation on (businessId, channel, identifier)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("This channel identity already belongs to a customer.");
      throw error;
    }
  }
}

