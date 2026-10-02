import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SubscriptionService } from "./subscription.service";
import type { PrismaService } from "../../database/prisma.service";
import type { RazorpayBillingProvider } from "./razorpay-billing.provider";

describe("SubscriptionService", () => {
  let prisma: any;
  let razorpay: { createPlan: jest.Mock; createSubscription: jest.Mock; cancelSubscription: jest.Mock; getPublicKeyId: jest.Mock };
  let subscriptions: SubscriptionService;

  const plan = { id: "plan_row_1", code: "RELAY_PRO", name: "Relay Pro", amount: 299900, currency: "INR", billingInterval: "monthly", trialDays: 7, razorpayPlanId: "plan_rzp_1", isActive: true };

  beforeEach(() => {
    prisma = {
      subscriptionPlan: { upsert: jest.fn(), findFirst: jest.fn().mockResolvedValue(plan), findUniqueOrThrow: jest.fn().mockResolvedValue(plan), update: jest.fn(), findMany: jest.fn().mockResolvedValue([plan]) },
      subscription: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      billingEvent: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    razorpay = {
      createPlan: jest.fn().mockResolvedValue("plan_rzp_1"),
      createSubscription: jest.fn().mockResolvedValue({ id: "sub_rzp_1", shortUrl: null }),
      cancelSubscription: jest.fn(),
      getPublicKeyId: jest.fn().mockReturnValue("rzp_test_key"),
    };
    subscriptions = new SubscriptionService(prisma as unknown as PrismaService, razorpay as unknown as RazorpayBillingProvider);
  });

  describe("onModuleInit", () => {
    it("idempotently upserts the default plan without overwriting an operator's manual edits", async () => {
      await subscriptions.onModuleInit();
      expect(prisma.subscriptionPlan.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { code: "RELAY_PRO" },
        update: {},
      }));
    });
  });

  describe("checkout", () => {
    it("creates a fresh Razorpay subscription with a trial start_at when none exists yet", async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      const result = await subscriptions.checkout("biz1");

      expect(razorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ razorpayPlanId: "plan_rzp_1", businessId: "biz1" }));
      expect(razorpay.createSubscription.mock.calls[0][0].startAt).toBeInstanceOf(Date);
      expect(prisma.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ status: "TRIAL", providerSubscriptionId: "sub_rzp_1" }),
      }));
      expect(result).toEqual({ subscriptionId: "sub_rzp_1", razorpayKeyId: "rzp_test_key" });
    });

    it("never creates a second overlapping subscription while one is already live", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ status: "TRIAL", providerSubscriptionId: "sub_existing" });

      const result = await subscriptions.checkout("biz1");

      expect(razorpay.createSubscription).not.toHaveBeenCalled();
      expect(result).toEqual({ subscriptionId: "sub_existing", razorpayKeyId: "rzp_test_key" });
    });

    it("lazily creates the Razorpay Plan only once, persisting razorpayPlanId", async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.subscriptionPlan.findFirst.mockResolvedValue({ ...plan, razorpayPlanId: null });
      prisma.subscriptionPlan.findUniqueOrThrow.mockResolvedValue({ ...plan, razorpayPlanId: null });

      await subscriptions.checkout("biz1");

      expect(razorpay.createPlan).toHaveBeenCalledWith({ name: "Relay Pro", amount: 299900, currency: "INR", billingInterval: "monthly" });
      expect(prisma.subscriptionPlan.update).toHaveBeenCalledWith({ where: { id: "plan_row_1" }, data: { razorpayPlanId: "plan_rzp_1" } });
    });

    it("allows checkout again once a previous subscription has fully ended (CANCELLED, no longer live)", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ status: "CANCELLED", providerSubscriptionId: "sub_old" });
      await subscriptions.checkout("biz1");
      expect(razorpay.createSubscription).toHaveBeenCalled();
    });
  });

  describe("cancel / resume", () => {
    it("cancel() sets cancelAtPeriodEnd without calling Razorpay directly", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ status: "ACTIVE", cancelAtPeriodEnd: false });
      await subscriptions.cancel("biz1");
      expect(prisma.subscription.update).toHaveBeenCalledWith({ where: { businessId: "biz1" }, data: { cancelAtPeriodEnd: true }, include: { plan: true } });
      expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    });

    it("cancel() rejects a subscription that isn't live", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ status: "EXPIRED", cancelAtPeriodEnd: false });
      await expect(subscriptions.cancel("biz1")).rejects.toThrow(BadRequestException);
    });

    it("cancel() rejects a cancellation that's already scheduled", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ status: "ACTIVE", cancelAtPeriodEnd: true });
      await expect(subscriptions.cancel("biz1")).rejects.toThrow(ConflictException);
    });

    it("cancel() throws NotFoundException when there's no subscription at all", async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      await expect(subscriptions.cancel("biz1")).rejects.toThrow(NotFoundException);
    });

    it("resume() clears cancelAtPeriodEnd before the period has ended", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 86400000) });
      await subscriptions.resume("biz1");
      expect(prisma.subscription.update).toHaveBeenCalledWith({ where: { businessId: "biz1" }, data: { cancelAtPeriodEnd: false }, include: { plan: true } });
    });

    it("resume() rejects once the final period has already ended", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 1000) });
      await expect(subscriptions.resume("biz1")).rejects.toThrow(BadRequestException);
    });

    it("resume() rejects when no cancellation was ever scheduled", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ cancelAtPeriodEnd: false, currentPeriodEnd: null });
      await expect(subscriptions.resume("biz1")).rejects.toThrow(BadRequestException);
    });
  });

  describe("history", () => {
    it("derives amount/currency/status from the raw webhook payload", async () => {
      prisma.billingEvent.findMany.mockResolvedValue([
        { id: "evt1", eventType: "subscription.charged", createdAt: new Date(), payload: { payload: { payment: { entity: { amount: 299900, currency: "INR", status: "captured" } } } } },
      ]);
      prisma.billingEvent.count.mockResolvedValue(1);

      const result = await subscriptions.history("biz1");
      expect(result.items[0]).toEqual(expect.objectContaining({ amount: 299900, currency: "INR", paymentStatus: "captured" }));
    });
  });
});
