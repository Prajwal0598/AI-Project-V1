import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { CartService } from "./cart.service";
import { OrderService } from "../orders/order.service";
import { InventoryService } from "../inventory/inventory.service";
import type { PrismaService } from "../../database/prisma.service";
import type { QueueService } from "../../queue/queue.service";
import type { OpportunityService } from "../opportunities/opportunity.service";
import type { ProductRelationService } from "../product-relations/product-relation.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { RazorpayService } from "../payments/razorpay.service";

// Checkout atomicity against a REAL PostgreSQL. Opt-in: `pnpm test` skips this file unless INTEGRATION_DATABASE_URL is set.
// Start any throwaway PostgreSQL on localhost, e.g. `docker run -d --rm -p 127.0.0.1:54329:5432 -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=relay_integration postgres:16`,
// set INTEGRATION_DATABASE_URL to its localhost connection string, then run `pnpm --filter @ai-customer-agent/api test:integration`.
// It only talks to localhost, migrates a private schema (it_<random>) inside that database, and drops the schema afterwards.
// The real CartService, OrderService and InventoryService run on the real database; only Redis queues and outbound messaging are stubbed.

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("Set INTEGRATION_DATABASE_URL to a localhost PostgreSQL database to run the integration tests.");
}
const describeDb = databaseUrl ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PRISMA_CLI = path.join(REPO_ROOT, "packages/database/node_modules/prisma/build/index.js");
const SCHEMA_FILE = path.join(REPO_ROOT, "packages/database/prisma/schema.prisma");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRIVATE_SCHEMA = /^it_[0-9a-f]{16}$/;

function privateSchemaUrl(raw: string, schema: string): string {
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`Refusing to run integration tests against non-local host "${url.hostname}".`);
  // connection-string parameters can redirect the connection away from the host checked above
  for (const param of ["host", "hostaddr"]) if (url.searchParams.has(param)) throw new Error(`Refusing a connection URL that overrides the host with "?${param}=".`);
  url.searchParams.set("schema", schema);
  url.searchParams.set("connection_limit", "16"); // enough connections for every concurrent request to hold its own
  return url.toString();
}

/** Releases every waiter at the same moment once `parties` of them have arrived, so their next statements hit the database together. */
function latch(parties: number, timeoutMs = 10_000) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    async wait() {
      if (++arrived >= parties) open();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("latch timed out — the requests never became concurrent")), timeoutMs); });
      try { await Promise.race([gate, timeout]); } finally { clearTimeout(timer); }
    },
  };
}

describeDb("CartService.checkout against PostgreSQL", () => {
  jest.setTimeout(60_000);

  const schema = `it_${randomBytes(8).toString("hex")}`;
  let localHostConfirmed = false;
  let admin: PrismaClient;
  let db: PrismaClient; // plain client: seeding and assertions
  let cart: CartService;
  let inventory: InventoryService;
  const queues = { scheduleOrderProgress: jest.fn(), scheduleOrderExpiry: jest.fn(), scheduleFulfillmentKickoff: jest.fn(), scheduleAbandonedCartFollowUp: jest.fn(), cancelAbandonedCartFollowUp: jest.fn() };

  // instrumentation on the same connection pool the services use
  const probe = { claimAttempts: 0, claimsWon: 0, inFlight: 0, maxInFlight: 0, orderLookups: 0, failOrderLookupFrom: null as number | null, claimGate: null as ReturnType<typeof latch> | null, reserveGate: null as ReturnType<typeof latch> | null };

  beforeAll(async () => {
    const url = privateSchemaUrl(databaseUrl as string, schema); // refuses a non-local host before anything connects
    localHostConfirmed = true;
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_FILE], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });

    db = new PrismaClient({ datasourceUrl: url });
    const instrumented = db.$extends({
      query: {
        cart: {
          async updateMany({ args, query }: any) {
            const isClaim = args.where?.status === "ACTIVE" && args.data?.status === "CHECKED_OUT";
            if (!isClaim) return query(args);
            probe.claimAttempts += 1;
            if (probe.claimGate) await probe.claimGate.wait();
            probe.inFlight += 1;
            probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
            try {
              const result = await query(args);
              if (result.count === 1) probe.claimsWon += 1;
              return result;
            } finally { probe.inFlight -= 1; }
          },
        },
        order: {
          async findFirst({ args, query }: any) {
            probe.orderLookups += 1;
            if (probe.failOrderLookupFrom !== null && probe.orderLookups >= probe.failOrderLookupFrom) throw new Error("database unreachable");
            return query(args);
          },
        },
        variant: {
          async updateMany({ args, query }: any) {
            // the stock reservation (a conditional decrement) — hold every reservation until all of them are about to run
            if (probe.reserveGate && args.data?.inventory?.decrement !== undefined) await probe.reserveGate.wait();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;

    inventory = new InventoryService(instrumented, {} as never, {} as never);
    const opportunities = { attachOrderOutcome: async () => undefined, expireForCheckedOutCart: async () => undefined, createWithAiMessage: async () => undefined } as unknown as OpportunityService;
    const orders = new OrderService(
      instrumented,
      queues as unknown as QueueService,
      inventory,
      opportunities,
      { getRelationsFor: async () => [] } as unknown as ProductRelationService,
      { sendMessage: async () => undefined } as unknown as ConversationService,
      { createPaymentLink: async () => null } as unknown as RazorpayService,
    );
    cart = new CartService(instrumented, orders, queues as unknown as QueueService, opportunities);
  });

  afterAll(async () => {
    try {
      if (localHostConfirmed && PRIVATE_SCHEMA.test(schema)) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db?.$disconnect();
      await admin?.$disconnect();
    }
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    Object.assign(probe, { claimAttempts: 0, claimsWon: 0, inFlight: 0, maxInFlight: 0, orderLookups: 0, failOrderLookupFrom: null, claimGate: null, reserveGate: null });
    for (const fn of Object.values(queues)) fn.mockReset();
  });

  let seq = 0;
  /** A shop, a customer with a conversation, one in-stock variant, and an ACTIVE cart holding `quantity` of it. */
  async function seedShop(opts: { inventory?: number | null; quantity?: number } = {}) {
    const { inventory: stock = 10, quantity = 2 } = opts;
    seq += 1;
    const business = await db.business.create({ data: { name: `Integration Shop ${seq}` } });
    const product = await db.product.create({ data: { businessId: business.id, name: "Pearl Stud Earrings", status: "PUBLISHED" } });
    const variant = await db.variant.create({ data: { businessId: business.id, productId: product.id, price: 799, inventory: stock, active: true } });
    const shopper = await seedShopper(business.id, variant.id, quantity);
    return { business, product, variant, ...shopper };
  }

  async function seedShopper(businessId: string, variantId: string, quantity: number) {
    const customer = await db.customer.create({ data: { businessId, firstName: "Asha" } });
    const conversation = await db.conversation.create({ data: { businessId, customerId: customer.id, channel: "WHATSAPP" } });
    const theCart = await db.cart.create({ data: { businessId, conversationId: conversation.id, customerId: customer.id, items: { create: [{ variantId, quantity }] } } });
    return { customer, conversation, cart: theCart };
  }

  const input = { shippingAddress: "12 Rose Street, Bengaluru", paymentMethod: "COD" as const };

  /** Everything the database ended up holding for one shop. */
  async function state(businessId: string, variantId: string, cartIds: string[]) {
    const [orderCount, orderItems, carts, variant, reservations] = await Promise.all([
      db.order.count({ where: { businessId } }),
      db.orderItem.findMany({ where: { order: { businessId } } }),
      db.cart.findMany({ where: { id: { in: cartIds } }, select: { id: true, status: true } }),
      db.variant.findUniqueOrThrow({ where: { id: variantId } }),
      db.stockAdjustment.count({ where: { businessId, variantId, reason: "ORDER_RESERVED" } }),
    ]);
    return { orderCount, orderItems, carts, inventory: variant.inventory, reservations };
  }

  it("runs on a real PostgreSQL, in an isolated schema", async () => {
    const [{ version }] = await db.$queryRawUnsafe<{ version: string }[]>("select version()");
    const [{ current_schema }] = await db.$queryRawUnsafe<{ current_schema: string }[]>("select current_schema() as current_schema");
    expect(version).toMatch(/^PostgreSQL/);
    expect(current_schema).toBe(schema);
  });

  describe("two or more checkouts of the SAME cart at the same instant", () => {
    it("create exactly one order, claim the cart once, and reserve the stock once", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      const requests = 8;
      probe.claimGate = latch(requests); // every request reads the cart as ACTIVE, then all eight claim it together

      const results = await Promise.allSettled(Array.from({ length: requests }, () => cart.checkout(shop.cart.id, shop.business.id, input)));

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(requests - 1);
      for (const r of lost) expect(r.reason).toBeInstanceOf(ConflictException);

      // the contention was real: all eight UPDATE ... WHERE status = 'ACTIVE' statements were in flight against the database together, and the database let one through
      expect(probe.claimAttempts).toBe(requests);
      expect(probe.maxInFlight).toBe(requests);
      expect(probe.claimsWon).toBe(1);

      const s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect(s.orderCount).toBe(1);
      expect(s.orderItems).toEqual([expect.objectContaining({ variantId: shop.variant.id, quantity: 2 })]);
      expect(s.carts).toEqual([{ id: shop.cart.id, status: "CHECKED_OUT" }]);
      expect(s.inventory).toBe(8); // 10 - 2, once
      expect(s.reservations).toBe(1);
    });

    it("never produce a second order across repeated, unsynchronised races", async () => {
      for (let round = 0; round < 12; round++) {
        const shop = await seedShop({ inventory: 10, quantity: 3 });
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => cart.checkout(shop.cart.id, shop.business.id, input)));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
        expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations }).toEqual({ orders: 1, inventory: 7, reservations: 1 });
      }
    });
  });

  describe("two different carts competing for the last units", () => {
    it("sell the stock once: one order, the other fails with 'not enough stock', stock never goes negative, and the loser can retry after restocking", async () => {
      const shop = await seedShop({ inventory: 3, quantity: 2 });
      const second = await seedShopper(shop.business.id, shop.variant.id, 2); // both carts passed the stock check when items were added
      probe.reserveGate = latch(2); // both reservations (conditional decrements) are issued at the same moment

      const results = await Promise.allSettled([cart.checkout(shop.cart.id, shop.business.id, input), cart.checkout(second.cart.id, shop.business.id, input)]);
      probe.reserveGate = null;

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(loser.reason).toBeInstanceOf(BadRequestException);
      expect(String(loser.reason.message)).toMatch(/not enough stock/i);

      let s = await state(shop.business.id, shop.variant.id, [shop.cart.id, second.cart.id]);
      expect(s.inventory).toBe(1); // 3 - 2, never negative
      expect(s.orderCount).toBe(1);
      expect(s.reservations).toBe(1);
      expect(s.carts.map((c) => c.status).sort()).toEqual(["ACTIVE", "CHECKED_OUT"]); // the loser's cart was handed back
      const loserCartId = s.carts.find((c) => c.status === "ACTIVE")!.id;
      expect(await db.cartItem.count({ where: { cartId: loserCartId } })).toBe(1); // …with its item intact

      await db.variant.update({ where: { id: shop.variant.id }, data: { inventory: 5 } }); // restocked
      await expect(cart.checkout(loserCartId, shop.business.id, input)).resolves.toBeDefined();
      s = await state(shop.business.id, shop.variant.id, [shop.cart.id, second.cart.id]);
      expect(s.orderCount).toBe(2);
      expect(s.inventory).toBe(3);
      expect(s.reservations).toBe(2);
    });
  });

  describe("failure and retry", () => {
    it("stock gone before checkout: nothing is ordered or reserved, the cart is reopened, and a retry after restocking succeeds", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      await db.variant.update({ where: { id: shop.variant.id }, data: { inventory: 1 } }); // sold elsewhere

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).rejects.toThrow(/not enough stock/i);
      let s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations, cart: s.carts[0].status }).toEqual({ orders: 0, inventory: 1, reservations: 0, cart: "ACTIVE" });

      await db.variant.update({ where: { id: shop.variant.id }, data: { inventory: 10 } });
      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).resolves.toBeDefined();
      s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, cart: s.carts[0].status }).toEqual({ orders: 1, inventory: 8, cart: "CHECKED_OUT" });
    });

    it("a crash INSIDE the order transaction rolls the whole thing back (no order, no stock taken), reopens the cart, and a retry succeeds", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      jest.spyOn(inventory, "recordAdjustment").mockRejectedValueOnce(new Error("disk full")); // raised after the stock decrement, before commit

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).rejects.toThrow("disk full");
      let s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations, cart: s.carts[0].status }).toEqual({ orders: 0, inventory: 10, reservations: 0, cart: "ACTIVE" });

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).resolves.toBeDefined();
      s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations }).toEqual({ orders: 1, inventory: 8, reservations: 1 });
    });

    it("a step failing AFTER the order was committed returns that order, keeps the cart closed, and a retry cannot create another", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      queues.scheduleOrderProgress.mockRejectedValueOnce(new Error("redis unavailable")); // runs after the transaction has committed

      const order = await cart.checkout(shop.cart.id, shop.business.id, input);
      const committed = await db.order.findMany({ where: { businessId: shop.business.id } });
      expect(committed.map((o) => o.id)).toEqual([order.id]);
      let s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, cart: s.carts[0].status }).toEqual({ orders: 1, inventory: 8, cart: "CHECKED_OUT" });

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).rejects.toThrow(ConflictException); // the customer taps Confirm again
      s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations }).toEqual({ orders: 1, inventory: 8, reservations: 1 });
    });

    it("when it cannot even be checked whether the order committed (ambiguous failure), the cart stays closed and a retry creates no second order", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      queues.scheduleOrderProgress.mockRejectedValueOnce(new Error("redis unavailable"));
      probe.failOrderLookupFrom = 2; // the first lookup (before the claim) works; the check after the failure cannot reach the database

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).rejects.toThrow("redis unavailable");
      probe.failOrderLookupFrom = null;
      let s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, cart: s.carts[0].status }).toEqual({ orders: 1, cart: "CHECKED_OUT" }); // the order really was committed

      await expect(cart.checkout(shop.cart.id, shop.business.id, input)).rejects.toThrow(ConflictException);
      s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory, reservations: s.reservations }).toEqual({ orders: 1, inventory: 8, reservations: 1 });
    });

    it("concurrent retries after a committed-but-failed checkout still produce no second order", async () => {
      const shop = await seedShop({ inventory: 10, quantity: 2 });
      queues.scheduleOrderProgress.mockRejectedValueOnce(new Error("redis unavailable"));
      await cart.checkout(shop.cart.id, shop.business.id, input);

      const retries = await Promise.allSettled(Array.from({ length: 5 }, () => cart.checkout(shop.cart.id, shop.business.id, input)));
      for (const r of retries) expect(r.status === "rejected" && r.reason instanceof ConflictException).toBe(true);
      const s = await state(shop.business.id, shop.variant.id, [shop.cart.id]);
      expect({ orders: s.orderCount, inventory: s.inventory }).toEqual({ orders: 1, inventory: 8 });
    });
  });
});
