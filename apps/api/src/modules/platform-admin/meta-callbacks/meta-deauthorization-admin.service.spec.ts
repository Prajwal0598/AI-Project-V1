import { BadRequestException, ConflictException, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { MetaDeauthorizationAdminService } from "./meta-deauthorization-admin.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

const REQUEST_ID = "ckreq00000000000001";
const BIZ_A = "ckbizAAAAAAAAAAAA1";
const BIZ_B = "ckbizBBBBBBBBBBBB2";
const ACTOR = "user-platform-admin";
const FB_USER = "1000000000000001";
const EVENT_AT = new Date("2026-10-26T10:00:00Z");

describe("MetaDeauthorizationAdminService", () => {
  const ORIGINAL_ENV = { ...process.env };
  let prisma: any;
  let meta: { deauthorize: jest.Mock };
  let service: MetaDeauthorizationAdminService;
  let logged: string[];

  const requestRow = (over: Record<string, unknown> = {}) => ({
    id: REQUEST_ID, kind: "DEAUTHORIZATION", status: "NO_ACTION_UNVERIFIED", matchedBusinessIds: [], connectionsRevoked: 0, resolvedByUserId: null,
    resolutionReference: null, verificationMethod: null, resolutionReason: null, createdAt: EVENT_AT, updatedAt: EVENT_AT, completedAt: null, metaUserId: FB_USER, ...over,
  });
  const business = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Shop ${id.slice(5, 6)}`, whatsappConnectionStatus: "CONNECTED", whatsappConnectedAt: new Date("2026-10-01T00:00:00Z"), ...over });

  const disconnectDto = (over: Record<string, unknown> = {}) => ({
    outcome: "DISCONNECT_VERIFIED" as const, businessIds: [BIZ_A], verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" as const,
    resolutionReference: "TICKET-201", confirm: `DISCONNECT_VERIFIED ${REQUEST_ID}`, ...over,
  });
  const noChangeDto = (over: Record<string, unknown> = {}) => ({
    outcome: "NO_CHANGE" as const, verificationMethod: "RECORDS_REVIEW" as const, resolutionReference: "TICKET-202", reason: "IDENTITY_NOT_ESTABLISHED" as const,
    confirm: `NO_CHANGE ${REQUEST_ID}`, ...over,
  });

  /** Both businesses are candidates and linked to the account; business A holds a real encrypted token. */
  function arrangeCandidates(over: { businesses?: unknown[]; links?: string[]; request?: Record<string, unknown> } = {}) {
    prisma.metaCallbackRequest.findFirst.mockResolvedValue(requestRow(over.request));
    prisma.metaCallbackEvent.findFirst.mockResolvedValue({ detail: { reason: "IDENTITY_MATCH_UNVERIFIED", candidateBusinessIds: [BIZ_A, BIZ_B] } });
    prisma.business.findMany.mockResolvedValue(over.businesses ?? [business(BIZ_A), business(BIZ_B)]);
    prisma.metaUserLink.findMany.mockResolvedValue((over.links ?? [BIZ_A, BIZ_B]).map((businessId) => ({ businessId })));
    prisma.business.findUnique.mockResolvedValue({ whatsappBusinessAccountId: "waba-1", whatsappAccessTokenEncrypted: encryptSecret("EAAG_business_token") });
    prisma.business.updateMany.mockResolvedValue({ count: 1 });
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) };
    prisma = {
      metaCallbackRequest: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      metaCallbackEvent: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({}) },
      metaUserLink: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      business: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), updateMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
    meta = { deauthorize: jest.fn().mockResolvedValue(undefined) };
    service = new MetaDeauthorizationAdminService(prisma as unknown as PrismaService, meta as unknown as MetaGraphApiService);

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
    expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(meta.deauthorize).not.toHaveBeenCalled();
  };

  describe("list and get", () => {
    it("lists only deauthorization events, defaulting to those awaiting review, and never selects the Facebook user id", async () => {
      await service.list({});

      const args = prisma.metaCallbackRequest.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ kind: "DEAUTHORIZATION", status: "NO_ACTION_UNVERIFIED" });
      expect(args.take).toBe(25);
      expect(args.select).not.toHaveProperty("metaUserId");
      expect(args.select).not.toHaveProperty("confirmationCode");
    });

    it("honours an explicit status and take", async () => {
      await service.list({ status: "NO_CHANGE_RECORDED", take: 5 });
      expect(prisma.metaCallbackRequest.findMany.mock.calls[0][0]).toMatchObject({ where: { kind: "DEAUTHORIZATION", status: "NO_CHANGE_RECORDED" }, take: 5 });
    });

    it("returns one deauthorization event with its history, without the user id", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue({ id: REQUEST_ID, events: [] });
      await expect(service.get(REQUEST_ID)).resolves.toEqual({ id: REQUEST_ID, events: [] });
      const args = prisma.metaCallbackRequest.findFirst.mock.calls[0][0];
      expect(args.where).toEqual({ id: REQUEST_ID, kind: "DEAUTHORIZATION" });
      expect(args.select).not.toHaveProperty("metaUserId");
    });

    it("returns the audit history in lifecycle order when every event has the same timestamp, whatever order the database returned them in", async () => {
      const stamp = new Date("2026-10-26T10:00:00.000Z");
      const scrambled = ["RESOLVED", "RECEIVED", "PROCESSED"].map((action, i) => ({ id: `evt-${["a", "z", "m"][i]}`, action, createdAt: stamp, detail: null }));
      prisma.metaCallbackRequest.findFirst.mockResolvedValue({ id: REQUEST_ID, status: "COMPLETED", events: scrambled });

      const result = await service.get(REQUEST_ID);

      expect(result).toMatchObject({ id: REQUEST_ID, status: "COMPLETED" });
      expect(result.events.map((e: { action: string }) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    });

    it("answers 404 for an unknown id, a data-deletion request, or a malformed id, without querying for the malformed one", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(null);
      await expect(service.get(REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
      prisma.metaCallbackRequest.findFirst.mockClear();
      await expect(service.get("../etc/passwd")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.metaCallbackRequest.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("previewResolution", () => {
    it("shows every candidate with its state and the exact confirmation text, and writes nothing", async () => {
      arrangeCandidates();

      const preview = await service.previewResolution(REQUEST_ID, { outcome: "DISCONNECT_VERIFIED", businessIds: [BIZ_A] });

      expect(preview).toMatchObject({ dryRun: true, requestId: REQUEST_ID, outcome: "DISCONNECT_VERIFIED", confirmationRequired: `DISCONNECT_VERIFIED ${REQUEST_ID}`, warnings: [] });
      expect(preview.candidates).toEqual([
        { id: BIZ_A, name: "Shop A", connectionStatus: "CONNECTED", stillLinked: true, connectedAfterEvent: false, eligibleToDisconnect: true, wouldDisconnect: true },
        { id: BIZ_B, name: "Shop B", connectionStatus: "CONNECTED", stillLinked: true, connectedAfterEvent: false, eligibleToDisconnect: true, wouldDisconnect: false },
      ]);
      expect(JSON.stringify(preview)).not.toContain(FB_USER);
      expectNoWrites();
    });

    it("lists candidates even for NO_CHANGE, and none would disconnect", async () => {
      arrangeCandidates();
      const preview = await service.previewResolution(REQUEST_ID, { outcome: "NO_CHANGE" });
      expect(preview.candidates.every((c) => c.wouldDisconnect === false)).toBe(true);
      expect(preview.proposedAction).toMatch(/Change nothing/);
      expectNoWrites();
    });

    it("warns about a named business that is not a candidate, without saying whether it exists", async () => {
      arrangeCandidates();
      const preview = await service.previewResolution(REQUEST_ID, { outcome: "DISCONNECT_VERIFIED", businessIds: ["ckotherbusiness00001"] });
      expect(preview.warnings).toEqual([expect.objectContaining({ code: "NOT_A_CANDIDATE" })]);
      expect(prisma.business.findMany.mock.calls[0][0].where).toEqual({ id: { in: [BIZ_A, BIZ_B] } });
    });

    it("warns when a candidate is no longer linked, was reconnected after the event, or the identifier was deleted", async () => {
      arrangeCandidates({ links: [BIZ_B], businesses: [business(BIZ_A), business(BIZ_B, { whatsappConnectedAt: new Date("2026-10-27T00:00:00Z") })] });
      const preview = await service.previewResolution(REQUEST_ID, { outcome: "DISCONNECT_VERIFIED", businessIds: [BIZ_A, BIZ_B] });
      expect(preview.warnings.map((w) => w.code)).toEqual(["LINK_NO_LONGER_ACTIVE", "RECONNECTED_AFTER_EVENT"]);
      expect(preview.candidates.map((c) => c.eligibleToDisconnect)).toEqual([false, false]);

      arrangeCandidates({ request: { metaUserId: null } });
      expect((await service.previewResolution(REQUEST_ID, { outcome: "NO_CHANGE" })).warnings.map((w) => w.code)).toContain("IDENTIFIER_DELETED");
    });

    it("warns when the event is no longer awaiting review", async () => {
      arrangeCandidates({ request: { status: "COMPLETED" } });
      expect((await service.previewResolution(REQUEST_ID, { outcome: "NO_CHANGE" })).warnings.map((w) => w.code)).toContain("NOT_AWAITING_REVIEW");
    });

    it.each([
      ["DISCONNECT_VERIFIED with no business", { outcome: "DISCONNECT_VERIFIED" as const }],
      ["DISCONNECT_VERIFIED with an empty list", { outcome: "DISCONNECT_VERIFIED" as const, businessIds: [] }],
      ["NO_CHANGE naming a business", { outcome: "NO_CHANGE" as const, businessIds: [BIZ_A] }],
    ])("rejects %s with 400", async (_label, dto) => {
      arrangeCandidates();
      await expect(service.previewResolution(REQUEST_ID, dto)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("answers 404 for a data-deletion request or an unknown event", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(null);
      await expect(service.previewResolution(REQUEST_ID, { outcome: "NO_CHANGE" })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.metaCallbackRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQUEST_ID, kind: "DEAUTHORIZATION" });
    });
  });

  describe("resolve: DISCONNECT_VERIFIED", () => {
    it("disconnects only the named business, revokes only its link, records the audit event, and unsubscribes after commit", async () => {
      arrangeCandidates();

      const result = await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);

      expect(prisma.metaCallbackRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, kind: "DEAUTHORIZATION", status: "NO_ACTION_UNVERIFIED" },
        data: { resolvedByUserId: ACTOR, resolutionReference: "TICKET-201", verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", resolutionReason: null },
      });
      expect(prisma.business.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.business.updateMany.mock.calls[0][0].where.id).toBe(BIZ_A);
      expect(prisma.business.updateMany.mock.calls[0][0].data).toMatchObject({ whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null });
      expect(prisma.metaUserLink.updateMany).toHaveBeenCalledWith({ where: { metaUserId: FB_USER, businessId: { in: [BIZ_A] }, revokedAt: null }, data: expect.objectContaining({ revokedReason: "DEAUTHORIZED" }) });
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: REQUEST_ID }, data: expect.objectContaining({ status: "COMPLETED", matchedBusinessIds: [BIZ_A], connectionsRevoked: 1 }) });
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ requestId: REQUEST_ID, action: "RESOLVED", fromStatus: "NO_ACTION_UNVERIFIED", toStatus: "COMPLETED", actorUserId: ACTOR, detail: expect.objectContaining({ outcome: "DISCONNECT_VERIFIED", businessIds: [BIZ_A], connectionsRevoked: 1, resolutionReference: "TICKET-201" }) }),
      });
      expect(meta.deauthorize).toHaveBeenCalledWith("waba-1", "EAAG_business_token");
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(meta.deauthorize.mock.invocationCallOrder[0]);
      expect(result).toMatchObject({ requestId: REQUEST_ID, alreadyResolved: false });
    });

    it("locks the named business rows before checking them", async () => {
      arrangeCandidates();
      await service.resolve(REQUEST_ID, disconnectDto({ businessIds: [BIZ_B, BIZ_A] }), ACTOR);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.business.findMany.mock.invocationCallOrder[0]);
    });

    it("never disconnects a business merely because it is a candidate: an unnamed candidate is not touched", async () => {
      arrangeCandidates();
      await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);
      for (const call of prisma.business.updateMany.mock.calls) expect(call[0].where.id).not.toBe(BIZ_B);
      for (const call of prisma.business.findUnique.mock.calls) expect(call[0].where.id).not.toBe(BIZ_B);
    });

    it("answers 404 for a business that is not a candidate of this event (unknown and other tenants alike), and changes nothing", async () => {
      arrangeCandidates();
      await expect(service.resolve(REQUEST_ID, disconnectDto({ businessIds: ["ckotherbusiness00001"] }), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolve(REQUEST_ID, disconnectDto({ businessIds: [BIZ_A, "ckunknownbusiness001"] }), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it.each([
      ["a candidate whose link to the account is no longer active", { links: [BIZ_B] }],
      ["a candidate reconnected after the event was received", { businesses: [business(BIZ_A, { whatsappConnectedAt: new Date("2026-10-27T00:00:00Z") }), business(BIZ_B)] }],
      ["an event whose Facebook identifier was deleted", { request: { metaUserId: null } }],
    ])("answers 409 and changes nothing for %s", async (_label, over) => {
      arrangeCandidates(over);
      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      ["no businesses", { businessIds: [] }],
      ["a reason", { reason: "IDENTITY_NOT_ESTABLISHED" }],
      ["a verification method that only reads our own records", { verificationMethod: "RECORDS_REVIEW" }],
    ])("rejects DISCONNECT_VERIFIED with %s (400) before anything is read for writing", async (_label, over) => {
      arrangeCandidates();
      await expect(service.resolve(REQUEST_ID, disconnectDto(over), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("an already-disconnected business is left alone but the event is still closed with zero connections revoked", async () => {
      arrangeCandidates({ businesses: [business(BIZ_A, { whatsappConnectionStatus: "DISCONNECTED" }), business(BIZ_B)] });
      prisma.business.updateMany.mockResolvedValue({ count: 0 });

      await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);

      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: REQUEST_ID }, data: expect.objectContaining({ status: "COMPLETED", connectionsRevoked: 0 }) });
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("still succeeds and keeps the local revocation when Meta's unsubscribe fails", async () => {
      arrangeCandidates();
      meta.deauthorize.mockRejectedValue(new Error("Meta unreachable"));
      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: false });
    });

    it("answers 500 and never unsubscribes when the transaction fails", async () => {
      arrangeCandidates();
      prisma.business.updateMany.mockRejectedValue(new Error("database down"));
      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });
  });

  describe("resolve: NO_CHANGE", () => {
    it("records the documented reason and changes no business, connection or link", async () => {
      arrangeCandidates();

      const result = await service.resolve(REQUEST_ID, noChangeDto(), ACTOR);

      expect(prisma.metaCallbackRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, kind: "DEAUTHORIZATION", status: "NO_ACTION_UNVERIFIED" },
        data: { resolvedByUserId: ACTOR, resolutionReference: "TICKET-202", verificationMethod: "RECORDS_REVIEW", resolutionReason: "IDENTITY_NOT_ESTABLISHED" },
      });
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: REQUEST_ID }, data: expect.objectContaining({ status: "NO_CHANGE_RECORDED", matchedBusinessIds: [], connectionsRevoked: 0 }) });
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ toStatus: "NO_CHANGE_RECORDED", actorUserId: ACTOR, detail: expect.objectContaining({ outcome: "NO_CHANGE", reason: "IDENTITY_NOT_ESTABLISHED", connectionsRevoked: 0 }) }) });
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.business.findUnique).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(result).toMatchObject({ alreadyResolved: false });
    });

    it.each([
      ["no reason", { reason: undefined }],
      ["a named business", { businessIds: [BIZ_A] }],
    ])("rejects NO_CHANGE with %s (400)", async (_label, over) => {
      arrangeCandidates();
      await expect(service.resolve(REQUEST_ID, noChangeDto(over), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("accepts any recorded verification method for a no-change closure", async () => {
      for (const verificationMethod of ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS", "RECORDS_REVIEW"] as const) {
        arrangeCandidates();
        await expect(service.resolve(REQUEST_ID, noChangeDto({ verificationMethod }), ACTOR)).resolves.toBeDefined();
      }
    });
  });

  describe("confirmation and routing", () => {
    it.each([
      ["a wrong phrase", "RESOLVE"],
      ["the other outcome's phrase", `NO_CHANGE ${REQUEST_ID}`],
      ["another request's id", "DISCONNECT_VERIFIED ckanotherrequest0001"],
      ["an empty phrase", ""],
    ])("requires the exact confirmation: %s is rejected with 400 and nothing changes", async (_label, confirm) => {
      arrangeCandidates();
      await expect(service.resolve(REQUEST_ID, disconnectDto({ confirm }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites();
    });

    it("never resolves a data-deletion request (404 from the deauthorization lookup)", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(null);
      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.metaCallbackRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQUEST_ID, kind: "DEAUTHORIZATION" });
      expectNoWrites();
    });

    it("answers 404 for a malformed id without querying", async () => {
      await expect(service.resolve("../x", disconnectDto(), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.metaCallbackRequest.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("idempotency and concurrency", () => {
    const resolvedDisconnect = (over: Record<string, unknown> = {}) => requestRow({ status: "COMPLETED", matchedBusinessIds: [BIZ_A], connectionsRevoked: 1, resolutionReference: "TICKET-201", verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", completedAt: EVENT_AT, ...over });
    const resolvedNoChange = (over: Record<string, unknown> = {}) => requestRow({ status: "NO_CHANGE_RECORDED", resolutionReference: "TICKET-202", resolutionReason: "IDENTITY_NOT_ESTABLISHED", verificationMethod: "RECORDS_REVIEW", completedAt: EVENT_AT, ...over });

    it("a repeat with the same reference returns the existing outcome and repeats no side effect", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedDisconnect());
      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED", matchedBusinessIds: [BIZ_A], connectionsRevoked: 1 });

      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedNoChange());
      await expect(service.resolve(REQUEST_ID, noChangeDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "NO_CHANGE_RECORDED", resolutionReason: "IDENTITY_NOT_ESTABLISHED" });
      expectNoWrites();
    });

    it("ignores the order of business ids on a replay", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedDisconnect({ matchedBusinessIds: [BIZ_A, BIZ_B] }));
      await expect(service.resolve(REQUEST_ID, disconnectDto({ businessIds: [BIZ_B, BIZ_A] }), ACTOR)).resolves.toMatchObject({ alreadyResolved: true });
    });

    it.each([
      ["a different reference", disconnectDto({ resolutionReference: "TICKET-OTHER" })],
      ["a different business set", disconnectDto({ businessIds: [BIZ_B] })],
      ["a different verification method", disconnectDto({ verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" })],
      ["a different outcome", noChangeDto({ resolutionReference: "TICKET-201" })],
    ])("a retry with %s conflicts (409) and repeats no side effect", async (_label, dto) => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedDisconnect());
      await expect(service.resolve(REQUEST_ID, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it("a no-change retry with a different reason conflicts", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedNoChange());
      await expect(service.resolve(REQUEST_ID, noChangeDto({ reason: "MERCHANT_CONFIRMED_KEEP_CONNECTED" }), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it.each(["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS"] as const)("a no-change retry with the different verification method %s conflicts and repeats no side effect", async (verificationMethod) => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(resolvedNoChange());
      await expect(service.resolve(REQUEST_ID, noChangeDto({ verificationMethod }), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it("an identical retry returns exactly the stored result and claims or writes nothing", async () => {
      const stored = resolvedDisconnect({ completedAt: new Date("2026-10-26T11:00:00Z") });
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(stored);

      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).resolves.toEqual({
        requestId: REQUEST_ID, status: "COMPLETED", alreadyResolved: true, matchedBusinessIds: [BIZ_A], connectionsRevoked: 1, resolutionReason: null, completedAt: stored.completedAt,
      });
      expectNoWrites();
    });

    it("an event closed some other way (for example by the automatic path) conflicts rather than replays", async () => {
      prisma.metaCallbackRequest.findFirst.mockResolvedValue(requestRow({ status: "NO_MATCH" }));
      await expect(service.resolve(REQUEST_ID, noChangeDto(), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expectNoWrites();
    });

    it("the loser of a simultaneous resolution that used the same reference gets the winner's outcome, with no second revocation", async () => {
      arrangeCandidates();
      prisma.metaCallbackRequest.updateMany.mockResolvedValue({ count: 0 }); // the claim lost the race
      prisma.metaCallbackRequest.findFirst.mockResolvedValueOnce(requestRow()).mockResolvedValue(resolvedDisconnect());

      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED" });

      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
    });

    it("the loser of a simultaneous resolution with a different reference conflicts", async () => {
      arrangeCandidates();
      prisma.metaCallbackRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.metaCallbackRequest.findFirst.mockResolvedValueOnce(requestRow()).mockResolvedValue(resolvedDisconnect({ resolutionReference: "TICKET-WINNER" }));

      await expect(service.resolve(REQUEST_ID, disconnectDto(), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("the loser of a simultaneous resolution with the same reference but a different verification method conflicts", async () => {
      arrangeCandidates();
      prisma.metaCallbackRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.metaCallbackRequest.findFirst.mockResolvedValueOnce(requestRow()).mockResolvedValue(resolvedDisconnect());

      await expect(service.resolve(REQUEST_ID, disconnectDto({ verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" }), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaCallbackEvent.create).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });
  });

  describe("safety", () => {
    it("never deletes a business, customer, conversation, order or request, and only touches the tables it needs", async () => {
      arrangeCandidates();
      await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);
      expect(Object.keys(prisma).sort()).toEqual(["$queryRaw", "$transaction", "business", "metaCallbackEvent", "metaCallbackRequest", "metaUserLink"]);
      for (const model of ["business", "metaCallbackRequest", "metaCallbackEvent", "metaUserLink"]) {
        expect(prisma[model].delete).toBeUndefined();
        expect(prisma[model].deleteMany).toBeUndefined();
      }
    });

    it("never logs the Facebook user id, the token, the confirmation text or the reference", async () => {
      arrangeCandidates();
      await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);
      arrangeCandidates();
      prisma.business.updateMany.mockRejectedValue(new Error(`boom ${FB_USER}`));
      await service.resolve(REQUEST_ID, disconnectDto({ resolutionReference: "TICKET-203" }), ACTOR).catch(() => undefined);

      const output = logged.join("\n");
      for (const secret of [FB_USER, "EAAG_business_token", `DISCONNECT_VERIFIED ${REQUEST_ID}`, "TICKET-201", "TICKET-203"]) expect(output).not.toContain(secret);
    });

    it("never returns the Facebook user id from preview or resolve", async () => {
      arrangeCandidates();
      const preview = await service.previewResolution(REQUEST_ID, { outcome: "DISCONNECT_VERIFIED", businessIds: [BIZ_A] });
      arrangeCandidates();
      const result = await service.resolve(REQUEST_ID, disconnectDto(), ACTOR);
      expect(JSON.stringify([preview, result])).not.toContain(FB_USER);
    });
  });
});
