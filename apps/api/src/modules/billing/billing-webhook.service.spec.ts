import { BillingWebhookService } from "./billing-webhook.service";
import type { PrismaService } from "../../database/prisma.service";

describe("BillingWebhookService.ingest", () => {
  let prisma: any;
  let webhook: BillingWebhookService;

  const subscriptionRow = { id: "sub_row_1", businessId: "biz1", providerSubscriptionId: "sub_rzp_1" };

  beforeEach(() => {
    prisma = {
      billingEvent: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
      subscription: { findUnique: jest.fn().mockResolvedValue(subscriptionRow), update: jest.fn().mockResolvedValue({}) },
    };
    webhook = new BillingWebhookService(prisma as unknown as PrismaService);
  });

  it("is idempotent — a duplicate providerEventId (unique constraint) is a safe no-op", async () => {
    const { Prisma } = jest.requireActual("@prisma/client");
    const duplicateError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    duplicateError.code = "P2002";
    prisma.billingEvent.create.mockRejectedValue(duplicateError);

    await webhook.ingest("evt_1", { event: "subscription.activated", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });

    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it("logs and skips gracefully when the webhook references a subscription we don't recognize", async () => {
    prisma.subscription.findUnique.mockResolvedValue(null);
    await webhook.ingest("evt_1", { event: "subscription.activated", payload: { subscription: { entity: { id: "sub_unknown" } } } });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.billingEvent.update).toHaveBeenCalledWith({ where: { providerEventId: "evt_1" }, data: { processedAt: expect.any(Date) } });
  });

  it("subscription.activated moves status to ACTIVE and syncs the current period", async () => {
    await webhook.ingest("evt_1", {
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "sub_rzp_1", customer_id: "cust_rzp_1", current_start: 1700000000, current_end: 1702592000 } } },
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: "sub_row_1" },
      data: {
        status: "ACTIVE",
        providerCustomerId: "cust_rzp_1",
        currentPeriodStart: new Date(1700000000 * 1000),
        currentPeriodEnd: new Date(1702592000 * 1000),
      },
    });
  });

  it("subscription.charged also moves status to ACTIVE (normal recurring renewal)", async () => {
    await webhook.ingest("evt_1", { event: "subscription.charged", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });
    expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE" }) }));
  });

  it("subscription.pending maps to PAYMENT_FAILED", async () => {
    await webhook.ingest("evt_1", { event: "subscription.pending", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });
    expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PAYMENT_FAILED" }) }));
  });

  it("subscription.halted maps to PAST_DUE", async () => {
    await webhook.ingest("evt_1", { event: "subscription.halted", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });
    expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PAST_DUE" }) }));
  });

  it("subscription.cancelled maps to CANCELLED and stamps cancelledAt", async () => {
    await webhook.ingest("evt_1", { event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });
    expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED", cancelledAt: expect.any(Date) }) }));
  });

  it("an unmapped event (e.g. subscription.updated) is logged and marked processed without changing status", async () => {
    await webhook.ingest("evt_1", { event: "subscription.updated", payload: { subscription: { entity: { id: "sub_rzp_1" } } } });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.billingEvent.update).toHaveBeenCalledWith({ where: { providerEventId: "evt_1" }, data: { processedAt: expect.any(Date) } });
  });
});
