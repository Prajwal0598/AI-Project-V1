import { createHmac } from "node:crypto";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { OrderStatus, Prisma } from "@prisma/client";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookService } from "./razorpay-webhook.service";
import { RazorpayService } from "../payments/razorpay.service";
import { OrderService } from "../orders/order.service";

// Signed Razorpay deliveries go through the REAL controller, signature check, webhook service and OrderService,
// against a stateful in-memory order table (every awaited call yields, so simultaneous deliveries interleave).

const BIZ = "biz1";
const SECRET = "whsec_test_secret";
const tick = () => Promise.resolve();

/**
 * A payment_link.paid payload shaped like Razorpay's documented one: amounts are integers in paise, the payment is the
 * captured payment and the link echoes our order id as reference_id. `o` overrides single fields; an explicit undefined drops it.
 */
const paid = (paymentId = "pay_1", linkId = "plink_1", o: Record<string, unknown> = {}): any => {
  const amount = "amount" in o ? o.amount : 229900; // order total is INR 2,299.00
  return {
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: linkId, reference_id: "reference" in o ? o.reference : "order1", amount: 229900, amount_paid: "linkPaid" in o ? o.linkPaid : amount, currency: "INR", status: "paid" } },
      payment: { entity: { id: paymentId, amount, currency: "currency" in o ? o.currency : "INR", status: "captured", order_id: "order_rzp_1" } },
    },
  };
};
const sign = (raw: Buffer) => createHmac("sha256", SECRET).update(raw).digest("hex");

function build(initial: Partial<{ status: OrderStatus; total: number }> = {}) {
  const order: Record<string, any> = { id: "order1", businessId: BIZ, customerId: "cust1", conversationId: "conv1", status: OrderStatus.PENDING_PAYMENT, razorpayPaymentLinkId: "plink_1", razorpayPaymentId: null, total: 2299, currency: "INR", ...initial };
  const effects = { activity: [] as string[], notifications: [] as string[], kickoffs: [] as string[], outcomes: [] as unknown[] };
  const hooks: { beforeUpdate?: () => void } = {};

  const prisma: any = {
    business: { findUnique: async ({ where }: any) => (where.id === BIZ ? { id: BIZ, razorpayWebhookSecretEncrypted: null } : null) },
    order: {
      findFirst: async ({ where }: any) => {
        await tick();
        const hit = where.businessId === order.businessId && (where.id === undefined || where.id === order.id) && (where.razorpayPaymentLinkId === undefined || where.razorpayPaymentLinkId === order.razorpayPaymentLinkId);
        return hit ? { ...order } : null;
      },
      // like the database: a conditional update that matches nothing raises P2025, and checking + writing is one step
      update: async ({ where, data }: any) => {
        await tick();
        hooks.beforeUpdate?.();
        const hit = where.id === order.id && (where.businessId === undefined || where.businessId === order.businessId) && (where.status === undefined || where.status === order.status) && (where.total === undefined || where.total === order.total);
        if (!hit) throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: "test" });
        Object.assign(order, data);
        return { ...order };
      },
    },
    activityEvent: { create: async ({ data }: any) => { effects.activity.push(data.summary); } },
    conversation: { update: async ({ data }: any) => { effects.outcomes.push(data.outcome); } },
  };
  const conversations = { sendMessage: async (_c: string, _b: string, body: string) => { effects.notifications.push(body); } };
  const queues = { scheduleFulfillmentKickoff: async (id: string) => { effects.kickoffs.push(id); } };

  const orders = new OrderService(prisma, queues as any, {} as any, {} as any, {} as any, conversations as any, {} as any);
  const razorpay = new RazorpayService();
  const webhook = new RazorpayWebhookService(prisma, razorpay, orders);
  const controller = new RazorpayWebhookController(prisma, razorpay, webhook);

  /** One delivery, signed exactly like Razorpay signs it (over the raw body). */
  const deliver = (body: unknown, opts: { signature?: string | null; businessId?: string } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const signature = opts.signature === undefined ? sign(raw) : opts.signature ?? undefined;
    return controller.receive(opts.businessId ?? BIZ, { rawBody: raw } as any, signature, body as any);
  };
  return { order, effects, deliver, webhook, hooks };
}

describe("Razorpay webhook — payment effects happen once, and only for a verified payment", () => {
  const ENV = { ...process.env };
  beforeEach(() => { process.env = { ...ENV, RAZORPAY_WEBHOOK_SECRET: SECRET }; delete process.env.CREDENTIALS_ENCRYPTION_KEY; });
  afterAll(() => { process.env = ENV; });

  describe("12. duplicate deliveries do not duplicate payment effects or confirmations", () => {
    it("a genuine payment marks the order PAID, records the payment id, confirms once and starts fulfilment once", async () => {
      const w = build();
      await w.deliver(paid());
      expect(w.order).toMatchObject({ status: OrderStatus.PAID, razorpayPaymentId: "pay_1" });
      expect(w.effects.notifications).toEqual([expect.stringContaining("Payment received")]);
      expect(w.effects.kickoffs).toEqual(["order1"]);
      expect(w.effects.activity).toHaveLength(1);
    });

    it("the same webhook delivered several times AT THE SAME TIME has its effects exactly once", async () => {
      const w = build();
      await Promise.all([1, 2, 3, 4, 5].map(() => w.deliver(paid())));
      expect(w.order.status).toBe(OrderStatus.PAID);
      expect(w.effects.notifications).toHaveLength(1);
      expect(w.effects.kickoffs).toHaveLength(1);
      expect(w.effects.activity).toHaveLength(1);
      expect(w.effects.outcomes).toEqual(["SALE"]);
    });

    it("a retry delivered later (Razorpay re-sends until it gets a 200) changes nothing", async () => {
      const w = build();
      await w.deliver(paid());
      await w.deliver(paid());
      await w.deliver(paid());
      expect(w.effects.notifications).toHaveLength(1);
      expect(w.effects.kickoffs).toHaveLength(1);
      expect(w.order.razorpayPaymentId).toBe("pay_1");
    });

    it("a second, different payment id for an order that is already paid never overwrites the recorded payment", async () => {
      const w = build();
      await w.deliver(paid("pay_1"));
      await w.deliver(paid("pay_2"));
      expect(w.order.razorpayPaymentId).toBe("pay_1");
      expect(w.effects.notifications).toHaveLength(1);
    });
  });

  describe("13. a payment that did not succeed never marks the order paid", () => {
    it.each(["payment.failed", "payment_link.expired", "payment_link.cancelled", "payment_link.partially_paid", "order.paid", "refund.processed"])(
      "'%s' leaves the order unpaid and silent",
      async (event) => {
        const w = build();
        await w.deliver({ event, payload: { payment_link: { entity: { id: "plink_1" } }, payment: { entity: { id: "pay_1", status: "failed" } } } });
        expect(w.order).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, razorpayPaymentId: null });
        expect(w.effects).toEqual({ activity: [], notifications: [], kickoffs: [], outcomes: [] });
      },
    );

    it("a 'paid' event without the payment id or the payment link id is ignored", async () => {
      const w = build();
      await w.deliver({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1" } } } });
      await w.deliver({ event: "payment_link.paid", payload: { payment: { entity: { id: "pay_1" } } } });
      await w.deliver({ event: "payment_link.paid" });
      expect(w.order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(w.effects.kickoffs).toEqual([]);
    });

    it("a payment link that matches no order (or another business's order) is ignored", async () => {
      const w = build();
      await w.deliver(paid("pay_1", "plink_unknown"));
      await w.webhook.ingest("biz-other", paid()); // same link id, different tenant
      expect(w.order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(w.effects.kickoffs).toEqual([]);
    });

    it.each([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.AWAITING_APPROVAL])("a payment arriving for an order that is %s does not resurrect it", async (status) => {
      const w = build({ status });
      await w.deliver(paid());
      expect(w.order.status).toBe(status);
      expect(w.order.razorpayPaymentId).toBeNull();
      expect(w.effects.notifications).toEqual([]);
      expect(w.effects.kickoffs).toEqual([]);
    });

    it("an unsigned or wrongly signed 'paid' event is rejected before anything is touched", async () => {
      const w = build();
      await expect(w.deliver(paid(), { signature: "0".repeat(64) })).rejects.toThrow(ForbiddenException);
      await expect(w.deliver(paid(), { signature: null })).rejects.toThrow(ForbiddenException);
      expect(w.order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(w.effects).toEqual({ activity: [], notifications: [], kickoffs: [], outcomes: [] });
    });

    it("a body altered after signing is rejected", async () => {
      const w = build();
      const body = paid("pay_1");
      const signature = sign(Buffer.from(JSON.stringify(body)));
      const tampered = paid("pay_FORGED");
      await expect(w.deliver(tampered, { signature })).rejects.toThrow(ForbiddenException);
      expect(w.order.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it("an unknown business is a 404, not a silent success", async () => {
      const w = build();
      await expect(w.deliver(paid(), { businessId: "nope" })).rejects.toThrow(NotFoundException);
    });

    it("in production, a business with no webhook secret configured rejects every event instead of trusting it", async () => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      process.env.NODE_ENV = "production";
      const w = build();
      await expect(w.deliver(paid())).rejects.toThrow(ForbiddenException);
      expect(w.order.status).toBe(OrderStatus.PENDING_PAYMENT);
    });
  });

  describe("the amount that was actually paid must equal the order total, in the order's currency", () => {
    const nothingHappened = (w: ReturnType<typeof build>) => {
      expect(w.order).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, razorpayPaymentId: null });
      expect(w.effects).toEqual({ activity: [], notifications: [], kickoffs: [], outcomes: [] });
    };

    it("an exact match (INR 2,299.00 = 229900 paise) marks the order paid", async () => {
      const w = build();
      await w.deliver(paid());
      expect(w.order).toMatchObject({ status: OrderStatus.PAID, razorpayPaymentId: "pay_1" });
    });

    it("a total with paise is compared as exact integers — INR 1,199.99 is 119999, not a float", async () => {
      const w = build({ total: 1199.99 });
      await w.deliver(paid("pay_1", "plink_1", { amount: 119999 }));
      expect(w.order.status).toBe(OrderStatus.PAID);
    });

    it.each([
      ["underpayment", { amount: 229800 }],
      ["a payment of one paisa less", { amount: 229899 }],
      ["overpayment", { amount: 229901 }],
      ["double payment", { amount: 459800 }],
      ["the right number in the wrong currency", { currency: "USD" }],
      ["a payment of the right amount in rupees instead of paise", { amount: 2299 }],
    ])("%s is acknowledged but does not mark the order paid or start fulfilment", async (_label, override) => {
      const w = build();
      await expect(w.deliver(paid("pay_1", "plink_1", override))).resolves.toEqual({ status: "ok" });
      nothingHappened(w);
    });

    it.each([
      ["no amount on the payment", { amount: undefined }],
      ["a null amount", { amount: null }],
      ["an amount sent as a string", { amount: "229900" }],
      ["a fractional amount", { amount: 229900.5 }],
      ["a zero amount", { amount: 0 }],
      ["a negative amount", { amount: -229900 }],
      ["no currency", { currency: undefined }],
      ["a currency that is not a 3-letter code", { currency: "RUPEES" }],
      ["a link that reports a different paid total than the payment", { linkPaid: 100 }],
      ["a link that claims to belong to another order", { reference: "order-of-someone-else" }],
    ])("%s is ignored — it is never guessed or defaulted", async (_label, override) => {
      const w = build();
      await expect(w.deliver(paid("pay_1", "plink_1", override))).resolves.toEqual({ status: "ok" });
      nothingHappened(w);
    });

    it("a rejected mismatch does not poison the order: the correct payment afterwards still confirms it", async () => {
      const w = build();
      await w.deliver(paid("pay_short", "plink_1", { amount: 100000 }));
      nothingHappened(w);
      await w.deliver(paid("pay_full"));
      expect(w.order).toMatchObject({ status: OrderStatus.PAID, razorpayPaymentId: "pay_full" });
      expect(w.effects.notifications).toHaveLength(1);
    });

    it("duplicate deliveries of a correct payment still have their effects once, while duplicates of a wrong one have none", async () => {
      const right = build();
      await Promise.all([1, 2, 3].map(() => right.deliver(paid())));
      expect(right.effects.notifications).toHaveLength(1);
      expect(right.effects.kickoffs).toHaveLength(1);

      const wrong = build();
      await Promise.all([1, 2, 3].map(() => wrong.deliver(paid("pay_1", "plink_1", { amount: 229800 }))));
      nothingHappened(wrong);
    });

    it("an amendment landing between the amount check and the write cannot be paid at the old price", async () => {
      const w = build();
      w.hooks.beforeUpdate = () => { w.order.total = 3499; }; // the customer changed their order just now
      await w.deliver(paid());
      expect(w.order).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, razorpayPaymentId: null, total: 3499 });
      expect(w.effects.kickoffs).toEqual([]);
    });

    it("a payment link that belongs to another business's order is never matched, whatever amount it carries", async () => {
      const w = build();
      await w.webhook.ingest("biz-other", paid());
      nothingHappened(w);
    });
  });
});
