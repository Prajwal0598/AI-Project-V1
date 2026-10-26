import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { MetaCallbackAdminService } from "./meta-callback-admin.service";
import { MetaCallbacksService } from "../../integrations/meta-callbacks/meta-callbacks.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

// Platform-admin resolution of PENDING_REVIEW Meta data-deletion requests against a REAL PostgreSQL.
// Opt-in like the other integration specs: skipped unless INTEGRATION_DATABASE_URL points at a localhost database.
// Runs in a private schema (it_<random>) that is dropped afterwards. Every row is synthetic; only the Graph call is stubbed.

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const PRISMA_CLI = path.join(REPO_ROOT, "packages/database/node_modules/prisma/build/index.js");
const SCHEMA_FILE = path.join(REPO_ROOT, "packages/database/prisma/schema.prisma");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRIVATE_SCHEMA = /^it_[0-9a-f]{16}$/;

function privateSchemaUrl(raw: string, schema: string): string {
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`Refusing to run integration tests against non-local host "${url.hostname}".`);
  for (const param of ["host", "hostaddr"]) if (url.searchParams.has(param)) throw new Error(`Refusing a connection URL that overrides the host with "?${param}=".`);
  url.searchParams.set("schema", schema);
  url.searchParams.set("connection_limit", "16");
  return url.toString();
}

const APP_SECRET = "integration-app-secret-not-real";
const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function signedFor(userId: string, issuedAt = 1_790_000_000): string {
  const encoded = b64u(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: issuedAt, user_id: userId }));
  return `${b64u(createHmac("sha256", APP_SECRET).update(encoded).digest())}.${encoded}`;
}

describeDb("Meta data-deletion admin resolution against PostgreSQL", () => {
  jest.setTimeout(60_000);

  const schema = `it_${randomBytes(8).toString("hex")}`;
  const ORIGINAL_ENV = { ...process.env };
  let localHostConfirmed = false;
  let admin: PrismaClient;
  let db: PrismaClient;
  let callbacks: MetaCallbacksService;
  let service: MetaCallbackAdminService;
  const meta = { deauthorize: jest.fn() };
  const ACTOR = "platform-admin-user-1";

  beforeAll(async () => {
    const url = privateSchemaUrl(databaseUrl as string, schema);
    localHostConfirmed = true;
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_FILE], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    db = new PrismaClient({ datasourceUrl: url });
    callbacks = new MetaCallbacksService(db as unknown as PrismaService, meta as unknown as MetaGraphApiService);
    service = new MetaCallbackAdminService(db as unknown as PrismaService, meta as unknown as MetaGraphApiService);
  });

  afterAll(async () => {
    process.env = ORIGINAL_ENV;
    try {
      if (localHostConfirmed && PRIVATE_SCHEMA.test(schema)) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db?.$disconnect();
      await admin?.$disconnect();
    }
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: APP_SECRET, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64), WEB_ORIGIN: "https://relayshift.in", META_CALLBACK_IDENTITY_MATCH_VERIFIED: "" };
    meta.deauthorize.mockReset().mockResolvedValue(undefined);
  });

  let seq = 0;
  const uid = () => { seq += 1; return `${4_000_000_000_000_000 + seq}`; };

  async function seedMerchant(label: string) {
    seq += 1;
    const business = await db.business.create({
      data: {
        name: `Admin Shop ${label} ${seq}`, whatsappPhoneNumberId: `phone-${label}-${seq}`, whatsappBusinessAccountId: `waba-${label}-${seq}`,
        whatsappAccessTokenEncrypted: encryptSecret(`EAAG_${label}_${seq}`), whatsappConnectionStatus: "CONNECTED", whatsappConnectedAt: new Date(),
      },
    });
    const customer = await db.customer.create({ data: { businessId: business.id, firstName: "Asha", phone: "+919000000000" } });
    return { business, customer };
  }

  /** An unmatched deletion request: the user has no link, so it lands in PENDING_REVIEW. */
  async function pendingRequest(userId = uid()) {
    const response = await callbacks.handleDataDeletion(signedFor(userId));
    const row = await db.metaCallbackRequest.findFirstOrThrow({ where: { confirmationCode: response.confirmation_code } });
    expect(row.status).toBe("PENDING_REVIEW");
    return { row, userId, code: response.confirmation_code };
  }

  const resolveDto = (code: string, over: Record<string, unknown> = {}) => ({
    outcome: "COMPLETED" as const, verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" as const, resolutionReference: "TICKET-101", confirm: `RESOLVE ${code}`, ...over,
  });

  it("resolves a pending request: disconnects only the named workspace, keeps its records, removes the identifier, writes audit history", async () => {
    const a = await seedMerchant("A");
    const b = await seedMerchant("B");
    const { row, userId, code } = await pendingRequest();
    await db.metaUserLink.create({ data: { businessId: b.business.id, metaUserId: uid(), source: "ES_SYSTEM_USER" } }); // an unrelated link must survive

    const result = await service.resolve(row.id, resolveDto(code, { businessIds: [a.business.id] }), ACTOR);

    expect(result).toMatchObject({ status: "COMPLETED", alreadyResolved: false, matchedBusinessIds: [a.business.id], connectionsRevoked: 1 });
    expect(await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).toMatchObject({ whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null, whatsappPhoneNumberId: null });
    expect(await db.customer.count({ where: { businessId: a.business.id } })).toBe(1);
    expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(await db.metaUserLink.count({ where: { businessId: b.business.id } })).toBe(1);
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);

    const after = await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "COMPLETED", metaUserId: null, resolvedByUserId: ACTOR, resolutionReference: "TICKET-101", verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" });
    expect(await db.metaCallbackRequest.count({ where: { metaUserId: userId } })).toBe(0);

    const events = await db.metaCallbackEvent.findMany({ where: { requestId: row.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toContain("RESOLVED");
    expect(JSON.stringify(events)).not.toContain(userId);

    // the public status page now reports the outcome
    expect(await callbacks.getDeletionStatus(code)).toMatchObject({ status: "COMPLETED" });
  });

  it("is idempotent: the same reference replays, a different reference or outcome conflicts, nothing is revoked twice", async () => {
    const a = await seedMerchant("idem");
    const { row, code } = await pendingRequest();
    const dto = resolveDto(code, { businessIds: [a.business.id] });
    await service.resolve(row.id, dto, ACTOR);

    await expect(service.resolve(row.id, dto, ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED" });
    await expect(service.resolve(row.id, { ...dto, resolutionReference: "TICKET-OTHER" }, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    expect(await db.metaCallbackEvent.count({ where: { requestId: row.id, action: "RESOLVED" } })).toBe(1);
  });

  /** The stored resolution exactly as the database holds it: the request row and its whole audit history. */
  async function storedResolution(requestId: string) {
    return {
      request: await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: requestId } }),
      events: await db.metaCallbackEvent.findMany({ where: { requestId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    };
  }
  const businessState = (businessId: string) => Promise.all([
    db.business.findUniqueOrThrow({ where: { id: businessId } }),
    db.customer.findMany({ where: { businessId } }),
    db.metaUserLink.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
  ]);
  const resolvedEvents = (requestId: string) => db.metaCallbackEvent.count({ where: { requestId, action: "RESOLVED" } });

  it("identical retries return the stored result with alreadyResolved true and change nothing, for COMPLETED and NO_DATA_HELD", async () => {
    const a = await seedMerchant("replayA");
    const completed = await pendingRequest();
    const noData = await pendingRequest();
    const completedDto = resolveDto(completed.code, { businessIds: [a.business.id] });
    const noDataDto = { outcome: "NO_DATA_HELD" as const, verificationMethod: "RECORDS_SEARCH_NO_MATCH" as const, resolutionReference: "TICKET-102", confirm: `RESOLVE ${noData.code}` };
    const firstCompleted = await service.resolve(completed.row.id, completedDto, ACTOR);
    const firstNoData = await service.resolve(noData.row.id, noDataDto, ACTOR);
    meta.deauthorize.mockClear();
    const before = await Promise.all([storedResolution(completed.row.id), storedResolution(noData.row.id), businessState(a.business.id)]);

    await expect(service.resolve(completed.row.id, completedDto, ACTOR)).resolves.toEqual({ ...firstCompleted, alreadyResolved: true });
    await expect(service.resolve(noData.row.id, noDataDto, ACTOR)).resolves.toEqual({ ...firstNoData, alreadyResolved: true });

    expect(await Promise.all([storedResolution(completed.row.id), storedResolution(noData.row.id), businessState(a.business.id)])).toEqual(before);
    expect(meta.deauthorize).not.toHaveBeenCalled();
    expect(await resolvedEvents(completed.row.id)).toBe(1);
    expect(await resolvedEvents(noData.row.id)).toBe(1);
  });

  it("conflicting retries (reference, verification method, business set, outcome) answer 409 and leave the stored resolution, audit history and every business exactly as they were", async () => {
    const a = await seedMerchant("conflictA");
    const b = await seedMerchant("conflictB");
    const completed = await pendingRequest();
    const noData = await pendingRequest();
    const completedDto = resolveDto(completed.code, { businessIds: [a.business.id] });
    const noDataDto = { outcome: "NO_DATA_HELD" as const, verificationMethod: "RECORDS_SEARCH_NO_MATCH" as const, resolutionReference: "TICKET-102", confirm: `RESOLVE ${noData.code}` };
    await service.resolve(completed.row.id, completedDto, ACTOR);
    await service.resolve(noData.row.id, noDataDto, ACTOR);
    meta.deauthorize.mockClear();
    const before = await Promise.all([storedResolution(completed.row.id), storedResolution(noData.row.id), businessState(a.business.id), businessState(b.business.id)]);

    for (const dto of [
      { ...completedDto, resolutionReference: "TICKET-OTHER" },
      { ...completedDto, verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" as const },
      { ...completedDto, businessIds: [a.business.id, b.business.id] },
      { ...completedDto, businessIds: [b.business.id] },
      { ...noDataDto, confirm: completedDto.confirm, resolutionReference: completedDto.resolutionReference },
    ]) {
      await expect(service.resolve(completed.row.id, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    }
    for (const dto of [
      { ...noDataDto, resolutionReference: "TICKET-OTHER" },
      { ...completedDto, confirm: noDataDto.confirm, resolutionReference: noDataDto.resolutionReference, businessIds: [b.business.id] },
    ]) {
      await expect(service.resolve(noData.row.id, dto, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    }
    // NO_DATA_HELD has exactly one valid verification method, so another one is invalid input rather than a replay
    await expect(service.resolve(noData.row.id, { ...noDataDto, verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" as never }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);

    expect(await Promise.all([storedResolution(completed.row.id), storedResolution(noData.row.id), businessState(a.business.id), businessState(b.business.id)])).toEqual(before);
    expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(meta.deauthorize).not.toHaveBeenCalled();
    expect(await resolvedEvents(completed.row.id)).toBe(1);
    expect(await resolvedEvents(noData.row.id)).toBe(1);
  });

  it("handles simultaneous resolutions as one", async () => {
    const a = await seedMerchant("race");
    const { row, code } = await pendingRequest();
    const dto = resolveDto(code, { businessIds: [a.business.id] });

    const results = await Promise.allSettled([service.resolve(row.id, dto, ACTOR), service.resolve(row.id, dto, ACTOR), service.resolve(row.id, dto, ACTOR)]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    expect(await db.metaCallbackEvent.count({ where: { requestId: row.id, action: "RESOLVED" } })).toBe(1);
  });

  it("simultaneous resolutions with the same reference but different verification methods: calls matching the winner replay, the rest conflict, and the stored method is the winner's", async () => {
    const a = await seedMerchant("raceMethod");
    const { row, code } = await pendingRequest();
    const methods = ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS", "MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS"] as const;

    const results = await Promise.allSettled(methods.map((verificationMethod) => service.resolve(row.id, resolveDto(code, { businessIds: [a.business.id], verificationMethod }), ACTOR)));

    const stored = await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("COMPLETED");
    results.forEach((r, i) => {
      if (methods[i] === stored.verificationMethod) expect(r.status).toBe("fulfilled");
      else { expect(r.status).toBe("rejected"); expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException); }
    });
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    expect(await resolvedEvents(row.id)).toBe(1);
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("DEAUTHORIZED");
  });

  it("simultaneous resolutions naming different business sets: exactly one wins, the loser conflicts, and only the winner's businesses are disconnected", async () => {
    const a = await seedMerchant("raceSetA");
    const b = await seedMerchant("raceSetB");
    const { row, code } = await pendingRequest();
    const sets = [[a.business.id], [a.business.id, b.business.id]];

    const results = await Promise.allSettled(sets.map((businessIds) => service.resolve(row.id, resolveDto(code, { businessIds }), ACTOR)));

    const winner = results.findIndex((r) => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictException);
    expect([...(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).matchedBusinessIds].sort()).toEqual([...sets[winner]].sort());
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("DEAUTHORIZED");
    expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).whatsappConnectionStatus).toBe(winner === 1 ? "DEAUTHORIZED" : "CONNECTED");
    expect(meta.deauthorize).toHaveBeenCalledTimes(sets[winner].length);
    expect(await resolvedEvents(row.id)).toBe(1);
  });

  it("simultaneous COMPLETED and NO_DATA_HELD resolutions with the same reference: exactly one outcome is stored and the other conflicts", async () => {
    const a = await seedMerchant("raceOutcome");
    const { row, code } = await pendingRequest();
    const completed = resolveDto(code, { businessIds: [a.business.id] });
    const noData = { outcome: "NO_DATA_HELD" as const, verificationMethod: "RECORDS_SEARCH_NO_MATCH" as const, resolutionReference: completed.resolutionReference, confirm: completed.confirm };

    const results = await Promise.allSettled([service.resolve(row.id, completed, ACTOR), service.resolve(row.id, noData, ACTOR)]);

    const winner = results.findIndex((r) => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictException);
    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(winner === 0 ? "COMPLETED" : "NO_DATA_HELD");
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe(winner === 0 ? "DEAUTHORIZED" : "CONNECTED");
    expect(meta.deauthorize).toHaveBeenCalledTimes(winner === 0 ? 1 : 0);
    expect(await resolvedEvents(row.id)).toBe(1);
  });

  it("requires the exact confirmation phrase and changes nothing without it", async () => {
    const a = await seedMerchant("confirm");
    const { row } = await pendingRequest();
    await expect(service.resolve(row.id, resolveDto("WRONG", { businessIds: [a.business.id] }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING_REVIEW");
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
  });

  it("does not disclose or touch unknown business ids, and rolls nothing forward", async () => {
    const a = await seedMerchant("iso");
    const { row, code } = await pendingRequest();
    await expect(service.resolve(row.id, resolveDto(code, { businessIds: [a.business.id, "does-not-exist-1234"] }), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING_REVIEW");
  });

  it("refuses to close as NO_DATA_HELD when the account is now linked, and refuses COMPLETED that omits a linked workspace", async () => {
    const a = await seedMerchant("linkA");
    const b = await seedMerchant("linkB");
    const { row, userId, code } = await pendingRequest();
    await db.metaUserLink.createMany({ data: [{ businessId: a.business.id, metaUserId: userId, source: "ES_SYSTEM_USER" }, { businessId: b.business.id, metaUserId: userId, source: "ES_SYSTEM_USER" }] });

    await expect(service.resolve(row.id, { outcome: "NO_DATA_HELD", verificationMethod: "RECORDS_SEARCH_NO_MATCH", resolutionReference: "TICKET-102", confirm: `RESOLVE ${code}` }, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.resolve(row.id, resolveDto(code, { businessIds: [a.business.id] }), ACTOR)).rejects.toBeInstanceOf(ConflictException);

    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING_REVIEW"); // claim rolled back
    expect(await db.metaUserLink.count({ where: { metaUserId: userId } })).toBe(2);
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
  });

  it("closes as NO_DATA_HELD when nothing is linked, without touching any workspace", async () => {
    const a = await seedMerchant("nodata");
    const { row, code } = await pendingRequest();
    const result = await service.resolve(row.id, { outcome: "NO_DATA_HELD", verificationMethod: "RECORDS_SEARCH_NO_MATCH", resolutionReference: "TICKET-103", confirm: `RESOLVE ${code}` }, ACTOR);
    expect(result).toMatchObject({ status: "NO_DATA_HELD", connectionsRevoked: 0 });
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(meta.deauthorize).not.toHaveBeenCalled();
  });

  it("never resolves a deauthorization record (a separate event) and rejects malformed ids as not found", async () => {
    const user = uid();
    await callbacks.handleDeauthorization(signedFor(user));
    const deauth = await db.metaCallbackRequest.findFirstOrThrow({ where: { kind: "DEAUTHORIZATION" } });
    await expect(service.resolve(deauth.id, resolveDto("X", { businessIds: ["abcdefghijk"] }), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get("../etc/passwd")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a request that matched a link while identity matching is unverified is parked and can be resolved by the admin workflow", async () => {
    const a = await seedMerchant("unv");
    const user = uid();
    await db.metaUserLink.create({ data: { businessId: a.business.id, metaUserId: user, source: "ES_SYSTEM_USER" } });
    const response = await callbacks.handleDataDeletion(signedFor(user));
    const row = await db.metaCallbackRequest.findFirstOrThrow({ where: { confirmationCode: response.confirmation_code } });
    expect(row.status).toBe("PENDING_REVIEW");
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");

    const preview = await service.previewResolution(row.id, { outcome: "COMPLETED", businessIds: [a.business.id] });
    expect(preview.currentlyLinkedBusinessIds).toEqual([a.business.id]);
    expect(preview.warnings).toEqual([]);
    expect((await service.get(row.id)).events.map((e) => (e.detail as any)?.reason)).toContain("IDENTITY_MATCH_UNVERIFIED");

    await service.resolve(row.id, resolveDto(response.confirmation_code, { businessIds: [a.business.id] }), ACTOR);
    expect(await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).toMatchObject({ whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null });
    expect(await db.metaUserLink.count({ where: { metaUserId: user } })).toBe(0);
    expect(await callbacks.getDeletionStatus(response.confirmation_code)).toMatchObject({ status: "COMPLETED" });
  });

  it("a resolution leaves another person's pending request, identifier and links untouched", async () => {
    const a = await seedMerchant("isoA");
    const b = await seedMerchant("isoB");
    const mine = await pendingRequest();
    const other = await pendingRequest();
    await db.metaUserLink.create({ data: { businessId: b.business.id, metaUserId: other.userId, source: "ES_SYSTEM_USER" } });

    await service.resolve(mine.row.id, resolveDto(mine.code, { businessIds: [a.business.id] }), ACTOR);

    expect(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: other.row.id } })).toMatchObject({ status: "PENDING_REVIEW", metaUserId: other.userId });
    expect(await db.metaUserLink.count({ where: { metaUserId: other.userId, businessId: b.business.id, revokedAt: null } })).toBe(1);
    expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(await db.metaCallbackEvent.count({ where: { requestId: other.row.id, action: "RESOLVED" } })).toBe(0);
    expect(await callbacks.getDeletionStatus(other.code)).toMatchObject({ status: "PENDING_REVIEW" });
  });

  describe("audit history order", () => {
    // the ids sort the opposite way to the lifecycle, so ordering by id would be exactly wrong; the rows are inserted scrambled in one statement
    const scrambledEvents = (requestId: string, createdAt?: Date) => [
      { id: `ckevt-a-resolved-${requestId}`, requestId, action: "RESOLVED", ...(createdAt ? { createdAt } : {}) },
      { id: `ckevt-m-processed-${requestId}`, requestId, action: "PROCESSED", ...(createdAt ? { createdAt } : {}) },
      { id: `ckevt-z-received-${requestId}`, requestId, action: "RECEIVED", ...(createdAt ? { createdAt } : {}) },
    ];
    const newRequest = () => db.metaCallbackRequest.create({ data: { kind: "DATA_DELETION", dedupeKey: `order-${randomBytes(8).toString("hex")}`, status: "PENDING_REVIEW" } });

    it.each([
      ["an identical explicit timestamp", new Date("2026-10-26T10:00:00.000Z")],
      ["the timestamp the engine stamps on one multi-row write", undefined],
    ])("GET returns RECEIVED, PROCESSED, RESOLVED for events sharing %s, repeatably", async (_label, createdAt) => {
      const request = await newRequest();
      await db.metaCallbackEvent.createMany({ data: scrambledEvents(request.id, createdAt) });
      const byIdentity = await db.metaCallbackEvent.findMany({ where: { requestId: request.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      expect(byIdentity.map((e) => e.action)).toEqual(["RESOLVED", "PROCESSED", "RECEIVED"]); // what ordering by timestamp then id would give

      for (let i = 0; i < 3; i += 1) expect((await service.get(request.id)).events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    });

    it("a real callback followed by a resolution is listed as RECEIVED, PROCESSED, RESOLVED", async () => {
      const { row, code } = await pendingRequest();
      await service.resolve(row.id, { outcome: "NO_DATA_HELD", verificationMethod: "RECORDS_SEARCH_NO_MATCH", resolutionReference: "TICKET-401", confirm: `RESOLVE ${code}` }, ACTOR);

      const history = (await service.get(row.id)).events;

      expect(history.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
      expect(history[2]).toMatchObject({ actorUserId: ACTOR, fromStatus: "PENDING_REVIEW", toStatus: "NO_DATA_HELD" });
    });
  });

  it("preview writes nothing and reports what would happen", async () => {
    const a = await seedMerchant("prev");
    const { row, code } = await pendingRequest();
    const preview = await service.previewResolution(row.id, { outcome: "COMPLETED", businessIds: [a.business.id] });
    expect(preview).toMatchObject({ dryRun: true, confirmationRequired: `RESOLVE ${code}`, warnings: [] });
    expect(preview.businesses[0]).toMatchObject({ id: a.business.id, wouldDisconnect: true });
    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING_REVIEW");
    expect(await db.metaCallbackEvent.count({ where: { requestId: row.id, action: "RESOLVED" } })).toBe(0);
  });
});
