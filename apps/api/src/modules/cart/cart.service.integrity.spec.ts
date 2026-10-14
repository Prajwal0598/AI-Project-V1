import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { CartService } from "./cart.service";
import type { PrismaService } from "../../database/prisma.service";
import type { OrderService } from "../orders/order.service";
import type { QueueService } from "../../queue/queue.service";
import type { OpportunityService } from "../opportunities/opportunity.service";

// The REAL CartService against a stateful in-memory database. Every awaited call yields, so concurrent requests
// genuinely interleave — a read-then-write race that a canned mock would never expose shows up here.

const BIZ = "biz1";
const OTHER_BIZ = "biz2";
const CONV = "conv1";
const CUSTOMER = "cust1";
const tick = () => Promise.resolve();

interface FakeVariant { id: string; productId: string; businessId: string; active: boolean; price: number; currency: string; inventory: number | null; attributes: Record<string, string> | null; product: { id: string; name: string; status: "PUBLISHED" | "DRAFT" | "HIDDEN" } }
const variant = (id: string, productId: string, name: string, price: number, inventory: number | null = 10, businessId = BIZ): FakeVariant => ({
  id, productId, businessId, active: true, price, currency: "INR", inventory, attributes: null, product: { id: productId, name, status: "PUBLISHED" },
});

function build() {
  const variants: FakeVariant[] = [
    variant("v-stud", "p-stud", "Pearl Stud Earrings", 799),
    variant("v-drop", "p-drop", "Pearl Drop Earrings", 1199, 5),
    variant("v-foreign", "p-foreign", "Another Shop's Ring", 499, 10, OTHER_BIZ),
  ];
  const carts: Record<string, any>[] = [];
  const items: { cartId: string; variantId: string; quantity: number }[] = [];
  const matches = (row: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => row[k] === v);
  const shape = (c: Record<string, any>) => ({ ...c, items: items.filter((i) => i.cartId === c.id).map((i) => ({ ...i, variant: variants.find((v) => v.id === i.variantId)! })) });

  const prisma: any = {
    cart: {
      findFirst: async ({ where }: { where: Record<string, any> }) => { await tick(); const c = carts.find((x) => matches(x, where)); return c ? shape(c) : null; },
      create: async ({ data }: { data: Record<string, any> }) => { const c = { id: `cart${carts.length + 1}`, status: "ACTIVE", ...data }; carts.push(c); return shape(c); },
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => { await tick(); const hit = carts.filter((c) => matches(c, where)); hit.forEach((c) => Object.assign(c, data)); return { count: hit.length }; },
      // a plain update by id (no status condition) — what a read-then-write implementation would use
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => { await tick(); const c = carts.find((x) => x.id === where.id)!; Object.assign(c, data); return c; },
    },
    cartItem: {
      findUnique: async ({ where }: { where: { cartId_variantId: { cartId: string; variantId: string } } }) => { await tick(); return items.find((i) => i.cartId === where.cartId_variantId.cartId && i.variantId === where.cartId_variantId.variantId) ?? null; },
      upsert: async ({ where, create, update }: any) => {
        const existing = items.find((i) => i.cartId === where.cartId_variantId.cartId && i.variantId === where.cartId_variantId.variantId);
        if (existing) Object.assign(existing, update); else items.push({ ...create });
      },
      deleteMany: async ({ where }: any) => { for (let i = items.length - 1; i >= 0; i--) if (items[i].cartId === where.cartId) items.splice(i, 1); },
      updateMany: async () => ({ count: 0 }),
    },
    variant: {
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        await tick();
        return variants.find((v) => v.id === where.id && v.businessId === where.businessId && (where.active === undefined || v.active === where.active) && (!where.product || v.product.status === where.product.status)) ?? null;
      },
    },
    conversation: { findUnique: async () => ({ id: CONV, activeOrderId: null }) },
    order: {
      // the conversation's newest order — what CartService looks at to tell whether a failed checkout had already committed
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        await tick();
        hooks.orderLookups += 1;
        if (hooks.failOrderLookupFrom !== null && hooks.orderLookups >= hooks.failOrderLookupFrom) throw new Error("database unreachable");
        const mine = created.filter(() => where.conversationId === CONV);
        return mine.length ? { ...mine[mine.length - 1] } : null;
      },
    },
  };

  const hooks = { orderLookups: 0, failOrderLookupFrom: null as number | null };
  const created: { id: string; items: { variantId?: string; quantity: number }[] }[] = [];
  /** What OrderService.create commits: stock is reserved with ONE conditional step per item (like `updateMany where inventory >= qty`), then the order row exists. */
  const commit = async (input: { items: { variantId?: string; quantity: number }[] }) => {
    const reserved: { v: FakeVariant; quantity: number }[] = [];
    for (const item of input.items) {
      const v = variants.find((x) => x.id === item.variantId)!;
      if (v.inventory !== null && v.inventory < item.quantity) {
        reserved.forEach((r) => { r.v.inventory = (r.v.inventory ?? 0) + r.quantity; }); // the transaction rolls back
        throw new BadRequestException(`Only ${v.inventory} left in stock.`);
      }
      if (v.inventory !== null) v.inventory -= item.quantity;
      reserved.push({ v, quantity: item.quantity });
    }
    await tick();
    const order = { id: `order${created.length + 1}`, status: "PENDING_PAYMENT", items: input.items };
    created.push(order);
    return order;
  };
  const orders = {
    create: jest.fn(async (_biz: string, input: { items: { variantId?: string; quantity: number }[] }) => { await tick(); return commit(input); }),
    replaceItems: jest.fn(),
  };
  const queues = { scheduleAbandonedCartFollowUp: jest.fn(), cancelAbandonedCartFollowUp: jest.fn() };
  const opportunities = { expireForCheckedOutCart: jest.fn() };
  const service = new CartService(prisma as unknown as PrismaService, orders as unknown as OrderService, queues as unknown as QueueService, opportunities as unknown as OpportunityService);
  return { service, prisma, variants, carts, items, orders, created, queues, opportunities, commit, hooks };
}

describe("CartService — only real, purchasable products can be added", () => {
  let w: ReturnType<typeof build>;
  beforeEach(() => { w = build(); });

  it("adds an active variant of a published product", async () => {
    const cart = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    const updated = await w.service.addItem(cart.id, BIZ, "v-stud", 2);
    expect(updated.items.map((i) => [i.variantId, i.quantity])).toEqual([["v-stud", 2]]);
  });

  it.each([
    ["an id that never existed", "does-not-exist"],
    ["a variant that belongs to another business", "v-foreign"],
  ])("refuses %s", async (_label, variantId) => {
    const cart = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await expect(w.service.addItem(cart.id, BIZ, variantId, 1)).rejects.toThrow(NotFoundException);
    expect(w.items).toEqual([]);
  });

  it("refuses a variant the merchant switched off", async () => {
    w.variants[0].active = false;
    const cart = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await expect(w.service.addItem(cart.id, BIZ, "v-stud", 1)).rejects.toThrow("no longer available");
    expect(w.items).toEqual([]);
  });

  it.each(["DRAFT", "HIDDEN"] as const)("refuses a product that is now %s (hidden or 'deleted' after it was shown)", async (status) => {
    w.variants[0].product.status = status;
    const cart = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await expect(w.service.addItem(cart.id, BIZ, "v-stud", 1)).rejects.toThrow(NotFoundException);
    expect(w.items).toEqual([]);
  });

  it("refuses a cart that belongs to another business", async () => {
    const cart = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await expect(w.service.addItem(cart.id, OTHER_BIZ, "v-foreign", 1)).rejects.toThrow(NotFoundException);
  });
});

describe("CartService — the cart persists across sessions and days", () => {
  afterEach(() => { jest.useRealTimers(); });

  it("a customer coming back days later finds the same cart with the same items, however much they browse in between", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T10:00:00Z"), doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const w = build();
    const first = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await w.service.addItem(first.id, BIZ, "v-stud", 1);
    await w.service.addItem(first.id, BIZ, "v-drop", 2);

    jest.setSystemTime(new Date("2026-10-13T09:30:00Z")); // three days later, a brand-new session
    const later = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    expect(later.id).toBe(first.id);
    expect(later.items.map((i) => [i.variantId, i.quantity])).toEqual([["v-stud", 1], ["v-drop", 2]]);
    expect(w.carts).toHaveLength(1);

    // the lookup has no age/time condition of any kind — only the conversation, the business and "still active"
    const lookup = jest.spyOn(w.prisma.cart, "findFirst") as jest.SpyInstance<Promise<unknown>, [{ where: Record<string, unknown> }]>;
    await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    expect(lookup.mock.calls[0][0].where).toEqual({ conversationId: CONV, businessId: BIZ, status: "ACTIVE" });
  });

  it("another conversation (or business) never sees this cart", async () => {
    const w = build();
    const mine = await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER);
    await w.service.addItem(mine.id, BIZ, "v-stud", 1);
    expect(await w.service.findActiveForConversation("conv-other", BIZ)).toBeNull();
    expect(await w.service.findActiveForConversation(CONV, OTHER_BIZ)).toBeNull();
  });
});

describe("CartService.checkout — one cart becomes at most one order", () => {
  let w: ReturnType<typeof build>;
  let cartId: string;
  const input = { shippingAddress: "12 Rose Street, Bengaluru", paymentMethod: "COD" as const };

  beforeEach(async () => {
    w = build();
    cartId = (await w.service.getOrCreateActive(CONV, BIZ, CUSTOMER)).id;
    await w.service.addItem(cartId, BIZ, "v-stud", 2);
  });

  it("places one order from the cart's real catalogue prices, reserves its stock once, then closes the cart", async () => {
    const order = await w.service.checkout(cartId, BIZ, input);
    expect(order).toMatchObject({ id: "order1" });
    expect(w.created).toHaveLength(1);
    expect(w.orders.create).toHaveBeenCalledWith(BIZ, expect.objectContaining({ subtotal: 1598, items: [expect.objectContaining({ variantId: "v-stud", quantity: 2, unitPrice: 799 })] }));
    expect(w.variants[0].inventory).toBe(8);
    expect(w.carts[0].status).toBe("CHECKED_OUT");
    expect(w.opportunities.expireForCheckedOutCart).toHaveBeenCalledWith(BIZ, cartId);
    expect(w.queues.cancelAbandonedCartFollowUp).toHaveBeenCalledWith(cartId);
  });

  it("several simultaneous confirmations (a double tap delivered as separate messages) create exactly ONE order and consume the stock ONCE", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => w.service.checkout(cartId, BIZ, input)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toBeInstanceOf(ConflictException);
    expect(w.created).toHaveLength(1);
    expect(w.orders.create).toHaveBeenCalledTimes(1);
    expect(w.variants[0].inventory).toBe(8); // 10 - 2, not 10 - 8
  });

  it("a confirmation sent again later is refused and creates nothing", async () => {
    await w.service.checkout(cartId, BIZ, input);
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow(ConflictException);
    expect(w.created).toHaveLength(1);
    expect(w.variants[0].inventory).toBe(8);
  });

  it("if the stock ran out before checkout, no order is placed, nothing is reserved, the cart is handed back, and a retry after restocking succeeds", async () => {
    w.variants[0].inventory = 1; // sold elsewhere since it was added to the cart
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow("Only 1 left in stock.");
    expect(w.carts[0].status).toBe("ACTIVE");
    expect(w.created).toHaveLength(0);
    expect(w.variants[0].inventory).toBe(1);

    w.variants[0].inventory = 10;
    await expect(w.service.checkout(cartId, BIZ, input)).resolves.toMatchObject({ id: "order1" });
    expect(w.created).toHaveLength(1);
    expect(w.variants[0].inventory).toBe(8);
  });

  it("a failure before anything was committed (not an HTTP error) also hands the cart back, because no new order exists", async () => {
    w.orders.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow("connection reset");
    expect(w.carts[0].status).toBe("ACTIVE");
    await expect(w.service.checkout(cartId, BIZ, input)).resolves.toMatchObject({ id: "order1" });
    expect(w.created).toHaveLength(1);
  });

  it("a follow-up step failing AFTER the order was committed returns that order and keeps the cart closed — a retry can never place it twice", async () => {
    w.orders.create.mockImplementationOnce(async (_biz: string, orderInput: { items: { variantId?: string; quantity: number }[] }) => {
      await w.commit(orderInput);
      throw new Error("redis unavailable while scheduling the expiry job");
    });
    await expect(w.service.checkout(cartId, BIZ, input)).resolves.toMatchObject({ id: "order1" });
    expect(w.carts[0].status).toBe("CHECKED_OUT");
    expect(w.created).toHaveLength(1);

    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow(ConflictException);
    expect(w.created).toHaveLength(1);
    expect(w.variants[0].inventory).toBe(8);
  });

  it("when it cannot be established whether the order was committed, the cart stays closed rather than risk a duplicate", async () => {
    w.orders.create.mockRejectedValueOnce(new Error("connection reset"));
    w.hooks.failOrderLookupFrom = 2; // the check made after the failure cannot reach the database
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow("connection reset");
    expect(w.carts[0].status).toBe("CHECKED_OUT");
  });

  it("an item hidden after it was added blocks checkout, names the item, places no order and keeps the cart open", async () => {
    w.variants[0].product.status = "HIDDEN";
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow("Pearl Stud Earrings is no longer available");
    expect(w.created).toHaveLength(0);
    expect(w.carts[0].status).toBe("ACTIVE");
    expect(w.variants[0].inventory).toBe(10);
  });

  it("an empty cart cannot be checked out", async () => {
    await w.service.clear(cartId, BIZ);
    await expect(w.service.checkout(cartId, BIZ, input)).rejects.toThrow("Your cart is empty.");
    expect(w.created).toHaveLength(0);
  });
});
