import { BadRequestException, ConflictException, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DataErasureService, ERASED_CUSTOMER_LABEL, STALE_IN_PROGRESS_MS } from "./data-erasure.service";
import type { ExecuteErasureDto } from "./data-erasure.dto";
import type { PrismaService } from "../../../database/prisma.service";

const BUSINESS = "biz_aaaaaaaaaa";
const OTHER_BUSINESS = "biz_bbbbbbbbbb";
const CUSTOMER = "cus_aaaaaaaaaa";
const ADMIN = "adm_aaaaaaaaaa";

const dto = (over: Partial<ExecuteErasureDto> = {}): ExecuteErasureDto => ({
  businessId: BUSINESS, customerId: CUSTOMER, requestReference: "TICKET-1042", requestedBy: "CUSTOMER",
  verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS", confirm: `ERASE ${CUSTOMER}`, ...over,
});

function makePrisma() {
  const model = () => ({
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  });
  const prisma: any = {
    customer: { findFirst: jest.fn().mockResolvedValue({ id: CUSTOMER }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), delete: jest.fn(), deleteMany: jest.fn() },
    order: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 0 }), delete: jest.fn(), deleteMany: jest.fn() },
    conversation: model(), identity: model(), message: model(), cart: model(), cartItem: model(), customerSignal: model(),
    opportunity: model(), suggestion: model(), activityEvent: model(), aiActionLog: model(), leadScore: model(),
    dataErasureRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "req_1" }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  return prisma;
}

/** Nothing was written, deleted or started in a transaction. */
function expectNoWrites(prisma: any) {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  for (const [name, delegate] of Object.entries<any>(prisma)) {
    if (name === "$transaction") continue;
    for (const op of ["create", "update", "updateMany", "delete", "deleteMany"]) {
      if (delegate[op]) expect({ model: name, op, calls: delegate[op].mock.calls.length }).toEqual({ model: name, op, calls: 0 });
    }
  }
}

describe("DataErasureService", () => {
  let prisma: any;
  let service: DataErasureService;
  // order.count is used for both "all orders" and "open orders" (the latter filters on status)
  const orderCounts = (total: number, open = 0) => prisma.order.count.mockImplementation(async ({ where }: any) => (where.status ? open : total));

  beforeEach(() => {
    prisma = makePrisma();
    service = new DataErasureService(prisma as unknown as PrismaService);
  });

  describe("preview() — dry run", () => {
    it("reports what would be erased and retained, and writes nothing", async () => {
      prisma.conversation.findMany.mockResolvedValue([{ id: "conv_1" }]);
      prisma.identity.count.mockResolvedValue(1);
      prisma.message.count.mockResolvedValue(12);
      orderCounts(2);

      const report = await service.preview({ businessId: BUSINESS, customerId: CUSTOMER });

      expect(report).toMatchObject({ dryRun: true, confirmationRequired: `ERASE ${CUSTOMER}`, warnings: [] });
      expect(report.counts).toMatchObject({ identities: 1, conversations: 1, messages: 12, ordersRetained: 2 });
      expect(report.retainedRecords.orders).toBe(2);
      expectNoWrites(prisma);
    });

    it("scopes every count to the merchant, so another merchant's rows can never be counted", async () => {
      prisma.conversation.findMany.mockResolvedValue([{ id: "conv_1" }]);
      await service.preview({ businessId: BUSINESS, customerId: CUSTOMER });

      const counted = ["identity", "message", "cart", "cartItem", "customerSignal", "opportunity", "suggestion", "activityEvent", "aiActionLog", "leadScore", "order"];
      for (const name of counted) {
        for (const [args] of prisma[name].count.mock.calls) {
          expect({ model: name, scoped: JSON.stringify(args.where).includes(BUSINESS) }).toEqual({ model: name, scoped: true });
        }
      }
      expect(prisma.conversation.findMany).toHaveBeenCalledWith({ where: { businessId: BUSINESS, customerId: CUSTOMER }, select: { id: true } });
    });

    it("warns about open orders, whose delivery address erasure would remove", async () => {
      orderCounts(1, 1);
      const report = await service.preview({ businessId: BUSINESS, customerId: CUSTOMER });
      expect(report.warnings).toEqual([expect.objectContaining({ code: "OPEN_ORDERS", count: 1 })]);
    });

    it("states the backup lifecycle and the processors it cannot reach", async () => {
      const report = await service.preview({ businessId: BUSINESS, customerId: CUSTOMER });
      expect(report.externalProcessing.join("\n")).toMatch(/backups[\s\S]*14 days/i);
      expect(report.externalProcessing.join("\n")).toMatch(/Meta[\s\S]*OpenAI[\s\S]*Postmark[\s\S]*Razorpay[\s\S]*Railway and Sentry/);
    });
  });

  describe("merchant isolation", () => {
    it("treats a customer that belongs to another merchant as not found, and changes nothing", async () => {
      prisma.customer.findFirst.mockResolvedValue(null); // the lookup is by BOTH id and businessId

      await expect(service.preview({ businessId: OTHER_BUSINESS, customerId: CUSTOMER })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.execute(dto({ businessId: OTHER_BUSINESS }), ADMIN)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.customer.findFirst).toHaveBeenCalledWith({ where: { id: CUSTOMER, businessId: OTHER_BUSINESS }, select: { id: true } });
      expectNoWrites(prisma);
      expect(prisma.order.count).not.toHaveBeenCalled();
    });

    it("scopes every destructive statement to the merchant and the customer", async () => {
      prisma.conversation.findMany.mockResolvedValue([{ id: "conv_1" }]);
      await service.execute(dto(), ADMIN);

      for (const name of ["opportunity", "customerSignal", "activityEvent", "cart", "conversation", "identity"]) {
        expect(prisma[name].deleteMany).toHaveBeenCalledWith({ where: { businessId: BUSINESS, customerId: CUSTOMER } });
      }
      expect(prisma.leadScore.deleteMany).toHaveBeenCalledWith({ where: { customerId: CUSTOMER, customer: { businessId: BUSINESS } } });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({ where: { businessId: BUSINESS, customerId: CUSTOMER }, data: { shippingAddress: Prisma.DbNull } });
      expect(prisma.customer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CUSTOMER, businessId: BUSINESS } }));
      expect(prisma.aiActionLog.updateMany).toHaveBeenCalledWith({
        where: { businessId: BUSINESS, OR: [{ customerId: CUSTOMER }, { conversationId: { in: ["conv_1"] } }] },
        data: { customerId: null, conversationId: null, reason: null },
      });
    });
  });

  describe("execute() — guards before anything is touched", () => {
    it("refuses without the exact confirmation text", async () => {
      await expect(service.execute(dto({ confirm: "yes" }), ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.execute(dto({ confirm: "ERASE cus_bbbbbbbbbb" }), ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      expectNoWrites(prisma);
    });

    it("refuses while the customer has open orders unless the operator acknowledges it", async () => {
      orderCounts(1, 1);
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites(prisma);

      await expect(service.execute(dto({ acknowledgeOpenOrders: true }), ADMIN)).resolves.toMatchObject({ status: "COMPLETED" });
    });
  });

  describe("execute() — what an erasure does", () => {
    it("anonymises the customer and keeps the order and payment records", async () => {
      orderCounts(3);
      prisma.opportunity.deleteMany.mockResolvedValue({ count: 2 });
      prisma.conversation.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.execute(dto(), ADMIN);

      expect(prisma.customer.updateMany).toHaveBeenCalledWith({
        where: { id: CUSTOMER, businessId: BUSINESS },
        data: { firstName: ERASED_CUSTOMER_LABEL, lastName: null, email: null, phone: null, tags: [], proactiveMessagingOptOut: true },
      });
      // retained: nothing may delete an order, the customer row (orders cascade from it), or any payment field
      for (const fn of [prisma.order.delete, prisma.order.deleteMany, prisma.customer.delete, prisma.customer.deleteMany]) expect(fn).not.toHaveBeenCalled();
      expect(prisma.order.updateMany.mock.calls[0][0].data).toEqual({ shippingAddress: Prisma.DbNull });
      expect(result).toMatchObject({ status: "COMPLETED", alreadyCompleted: false, counts: { opportunities: 2, conversations: 1, ordersRetained: 3 } });
      expect(result.retainedRecords.orders).toBe(3);
    });

    it("writes an audit record that holds identifiers and counts only", async () => {
      await service.execute(dto(), ADMIN);

      expect(prisma.dataErasureRequest.create).toHaveBeenCalledWith({
        data: { businessId: BUSINESS, customerId: CUSTOMER, requestReference: "TICKET-1042", requestedBy: "CUSTOMER", verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS", status: "IN_PROGRESS", executedByUserId: ADMIN },
      });
      const completed = prisma.dataErasureRequest.update.mock.calls[0][0];
      expect(completed.where).toEqual({ id: "req_1" });
      expect(completed.data.status).toBe("COMPLETED");
      expect(Object.values(completed.data.counts).every((n) => typeof n === "number")).toBe(true);
    });

    it("commits the audit record and the erasure in one transaction", async () => {
      await service.execute(dto(), ADMIN);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: expect.any(Number) }));
    });
  });

  describe("execute() — idempotency and retries", () => {
    it("returns a completed request unchanged on repeat, without touching any data", async () => {
      prisma.dataErasureRequest.findUnique.mockResolvedValue({ id: "req_1", status: "COMPLETED", counts: { ordersRetained: 2, messages: 9 }, updatedAt: new Date() });

      const result = await service.execute(dto(), ADMIN);

      expect(result).toMatchObject({ requestId: "req_1", alreadyCompleted: true, counts: { messages: 9 } });
      expectNoWrites(prisma);
    });

    it("retries a FAILED request, taking it over with a compare-and-swap on updatedAt", async () => {
      const updatedAt = new Date("2026-10-01T00:00:00Z");
      prisma.dataErasureRequest.findUnique.mockResolvedValue({ id: "req_9", status: "FAILED", updatedAt });

      const result = await service.execute(dto(), ADMIN);

      expect(prisma.dataErasureRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "req_9", status: "FAILED", updatedAt } }));
      expect(prisma.dataErasureRequest.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ requestId: "req_9", status: "COMPLETED" });
    });

    it("refuses a request another process is running right now", async () => {
      prisma.dataErasureRequest.findUnique.mockResolvedValue({ id: "req_2", status: "IN_PROGRESS", updatedAt: new Date() });
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites(prisma);
    });

    it("takes over an IN_PROGRESS request abandoned by a crashed process", async () => {
      prisma.dataErasureRequest.findUnique.mockResolvedValue({ id: "req_3", status: "IN_PROGRESS", updatedAt: new Date(Date.now() - STALE_IN_PROGRESS_MS - 1000) });
      await expect(service.execute(dto(), ADMIN)).resolves.toMatchObject({ requestId: "req_3", status: "COMPLETED" });
    });

    it("lets exactly one of two simultaneous retries win", async () => {
      prisma.dataErasureRequest.findUnique.mockResolvedValue({ id: "req_4", status: "FAILED", updatedAt: new Date() });
      prisma.dataErasureRequest.updateMany.mockResolvedValueOnce({ count: 0 }); // somebody else took it first
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("turns a duplicate create (unique constraint) into a conflict", async () => {
      prisma.dataErasureRequest.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }));
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("execute() — partial failure", () => {
    it("rolls back, marks the request FAILED with the error class only, and leaks no detail", async () => {
      prisma.$transaction.mockRejectedValue(new Error("deadlock while deleting for Asha +919876543210"));

      const error = await service.execute(dto(), ADMIN).catch((e) => e);

      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify(error.getResponse())).not.toMatch(/Asha|9876543210|deadlock/);
      expect(prisma.dataErasureRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "req_1", status: "IN_PROGRESS" },
        data: { status: "FAILED", failureReason: "Error" },
      });
    });

    it("still reports the original failure if marking it FAILED also fails", async () => {
      prisma.$transaction.mockRejectedValue(new Error("boom"));
      prisma.dataErasureRequest.updateMany.mockRejectedValue(new Error("database down"));
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it("fails and rolls back if the customer row disappears mid-erasure", async () => {
      prisma.customer.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.execute(dto(), ADMIN)).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.dataErasureRequest.update).not.toHaveBeenCalled(); // never recorded as COMPLETED
    });
  });
});
