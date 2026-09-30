import { NotFoundException } from "@nestjs/common";
import { CustomerSignalType, OpportunityPriority, OrderStatus } from "@prisma/client";
import { CustomerService } from "./customer.service";
import type { PrismaService } from "../../database/prisma.service";
import type { BusinessService } from "../businesses/business.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { OrderService } from "../orders/order.service";
import type { OpportunityService } from "../opportunities/opportunity.service";
import type { CustomerSignalService } from "../customer-signals/customer-signal.service";

describe("CustomerService", () => {
  let prisma: any;
  let business: { findUnique?: jest.Mock; activity: jest.Mock };
  let conversations: { listForCustomer: jest.Mock };
  let orders: { listForCustomer: jest.Mock };
  let opportunities: { latestActiveForCustomer: jest.Mock };
  let customerSignals: { recentForCustomer: jest.Mock };
  let customers: CustomerService;

  beforeEach(() => {
    prisma = {
      business: { findUnique: jest.fn().mockResolvedValue({ id: "biz1" }) },
      customer: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
      order: { groupBy: jest.fn().mockResolvedValue([]) },
      orderItem: { groupBy: jest.fn().mockResolvedValue([]) },
      activityEvent: { groupBy: jest.fn().mockResolvedValue([]) },
      conversation: { findMany: jest.fn().mockResolvedValue([]) },
      identity: { create: jest.fn() },
    };
    business = { activity: jest.fn().mockResolvedValue([]) };
    conversations = { listForCustomer: jest.fn() };
    orders = { listForCustomer: jest.fn() };
    opportunities = { latestActiveForCustomer: jest.fn().mockResolvedValue(null) };
    customerSignals = { recentForCustomer: jest.fn().mockResolvedValue([]) };

    customers = new CustomerService(
      prisma as unknown as PrismaService,
      business as unknown as BusinessService,
      conversations as unknown as ConversationService,
      orders as unknown as OrderService,
      opportunities as unknown as OpportunityService,
      customerSignals as unknown as CustomerSignalService,
    );
  });

  describe("list — aggregation and isolation", () => {
    it("computes totalOrders/totalSpent/averageOrderValue/lastOrderAt from a single groupBy, not per-customer queries", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { id: "c1", identities: [{ channel: "WHATSAPP", isPrimary: true }], leadScore: null, _count: { conversations: 1, orders: 2 } },
      ]);
      prisma.order.groupBy.mockResolvedValue([
        { customerId: "c1", status: OrderStatus.PAID, _sum: { total: 1000 }, _count: { _all: 1 }, _max: { createdAt: new Date("2026-09-01") } },
        { customerId: "c1", status: OrderStatus.FULFILLED, _sum: { total: 2000 }, _count: { _all: 1 }, _max: { createdAt: new Date("2026-09-15") } },
        { customerId: "c1", status: OrderStatus.CANCELLED, _sum: { total: 500 }, _count: { _all: 1 }, _max: { createdAt: new Date("2026-08-01") } },
      ]);
      prisma.activityEvent.groupBy.mockResolvedValue([{ customerId: "c1", _max: { createdAt: new Date() } }]);

      const [result] = await customers.list("biz1");

      expect(result.totalOrders).toBe(3); // PAID + FULFILLED + CANCELLED all count as "placed", DRAFT would not
      expect(result.totalSpent).toBe(3000); // only PAID + FULFILLED revenue
      expect(result.averageOrderValue).toBe(1500);
      expect(result.lastOrderAt).toEqual(new Date("2026-09-15"));
      expect(result.status).toBe("ACTIVE"); // recent ActivityEvent
      expect(result.primaryChannel).toBe("WHATSAPP");
      // exactly one groupBy call for orders and one for activity, regardless of customer count — proves no N+1
      expect(prisma.order.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.activityEvent.groupBy).toHaveBeenCalledTimes(1);
    });

    it("marks a customer with no recent activity as INACTIVE", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { id: "c1", identities: [], leadScore: null, _count: { conversations: 0, orders: 0 } },
      ]);
      prisma.activityEvent.groupBy.mockResolvedValue([{ customerId: "c1", _max: { createdAt: new Date("2020-01-01") } }]);

      const [result] = await customers.list("biz1");
      expect(result.status).toBe("INACTIVE");
      expect(result.primaryChannel).toBeNull();
    });

    it("returns an empty array without any aggregate queries when the business has no customers", async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      const result = await customers.list("biz1");
      expect(result).toEqual([]);
      expect(prisma.order.groupBy).not.toHaveBeenCalled();
    });
  });

  describe("get — profile, summary, insight (tenant-scoped)", () => {
    it("throws NotFoundException when the customer doesn't belong to this business", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(customers.get("c1", "biz1")).rejects.toThrow(NotFoundException);
    });

    it("prefers an active Opportunity+Suggestion as the AI insight over raw signals or lead score", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1", identities: [], leadScore: { score: 90, reason: "Frequent buyer" } });
      opportunities.latestActiveForCustomer.mockResolvedValue({
        id: "opp1", type: "HIGH_PURCHASE_INTENT", priority: OpportunityPriority.HIGH, reason: "Viewed 3 products, added 1 to cart",
        createdAt: new Date(), suggestion: { message: "Follow up with white shirts under ₹2,000", editedMessage: null },
      });
      customerSignals.recentForCustomer.mockResolvedValue([]);

      const result = await customers.get("c1", "biz1");
      expect(result.insight?.source).toBe("OPPORTUNITY");
      expect(result.insight?.suggestedAction).toBe("Follow up with white shirts under ₹2,000");
    });

    it("falls back to the most recent CustomerSignal when there is no active opportunity", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1", identities: [], leadScore: null });
      opportunities.latestActiveForCustomer.mockResolvedValue(null);
      customerSignals.recentForCustomer.mockResolvedValue([
        { id: "s1", type: CustomerSignalType.PRODUCT_ENQUIRY, createdAt: new Date(), product: { id: "p1", name: "White Classic Shirt", category: null } },
      ]);

      const result = await customers.get("c1", "biz1");
      expect(result.insight?.source).toBe("SIGNAL");
      expect(result.insight?.reason).toContain("White Classic Shirt");
    });

    it("falls back to the lead score reason when there is no opportunity or signal", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1", identities: [], leadScore: { score: 40, reason: "Browsed twice, no purchase yet" } });
      opportunities.latestActiveForCustomer.mockResolvedValue(null);
      customerSignals.recentForCustomer.mockResolvedValue([]);

      const result = await customers.get("c1", "biz1");
      expect(result.insight?.source).toBe("LEAD_SCORE");
      expect(result.insight?.reason).toBe("Browsed twice, no purchase yet");
    });

    it("never invents an insight — returns null when no signal exists at all", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1", identities: [], leadScore: null });
      opportunities.latestActiveForCustomer.mockResolvedValue(null);
      customerSignals.recentForCustomer.mockResolvedValue([]);

      const result = await customers.get("c1", "biz1");
      expect(result.insight).toBeNull();
    });

    it("surfaces the customer's own STATED budget verbatim from persisted conversation context, never inferred", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1", identities: [], leadScore: null });
      prisma.conversation.findMany.mockResolvedValue([{ assistedBuyingContext: { filters: { maxPrice: 3000 } }, updatedAt: new Date() }]);

      const result = await customers.get("c1", "biz1");
      expect(result.preferences.statedBudget).toBe(3000);
    });
  });

  describe("getOrders / getConversations / getActivity — tenant isolation", () => {
    it("getOrders throws NotFoundException for a customer belonging to another business", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(customers.getOrders("c1", "biz1")).rejects.toThrow(NotFoundException);
      expect(orders.listForCustomer).not.toHaveBeenCalled();
    });

    it("getConversations delegates to ConversationService only after confirming ownership", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1" });
      conversations.listForCustomer.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
      await customers.getConversations("c1", "biz1", 2, 10);
      expect(conversations.listForCustomer).toHaveBeenCalledWith("c1", "biz1", 2, 10);
    });

    it("getActivity throws NotFoundException for a customer belonging to another business", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(customers.getActivity("c1", "biz1")).rejects.toThrow(NotFoundException);
      expect(business.activity).not.toHaveBeenCalled();
    });

    it("getActivity merges ActivityEvent and CustomerSignal rows into one chronological, paginated timeline", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessId: "biz1" });
      business.activity.mockResolvedValue([{ id: "e1", type: "ORDER_PLACED", summary: "Order placed", createdAt: new Date("2026-09-01T10:00:00Z") }]);
      customerSignals.recentForCustomer.mockResolvedValue([
        { id: "s1", type: CustomerSignalType.PRODUCT_VIEWED, createdAt: new Date("2026-09-01T11:00:00Z"), product: { name: "Black Dress" } },
      ]);

      const result = await customers.getActivity("c1", "biz1", 1, 10);
      expect(result.total).toBe(2);
      expect(result.items[0].id).toBe("s1"); // the later signal sorts first
      expect(result.items[1].id).toBe("e1");
    });
  });
});
