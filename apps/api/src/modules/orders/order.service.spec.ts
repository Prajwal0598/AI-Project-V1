import { BadRequestException, NotFoundException } from "@nestjs/common";
import { OrderStatus, FulfillmentStatus } from "@prisma/client";
import { OrderService } from "./order.service";
import type { PrismaService } from "../../database/prisma.service";
import type { QueueService } from "../../queue/queue.service";
import type { InventoryService } from "../inventory/inventory.service";
import type { OpportunityService } from "../opportunities/opportunity.service";
import type { ProductRelationService } from "../product-relations/product-relation.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { RazorpayService } from "../payments/razorpay.service";

describe("OrderService", () => {
  let prisma: any;
  let queues: { scheduleOrderProgress: jest.Mock; scheduleOrderExpiry: jest.Mock; scheduleFulfillmentKickoff: jest.Mock };
  let inventory: { notifyBackInStock: jest.Mock };
  let opportunities: { attachOrderOutcome: jest.Mock };
  let productRelations: Record<string, jest.Mock>;
  let conversations: { sendMessage: jest.Mock };
  let razorpay: { createPaymentLink: jest.Mock };
  let orders: OrderService;

  beforeEach(() => {
    prisma = {
      order: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0), $transaction: undefined },
      customer: { findFirst: jest.fn(), findUnique: jest.fn() },
      business: { findUnique: jest.fn() },
      activityEvent: { create: jest.fn() },
      conversation: { count: jest.fn().mockResolvedValue(0), update: jest.fn(), updateMany: jest.fn() },
      message: { findFirst: jest.fn().mockResolvedValue(null) },
      leadScore: { upsert: jest.fn() },
      $transaction: jest.fn(async (cb: (tx: any) => unknown) => cb(prisma)),
    };
    queues = { scheduleOrderProgress: jest.fn(), scheduleOrderExpiry: jest.fn(), scheduleFulfillmentKickoff: jest.fn() };
    inventory = { notifyBackInStock: jest.fn() };
    opportunities = { attachOrderOutcome: jest.fn() };
    productRelations = { getRelationsFor: jest.fn() };
    conversations = { sendMessage: jest.fn() };
    razorpay = { createPaymentLink: jest.fn() };

    orders = new OrderService(
      prisma as unknown as PrismaService,
      queues as unknown as QueueService,
      inventory as unknown as InventoryService,
      opportunities as unknown as OpportunityService,
      productRelations as unknown as ProductRelationService,
      conversations as unknown as ConversationService,
      razorpay as unknown as RazorpayService,
    );
  });

  describe("status-transition guards", () => {
    it("updateStatus() rejects an order that's already CANCELLED or REFUNDED", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.CANCELLED, items: [] });
      await expect(orders.updateStatus("o1", "biz1", { status: OrderStatus.PAID })).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("approve() rejects an order that isn't AWAITING_APPROVAL", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.PENDING_PAYMENT });
      await expect(orders.approve("o1", "biz1")).rejects.toThrow("Order is pending_payment and is not awaiting approval.");
    });

    it("approve() throws NotFoundException for a missing order", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await expect(orders.approve("missing", "biz1")).rejects.toThrow(NotFoundException);
    });

    it("updateFulfillmentStatus() rejects an order that isn't PAID or FULFILLED yet", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.PENDING_PAYMENT });
      await expect(orders.updateFulfillmentStatus("o1", "biz1", FulfillmentStatus.PACKED)).rejects.toThrow(
        "Fulfillment can only be tracked once the order is paid.",
      );
    });

    it("replaceItems() rejects an order that's no longer amendable", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.PAID, items: [] });
      await expect(orders.replaceItems("o1", "biz1", [{ name: "x", quantity: 1, unitPrice: 10 }])).rejects.toThrow(
        "Order is paid and can no longer be changed.",
      );
    });

    it("replaceItems() rejects an empty items list", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.PENDING_PAYMENT, items: [] });
      await expect(orders.replaceItems("o1", "biz1", [])).rejects.toThrow("At least one item is required.");
    });
  });

  describe("create() — Razorpay payment link fallback", () => {
    const baseCustomer = { id: "cust1", firstName: "Test", lastName: null, phone: "+911234567890" };
    const baseBusiness = { id: "biz1", name: "Test Biz", autonomyMaxOrderValue: null };
    const createdOrder = {
      id: "order1", businessId: "biz1", customerId: "cust1", status: OrderStatus.PENDING_PAYMENT,
      total: 2299, currency: "INR", paymentMethod: "UPI", razorpayPaymentLinkId: null, items: [],
    };

    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue(baseCustomer);
      prisma.customer.findUnique.mockResolvedValue(baseCustomer);
      prisma.business.findUnique.mockResolvedValue(baseBusiness);
      prisma.order.update = jest.fn();
      // stub the transaction's order.create call
      prisma.order.create = jest.fn().mockResolvedValue(createdOrder);
    });

    it("uses the simulated payment timer when Razorpay isn't configured for this business", async () => {
      razorpay.createPaymentLink.mockResolvedValue(null);

      const result = await orders.create("biz1", {
        customerId: "cust1", subtotal: 2299, currency: "INR", paymentMethod: "UPI", items: [],
      } as any);

      expect(razorpay.createPaymentLink).toHaveBeenCalled();
      expect(queues.scheduleOrderProgress).toHaveBeenCalledWith("order1", "biz1");
      expect(queues.scheduleOrderExpiry).toHaveBeenCalledWith("order1", "biz1", OrderStatus.PENDING_PAYMENT);
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(result.razorpayPaymentLinkId).toBeNull();
    });

    it("skips the simulated payment timer and attaches the real link when Razorpay IS configured", async () => {
      razorpay.createPaymentLink.mockResolvedValue({ id: "plink_1", shortUrl: "https://rzp.io/1" });
      prisma.order.update.mockResolvedValue({ ...createdOrder, razorpayPaymentLinkId: "plink_1", razorpayPaymentLinkUrl: "https://rzp.io/1" });

      const result = await orders.create("biz1", {
        customerId: "cust1", subtotal: 2299, currency: "INR", paymentMethod: "UPI", items: [],
      } as any);

      expect(queues.scheduleOrderProgress).not.toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "order1" },
        data: { razorpayPaymentLinkId: "plink_1", razorpayPaymentLinkUrl: "https://rzp.io/1" },
      }));
      // expiry safety net still applies even with a real payment link, in case the customer never pays
      expect(queues.scheduleOrderExpiry).toHaveBeenCalledWith("order1", "biz1", OrderStatus.PENDING_PAYMENT);
      expect(result.razorpayPaymentLinkId).toBe("plink_1");
    });
  });

  describe("markPaidViaRazorpay()", () => {
    it("is a no-op if the order doesn't exist", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      const result = await orders.markPaidViaRazorpay("missing", "biz1", "pay_1");
      expect(result).toEqual({ skipped: "order not found" });
    });

    it("is a no-op (idempotent) if the order is no longer PENDING_PAYMENT", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "o1", status: OrderStatus.PAID });
      const result = await orders.markPaidViaRazorpay("o1", "biz1", "pay_1");
      expect(result).toEqual({ skipped: "order is already paid" });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("marks the order PAID, notifies the customer, and kicks off fulfillment", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "o1", status: OrderStatus.PENDING_PAYMENT, customerId: "cust1", conversationId: "conv1", currency: "INR", total: 2299,
      });
      prisma.order.update = jest.fn().mockResolvedValue({ id: "o1", status: OrderStatus.PAID, currency: "INR", total: 2299 });

      const result = await orders.markPaidViaRazorpay("o1", "biz1", "pay_1");

      expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { status: OrderStatus.PAID, razorpayPaymentId: "pay_1" } });
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Payment received"));
      expect(queues.scheduleFulfillmentKickoff).toHaveBeenCalledWith("o1", "biz1");
      expect("updated" in result).toBe(true);
    });
  });
});
