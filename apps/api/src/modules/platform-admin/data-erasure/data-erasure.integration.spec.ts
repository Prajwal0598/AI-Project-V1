import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { ConflictException, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { DataErasureService, ERASED_CUSTOMER_LABEL } from "./data-erasure.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { ExecuteErasureDto } from "./data-erasure.dto";

// Customer-data erasure against a REAL PostgreSQL. Opt-in: `pnpm test` skips this file unless INTEGRATION_DATABASE_URL is set.
// Start any throwaway PostgreSQL on localhost, e.g. `docker run -d --rm -p 127.0.0.1:54329:5432 -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=relay_integration postgres:16`,
// set INTEGRATION_DATABASE_URL to its localhost connection string, then run `pnpm --filter @ai-customer-agent/api test:integration`.
// It only talks to localhost, migrates a private schema (it_<random>) inside that database, and drops the schema afterwards.
// It never reads or writes any other database, and every row it seeds is synthetic.

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("Set INTEGRATION_DATABASE_URL to a localhost PostgreSQL database to run the integration tests.");
}
const describeDb = databaseUrl ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
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
  url.searchParams.set("connection_limit", "16");
  return url.toString();
}

describeDb("DataErasureService against PostgreSQL", () => {
  jest.setTimeout(60_000);

  const schema = `it_${randomBytes(8).toString("hex")}`;
  const OPERATOR = "usr_platform_admin_test";
  let localHostConfirmed = false;
  let admin: PrismaClient;
  let db: PrismaClient; // plain client: seeding and assertions
  let service: DataErasureService;
  const probe = { failOrderUpdate: false };

  beforeAll(async () => {
    const url = privateSchemaUrl(databaseUrl as string, schema); // refuses a non-local host before anything connects
    localHostConfirmed = true;
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_FILE], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });

    db = new PrismaClient({ datasourceUrl: url });
    // lets one test make a statement inside the erasure transaction fail, to prove the whole erasure rolls back
    const instrumented = db.$extends({
      query: {
        order: {
          async updateMany({ args, query }: any) {
            if (probe.failOrderUpdate) throw new Error("simulated database failure");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;
    service = new DataErasureService(instrumented);
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
    probe.failOrderUpdate = false;
  });

  let seq = 0;

  /** One customer with a full footprint: identity, conversation + messages, cart, signal, opportunity + suggestion, activity, lead score, one fulfilled order, two audit-log rows. */
  async function seedCustomer(businessId: string, productId: string, variantId: string, firstName: string) {
    seq += 1;
    const customer = await db.customer.create({ data: { businessId, firstName, lastName: "Verma", email: `${firstName.toLowerCase()}-${seq}@example.test`, phone: `+91900000${String(seq).padStart(4, "0")}`, tags: ["vip"] } });
    const identity = await db.identity.create({ data: { businessId, customerId: customer.id, channel: "WHATSAPP", identifier: `9190000${String(seq).padStart(5, "0")}`, displayName: firstName, isPrimary: true } });
    const conversation = await db.conversation.create({ data: { businessId, customerId: customer.id, identityId: identity.id, channel: "WHATSAPP", title: `Chat with ${firstName}` } });
    await db.message.createMany({
      data: [
        { conversationId: conversation.id, direction: "INBOUND", content: "Hi, do you have the pearl studs? My address is 12 Rose Street." },
        { conversationId: conversation.id, direction: "OUTBOUND", content: "Yes, they are in stock." },
        { conversationId: conversation.id, direction: "INBOUND", content: "Great, I will order." },
      ],
    });
    const cart = await db.cart.create({ data: { businessId, conversationId: conversation.id, customerId: customer.id, items: { create: [{ variantId, quantity: 2 }] } } });
    await db.customerSignal.create({ data: { businessId, customerId: customer.id, type: "PRODUCT_VIEWED", productId, variantId } });
    await db.opportunity.create({
      data: { businessId, customerId: customer.id, type: "ABANDONED_CART", reason: `${firstName} left items in the cart`, relatedCartId: cart.id, suggestion: { create: { message: `Hi ${firstName}, still interested?` } } },
    });
    await db.activityEvent.create({ data: { businessId, customerId: customer.id, type: "MESSAGE_SENT", summary: `Message sent to ${firstName}` } });
    await db.leadScore.create({ data: { customerId: customer.id, score: 80, reason: `${firstName} is a repeat buyer` } });
    const order = await db.order.create({
      data: {
        businessId, customerId: customer.id, conversationId: conversation.id, status: "FULFILLED", fulfillmentStatus: "DELIVERED",
        subtotal: "1598.00", total: "1598.00", paymentMethod: "UPI", razorpayPaymentId: `pay_test_${seq}`,
        shippingAddress: { line1: "12 Rose Street", city: "Bengaluru", pincode: "560001" },
        items: { create: [{ productId, variantId, name: "Pearl Stud Earrings", quantity: 2, unitPrice: "799.00" }] },
      },
    });
    await db.aiActionLog.create({ data: { businessId, customerId: customer.id, conversationId: conversation.id, orderId: order.id, action: "CREATE_ORDER", reason: `${firstName} asked to order the pearl studs`, result: "ORDER_CREATED" } });
    await db.aiActionLog.create({ data: { businessId, conversationId: conversation.id, action: "SEND_REPLY", reason: "Answered a stock question", result: "SENT" } }); // linked to the person only through the conversation
    return { customer, conversation, order };
  }

  /** A merchant with a target customer (the one to erase) and a bystander customer in the same shop. */
  async function seedMerchant() {
    seq += 1;
    const business = await db.business.create({ data: { name: `Erasure Shop ${seq}` } });
    const product = await db.product.create({ data: { businessId: business.id, name: "Pearl Stud Earrings", status: "PUBLISHED" } });
    const variant = await db.variant.create({ data: { businessId: business.id, productId: product.id, price: 799, inventory: 50, active: true } });
    const target = await seedCustomer(business.id, product.id, variant.id, "Asha");
    const bystander = await seedCustomer(business.id, product.id, variant.id, "Ravi");
    return { business, product, variant, target, bystander };
  }

  /** Everything the database holds for one customer, in a shape two snapshots can be compared with toEqual. */
  async function footprint(businessId: string, customerId: string, conversationId: string) {
    return {
      customer: await db.customer.findUnique({ where: { id: customerId } }),
      identities: await db.identity.findMany({ where: { customerId } }),
      conversations: await db.conversation.findMany({ where: { customerId } }),
      messages: await db.message.findMany({ where: { conversationId }, orderBy: { id: "asc" } }),
      carts: await db.cart.findMany({ where: { customerId }, include: { items: true } }),
      signals: await db.customerSignal.findMany({ where: { customerId } }),
      opportunities: await db.opportunity.findMany({ where: { customerId }, include: { suggestion: true } }),
      activity: await db.activityEvent.findMany({ where: { customerId } }),
      leadScore: await db.leadScore.findUnique({ where: { customerId } }),
      orders: await db.order.findMany({ where: { customerId }, include: { items: true } }),
      aiLogs: await db.aiActionLog.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    };
  }

  const dtoFor = (s: { business: { id: string }; target: { customer: { id: string } } }, over: Partial<ExecuteErasureDto> = {}): ExecuteErasureDto => ({
    businessId: s.business.id,
    customerId: s.target.customer.id,
    requestReference: "TICKET-1001",
    requestedBy: "CUSTOMER",
    verificationMethod: "REPLY_FROM_CUSTOMER_CHANNEL",
    confirm: `ERASE ${s.target.customer.id}`,
    ...over,
  });

  it("preview reports exactly what an erasure would do and changes nothing", async () => {
    const s = await seedMerchant();
    const before = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);

    const report = await service.preview({ businessId: s.business.id, customerId: s.target.customer.id });

    expect(report.dryRun).toBe(true);
    expect(report.confirmationRequired).toBe(`ERASE ${s.target.customer.id}`);
    expect(report.warnings).toEqual([]);
    expect(report.counts).toEqual({
      identities: 1, conversations: 1, messages: 3, carts: 1, cartItems: 1, customerSignals: 1, opportunities: 1, suggestions: 1,
      activityEvents: 1, aiActionLogsScrubbed: 2, leadScores: 1, ordersRetained: 1, deliveryAddressesRemoved: 1, customerRecordsAnonymised: 1,
    });
    expect(await footprint(s.business.id, s.target.customer.id, s.target.conversation.id)).toEqual(before);
    expect(await db.dataErasureRequest.count({ where: { businessId: s.business.id } })).toBe(0);
  });

  it("erases the customer's personal data and keeps the order and payment records without the delivery address", async () => {
    const s = await seedMerchant();
    const result = await service.execute(dtoFor(s), OPERATOR);

    expect(result).toMatchObject({ status: "COMPLETED", alreadyCompleted: false });
    expect(result.counts).toMatchObject({ identities: 1, conversations: 1, messages: 3, carts: 1, customerSignals: 1, opportunities: 1, activityEvents: 1, leadScores: 1, ordersRetained: 1 });

    const after = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);
    expect(after.customer).toMatchObject({ firstName: ERASED_CUSTOMER_LABEL, lastName: null, email: null, phone: null, tags: [], proactiveMessagingOptOut: true });
    expect(after.identities).toEqual([]);
    expect(after.conversations).toEqual([]);
    expect(after.messages).toEqual([]);
    expect(after.carts).toEqual([]);
    expect(after.signals).toEqual([]);
    expect(after.opportunities).toEqual([]);
    expect(await db.suggestion.count({ where: { opportunity: { customerId: s.target.customer.id } } })).toBe(0);
    expect(after.activity).toEqual([]);
    expect(after.leadScore).toBeNull();

    // order, payment and totals survive; only the address and the conversation link are gone
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ id: s.target.order.id, customerId: s.target.customer.id, status: "FULFILLED", paymentMethod: "UPI", conversationId: null, shippingAddress: null });
    expect(after.orders[0].razorpayPaymentId).toBe(s.target.order.razorpayPaymentId);
    expect(after.orders[0].total.toString()).toBe("1598");
    expect(after.orders[0].items).toHaveLength(1);
  });

  it("scrubs both audit-log rows (linked by customer and by conversation) of the erased customer only", async () => {
    const s = await seedMerchant();
    await service.execute(dtoFor(s), OPERATOR);

    const logs = await db.aiActionLog.findMany({ where: { businessId: s.business.id } });
    expect(logs).toHaveLength(4);
    // nothing links back to the erased customer any more, but the order link and the outcome of what the AI did remain
    expect(logs.filter((l) => l.customerId === s.target.customer.id || l.conversationId === s.target.conversation.id)).toEqual([]);
    const scrubbed = logs.filter((l) => l.customerId === null && l.conversationId === null);
    expect(scrubbed).toHaveLength(2);
    expect(scrubbed.every((l) => l.reason === null)).toBe(true);
    expect(scrubbed.find((l) => l.action === "CREATE_ORDER")).toMatchObject({ orderId: s.target.order.id, result: "ORDER_CREATED" });
    expect(scrubbed.find((l) => l.action === "SEND_REPLY")).toMatchObject({ result: "SENT" });
    // the bystander's rows are untouched
    const bystanderLogs = logs.filter((l) => l.customerId === s.bystander.customer.id || l.conversationId === s.bystander.conversation.id);
    expect(bystanderLogs).toHaveLength(2);
    expect(bystanderLogs.find((l) => l.action === "CREATE_ORDER")?.reason).toBe("Ravi asked to order the pearl studs");
  });

  it("leaves another customer of the same merchant and another merchant completely untouched", async () => {
    const a = await seedMerchant();
    const b = await seedMerchant();
    const bystanderBefore = await footprint(a.business.id, a.bystander.customer.id, a.bystander.conversation.id);
    const otherTenantBefore = await footprint(b.business.id, b.target.customer.id, b.target.conversation.id);
    const otherTenantAiLogs = await db.aiActionLog.findMany({ where: { businessId: b.business.id }, orderBy: { id: "asc" } });

    await service.execute(dtoFor(a), OPERATOR);

    const bystanderAfter = await footprint(a.business.id, a.bystander.customer.id, a.bystander.conversation.id);
    expect({ ...bystanderAfter, aiLogs: bystanderAfter.aiLogs.filter((l) => l.customerId === a.bystander.customer.id || l.conversationId === a.bystander.conversation.id) })
      .toEqual({ ...bystanderBefore, aiLogs: bystanderBefore.aiLogs.filter((l) => l.customerId === a.bystander.customer.id || l.conversationId === a.bystander.conversation.id) });
    expect(await footprint(b.business.id, b.target.customer.id, b.target.conversation.id)).toEqual(otherTenantBefore);
    expect(await db.aiActionLog.findMany({ where: { businessId: b.business.id }, orderBy: { id: "asc" } })).toEqual(otherTenantAiLogs);
  });

  it("refuses a customer id that belongs to a different merchant, identically to a non-existent one, and changes nothing", async () => {
    const a = await seedMerchant();
    const b = await seedMerchant();
    const victimBefore = await footprint(b.business.id, b.target.customer.id, b.target.conversation.id);

    // merchant A's id paired with merchant B's customer
    const crossTenant = dtoFor(a, { customerId: b.target.customer.id, confirm: `ERASE ${b.target.customer.id}` });
    await expect(service.execute(crossTenant, OPERATOR)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.preview({ businessId: a.business.id, customerId: b.target.customer.id })).rejects.toBeInstanceOf(NotFoundException);
    const missing = await service.preview({ businessId: a.business.id, customerId: "cus_does_not_exist_000" }).catch((e) => e);
    const cross = await service.preview({ businessId: a.business.id, customerId: b.target.customer.id }).catch((e) => e);
    expect(missing.message).toBe(cross.message);

    expect(await footprint(b.business.id, b.target.customer.id, b.target.conversation.id)).toEqual(victimBefore);
    expect(await db.dataErasureRequest.count({ where: { businessId: { in: [a.business.id, b.business.id] } } })).toBe(0);
  });

  it("rejects a wrong confirmation phrase without changing anything", async () => {
    const s = await seedMerchant();
    const before = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);
    await expect(service.execute(dtoFor(s, { confirm: "ERASE" }), OPERATOR)).rejects.toThrow("Confirmation text does not match");
    expect(await footprint(s.business.id, s.target.customer.id, s.target.conversation.id)).toEqual(before);
    expect(await db.dataErasureRequest.count({ where: { businessId: s.business.id } })).toBe(0);
  });

  it("is idempotent: repeating a completed request returns the original result and does nothing", async () => {
    const s = await seedMerchant();
    const first = await service.execute(dtoFor(s), OPERATOR);
    const afterFirst = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);

    const second = await service.execute(dtoFor(s), OPERATOR);

    expect(second).toMatchObject({ status: "COMPLETED", alreadyCompleted: true, requestId: first.requestId, counts: first.counts });
    expect(await footprint(s.business.id, s.target.customer.id, s.target.conversation.id)).toEqual(afterFirst);
    expect(await db.dataErasureRequest.count({ where: { businessId: s.business.id, customerId: s.target.customer.id } })).toBe(1);
  });

  it("handles two simultaneous requests with the same reference as one erasure", async () => {
    const s = await seedMerchant();
    const results = await Promise.allSettled([service.execute(dtoFor(s), OPERATOR), service.execute(dtoFor(s), OPERATOR)]);

    expect(results.some((r) => r.status === "fulfilled" && r.value.status === "COMPLETED")).toBe(true);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictException);
    const rows = await db.dataErasureRequest.findMany({ where: { businessId: s.business.id, customerId: s.target.customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
  });

  it("records an audit row with ids, counts and the verification method but none of the erased personal data", async () => {
    const s = await seedMerchant();
    await service.execute(dtoFor(s, { requestedBy: "MERCHANT", verificationMethod: "MERCHANT_WRITTEN_AUTHORISATION" }), OPERATOR);

    const row = await db.dataErasureRequest.findFirstOrThrow({ where: { businessId: s.business.id, customerId: s.target.customer.id } });
    expect(row).toMatchObject({ status: "COMPLETED", requestedBy: "MERCHANT", verificationMethod: "MERCHANT_WRITTEN_AUTHORISATION", executedByUserId: OPERATOR, requestReference: "TICKET-1001", failureReason: null });
    expect(row.completedAt).toBeInstanceOf(Date);
    const serialised = JSON.stringify(row);
    for (const secret of ["Asha", "Verma", "example.test", "+91900000", "Rose Street", "pearl studs"]) expect(serialised).not.toContain(secret);
  });

  it("blocks an erasure while an order is open unless the operator acknowledges it, and then still keeps the order", async () => {
    const s = await seedMerchant();
    const open = await db.order.create({ data: { businessId: s.business.id, customerId: s.target.customer.id, status: "PENDING_PAYMENT", subtotal: "799.00", total: "799.00", shippingAddress: { line1: "12 Rose Street" } } });
    const before = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);

    const preview = await service.preview({ businessId: s.business.id, customerId: s.target.customer.id });
    expect(preview.warnings).toEqual([expect.objectContaining({ code: "OPEN_ORDERS", count: 1 })]);
    await expect(service.execute(dtoFor(s), OPERATOR)).rejects.toBeInstanceOf(ConflictException);
    expect(await footprint(s.business.id, s.target.customer.id, s.target.conversation.id)).toEqual(before);
    expect(await db.dataErasureRequest.count({ where: { businessId: s.business.id } })).toBe(0);

    const result = await service.execute(dtoFor(s, { acknowledgeOpenOrders: true }), OPERATOR);
    expect(result.status).toBe("COMPLETED");
    const kept = await db.order.findUniqueOrThrow({ where: { id: open.id } });
    expect(kept).toMatchObject({ status: "PENDING_PAYMENT", shippingAddress: null });
  });

  it("rolls everything back when a step fails, marks the request FAILED, and a retry with the same reference completes", async () => {
    const s = await seedMerchant();
    const before = await footprint(s.business.id, s.target.customer.id, s.target.conversation.id);

    probe.failOrderUpdate = true;
    await expect(service.execute(dtoFor(s), OPERATOR)).rejects.toBeInstanceOf(InternalServerErrorException);

    // nothing was erased even though the deletes before the failing statement had already run
    expect(await footprint(s.business.id, s.target.customer.id, s.target.conversation.id)).toEqual(before);
    const failed = await db.dataErasureRequest.findFirstOrThrow({ where: { businessId: s.business.id, customerId: s.target.customer.id } });
    expect(failed).toMatchObject({ status: "FAILED", failureReason: "Error", counts: null, completedAt: null });

    probe.failOrderUpdate = false;
    const retried = await service.execute(dtoFor(s), OPERATOR);
    expect(retried).toMatchObject({ status: "COMPLETED", alreadyCompleted: false, requestId: failed.id });
    expect(await db.message.count({ where: { conversationId: s.target.conversation.id } })).toBe(0);
    expect(await db.dataErasureRequest.count({ where: { businessId: s.business.id, customerId: s.target.customer.id } })).toBe(1);
  });
});
