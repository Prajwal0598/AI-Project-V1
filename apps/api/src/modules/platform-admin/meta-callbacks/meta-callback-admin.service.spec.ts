import { BadRequestException, ConflictException, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { MetaCallbackAdminService } from "./meta-callback-admin.service";
import { STATUS_MESSAGES } from "../../integrations/meta-callbacks/meta-callbacks.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

const REQUEST_ID = "ckrequest00000000001";
const CODE = "a".repeat(32);
const BIZ_A = "ckbizAAAAAAAAAAAA1";
const BIZ_B = "ckbizBBBBBBBBBBBB2";
const ACTOR = "user-platform-admin";
const FB_USER = "1000000000000001";
const DONE_AT = new Date("2026-10-26T11:00:00Z");

// Unit tests for the replay and conflict rules of data-deletion resolution; the transaction itself is covered against real PostgreSQL.
describe("MetaCallbackAdminService.resolve (idempotency)", () => {
  const ORIGINAL_ENV = { ...process.env };
  let prisma: any;
  let meta: { deauthorize: jest.Mock };
  let service: MetaCallbackAdminService;
  let logged: string[];

  const row = (over: Record<string, unknown> = {}) => ({
    id: REQUEST_ID, kind: "DATA_DELETION", status: "PENDING_REVIEW", confirmationCode: CODE, metaUserId: FB_USER, matchedBusinessIds: [], connectionsRevoked: 0,
    resolvedByUserId: null, resolutionReference: null, verificationMethod: null, createdAt: DONE_AT, updatedAt: DONE_AT, completedAt: null, ...over,
  });
  const resolvedCompleted = (over: Record<string, unknown> = {}) => row({
    status: "COMPLETED", metaUserId: null, matchedBusinessIds: [BIZ_A], connectionsRevoked: 1, resolvedByUserId: ACTOR, resolutionReference: "TICKET-101",
    verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", completedAt: DONE_AT, ...over,
  });
  const resolvedNoDataHeld = (over: Record<string, unknown> = {}) => row({
    status: "NO_DATA_HELD", metaUserId: null, resolvedByUserId: ACTOR, resolutionReference: "TICKET-102", verificationMethod: "RECORDS_SEARCH_NO_MATCH", completedAt: DONE_AT, ...over,
  });

  const completedDto = (over: Record<string, unknown> = {}) => ({
    outcome: "COMPLETED" as const, businessIds: [BIZ_A], verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" as const, resolutionReference: "TICKET-101", confirm: `RESOLVE ${CODE}`, ...over,
  });
  const noDataHeldDto = (over: Record<string, unknown> = {}) => ({
    outcome: "NO_DATA_HELD" as const, verificationMethod: "RECORDS_SEARCH_NO_MATCH" as const, resolutionReference: "TICKET-102", confirm: `RESOLVE ${CODE}`, ...over,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) };
    prisma = {
      metaCallbackRequest: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      metaCallbackEvent: { create: jest.fn().mockResolvedValue({}) },
      metaUserLink: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      business: { count: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length), findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
    meta = { deauthorize: jest.fn().mockResolvedValue(undefined) };
    service = new MetaCallbackAdminService(prisma as unknown as PrismaService, meta as unknown as MetaGraphApiService);

    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { process.env = ORIGINAL_ENV; });

  const expectNoWrites = () => {
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.metaCallbackRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.metaCallbackRequest.update).not.toHaveBeenCalled();
    expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
    expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(meta.deauthorize).not.toHaveBeenCalled();
  };

  describe("identical retries", () => {
    it("COMPLETED: returns exactly the stored result with alreadyResolved true and writes nothing", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedCompleted());

      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).resolves.toEqual({
        requestId: REQUEST_ID, confirmationCode: CODE, status: "COMPLETED", alreadyResolved: true, matchedBusinessIds: [BIZ_A], connectionsRevoked: 1,
        completedAt: DONE_AT, publicStatusMessage: STATUS_MESSAGES.COMPLETED,
      });
      expectNoWrites();
      expect(prisma.business.count).not.toHaveBeenCalled();
    });

    it("NO_DATA_HELD: returns exactly the stored result with alreadyResolved true and writes nothing", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedNoDataHeld());

      await expect(service.resolve(REQUEST_ID, noDataHeldDto(), ACTOR)).resolves.toEqual({
        requestId: REQUEST_ID, confirmationCode: CODE, status: "NO_DATA_HELD", alreadyResolved: true, matchedBusinessIds: [], connectionsRevoked: 0,
        completedAt: DONE_AT, publicStatusMessage: STATUS_MESSAGES.NO_DATA_HELD,
      });
      expectNoWrites();
    });

    it("ignores the order of the named businesses", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedCompleted({ matchedBusinessIds: [BIZ_A, BIZ_B] }));
      await expect(service.resolve(REQUEST_ID, completedDto({ businessIds: [BIZ_B, BIZ_A] }), ACTOR)).resolves.toMatchObject({ alreadyResolved: true });
      expectNoWrites();
    });
  });

  describe("conflicting retries answer 409 and change nothing", () => {
    it.each([
      ["a different reference", completedDto({ resolutionReference: "TICKET-OTHER" })],
      ["a different verification method", completedDto({ verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" })],
      ["a larger business set", completedDto({ businessIds: [BIZ_A, BIZ_B] })],
      ["a different business", completedDto({ businessIds: [BIZ_B] })],
      ["a different outcome", noDataHeldDto({ resolutionReference: "TICKET-101" })],
    ])("a stored COMPLETED resolution retried with %s", async (_label, dto) => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedCompleted());
      await expect(service.resolve(REQUEST_ID, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it.each([
      ["a different reference", noDataHeldDto({ resolutionReference: "TICKET-OTHER" })],
      ["a different outcome naming a business", completedDto({ resolutionReference: "TICKET-102" })],
    ])("a stored NO_DATA_HELD resolution retried with %s", async (_label, dto) => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedNoDataHeld());
      await expect(service.resolve(REQUEST_ID, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it("NO_DATA_HELD has exactly one valid verification method, so another method is invalid input (400), never a replay", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedNoDataHeld());
      await expect(service.resolve(REQUEST_ID, noDataHeldDto({ verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("a request already closed by the automatic path (no reference or method stored) is never replayed", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedCompleted({ resolvedByUserId: null, resolutionReference: null, verificationMethod: null }));
      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it("still requires the exact confirmation text before anything is answered about the stored resolution", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(resolvedCompleted());
      await expect(service.resolve(REQUEST_ID, completedDto({ confirm: "RESOLVE" }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("never resolves a deauthorization record", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row({ kind: "DEAUTHORIZATION", confirmationCode: null }));
      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expectNoWrites();
    });
  });

  describe("simultaneous resolutions (the claim is lost to a winner that has already committed)", () => {
    function loseTheClaim(winner: Record<string, unknown>) {
      prisma.metaCallbackRequest.findUnique.mockResolvedValueOnce(row()).mockResolvedValue(winner);
      prisma.metaCallbackRequest.updateMany.mockResolvedValue({ count: 0 });
    }
    const expectLoserChangedNothing = () => {
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.update).not.toHaveBeenCalled();
      expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    };

    it("a loser with identical inputs gets the winner's stored result", async () => {
      loseTheClaim(resolvedCompleted());
      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED", matchedBusinessIds: [BIZ_A] });
      expectLoserChangedNothing();
    });

    it.each([
      ["a different verification method", completedDto({ verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" })],
      ["a different reference", completedDto({ resolutionReference: "TICKET-OTHER" })],
      ["a different business set", completedDto({ businessIds: [BIZ_A, BIZ_B] })],
      ["a different outcome", noDataHeldDto({ resolutionReference: "TICKET-101" })],
    ])("a loser with %s conflicts", async (_label, dto) => {
      loseTheClaim(resolvedCompleted());
      await expect(service.resolve(REQUEST_ID, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectLoserChangedNothing();
    });
  });

  describe("unchanged protections", () => {
    it("a first resolution still claims the request, disconnects only the named business and records the audit event", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row());
      prisma.business.findUnique.mockResolvedValue({ whatsappBusinessAccountId: "waba-1", whatsappAccessTokenEncrypted: encryptSecret("EAAG_business_token") });

      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: false });

      expect(prisma.metaCallbackRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: "PENDING_REVIEW" },
        data: { resolvedByUserId: ACTOR, resolutionReference: "TICKET-101", verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" },
      });
      expect(prisma.business.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.business.updateMany.mock.calls[0][0].where.id).toBe(BIZ_A);
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "RESOLVED", toStatus: "COMPLETED", actorUserId: ACTOR }) });
      expect(meta.deauthorize).toHaveBeenCalledWith("waba-1", "EAAG_business_token");
    });

    it("an unknown business is a 404 and nothing is written", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row());
      prisma.business.count.mockResolvedValue(0);
      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expectNoWrites();
    });

    it("answers 500 and never unsubscribes when the transaction fails, without logging the Facebook user id or the confirmation code", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row());
      prisma.business.findUnique.mockResolvedValue({ whatsappBusinessAccountId: "waba-1", whatsappAccessTokenEncrypted: encryptSecret("EAAG_business_token") });
      prisma.business.updateMany.mockRejectedValue(new Error(`boom ${FB_USER}`));

      await expect(service.resolve(REQUEST_ID, completedDto(), ACTOR)).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(meta.deauthorize).not.toHaveBeenCalled();
      const output = logged.join("\n");
      for (const secret of [FB_USER, CODE, "EAAG_business_token"]) expect(output).not.toContain(secret);
    });
  });

  describe("get", () => {
    it("returns the audit history in lifecycle order when every event has the same timestamp, whatever order the database returned them in", async () => {
      const stamp = new Date("2026-10-26T10:00:00.000Z");
      const scrambled = ["RESOLVED", "RECEIVED", "PROCESSED"].map((action, i) => ({ id: `evt-${["a", "z", "m"][i]}`, action, createdAt: stamp, detail: null }));
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ ...resolvedCompleted(), events: scrambled });

      const result = await service.get(REQUEST_ID);

      expect(result).toMatchObject({ id: REQUEST_ID, status: "COMPLETED", resolutionReference: "TICKET-101" });
      expect(result.events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    });

    it("answers 404 for an unknown or malformed id", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(null);
      await expect(service.get(REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.get("../etc/passwd")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
