import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";
import { BadRequestException, ConflictException, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { MetaCallbackAdminService } from "./meta-callback-admin.service";
import { MetaDeauthorizationAdminService } from "./meta-deauthorization-admin.service";
import { MetaCallbacksService } from "../../integrations/meta-callbacks/meta-callbacks.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../../integrations/whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

// Platform-admin review of NO_ACTION_UNVERIFIED Meta deauthorization events against a REAL PostgreSQL.
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

describeDb("Meta deauthorization admin review against PostgreSQL", () => {
  jest.setTimeout(60_000);

  const schema = `it_${randomBytes(8).toString("hex")}`;
  const ORIGINAL_ENV = { ...process.env };
  let localHostConfirmed = false;
  let admin: PrismaClient;
  let db: PrismaClient;
  let callbacks: MetaCallbacksService;
  let review: MetaDeauthorizationAdminService;
  let deletionReview: MetaCallbackAdminService;
  const meta = { deauthorize: jest.fn() };
  const probe = { failResolvedEvent: false };
  const ACTOR = "platform-admin-user-1";
  let logged: string[];

  beforeAll(async () => {
    const url = privateSchemaUrl(databaseUrl as string, schema);
    localHostConfirmed = true;
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_FILE], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    db = new PrismaClient({ datasourceUrl: url });
    // lets one test make the audit write inside the resolution transaction fail, to prove everything rolls back
    const instrumented = db.$extends({
      query: {
        metaCallbackEvent: {
          async create({ args, query }: any) {
            if (probe.failResolvedEvent && args?.data?.action === "RESOLVED") throw new Error("simulated database failure");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;
    callbacks = new MetaCallbacksService(db as unknown as PrismaService, meta as unknown as MetaGraphApiService);
    review = new MetaDeauthorizationAdminService(instrumented, meta as unknown as MetaGraphApiService);
    deletionReview = new MetaCallbackAdminService(db as unknown as PrismaService, meta as unknown as MetaGraphApiService);
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
    probe.failResolvedEvent = false;
    meta.deauthorize.mockReset().mockResolvedValue(undefined);
    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  });

  afterEach(() => jest.restoreAllMocks());

  let seq = 0;
  const uid = () => { seq += 1; return `${5_000_000_000_000_000 + seq}`; };

  async function seedMerchant(label: string) {
    seq += 1;
    const business = await db.business.create({
      data: {
        name: `Review Shop ${label} ${seq}`, whatsappPhoneNumberId: `phone-${label}-${seq}`, whatsappBusinessAccountId: `waba-${label}-${seq}`,
        whatsappAccessTokenEncrypted: encryptSecret(`EAAG_${label}_${seq}`), whatsappConnectionStatus: "CONNECTED", whatsappConnectedAt: new Date(Date.now() - 600_000),
      },
    });
    const customer = await db.customer.create({ data: { businessId: business.id, firstName: "Asha", phone: "+919000000000" } });
    await db.order.create({ data: { businessId: business.id, customerId: customer.id, status: "PAID", subtotal: "799.00", total: "799.00", shippingAddress: { line1: "12 Rose Street" } } });
    return { business, token: `EAAG_${label}_${seq}`, waba: `waba-${label}-${seq}` };
  }

  /** The callback matched stored links, but identity matching is unverified, so it parked the event without touching anyone. */
  async function parkedDeauth(businessIds: string[], user = uid(), issuedAt = 1_790_000_000) {
    for (const businessId of businessIds) await db.metaUserLink.create({ data: { businessId, metaUserId: user, source: "ES_SYSTEM_USER" } });
    await callbacks.handleDeauthorization(signedFor(user, issuedAt));
    const row = await db.metaCallbackRequest.findFirstOrThrow({ where: { kind: "DEAUTHORIZATION", metaUserId: user, signedRequestIssuedAt: new Date(issuedAt * 1000) } });
    expect(row.status).toBe("NO_ACTION_UNVERIFIED");
    return { row, user };
  }

  const disconnectDto = (id: string, businessIds: string[], over: Record<string, unknown> = {}) => ({
    outcome: "DISCONNECT_VERIFIED" as const, businessIds, verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" as const, resolutionReference: "TICKET-301", confirm: `DISCONNECT_VERIFIED ${id}`, ...over,
  });
  const noChangeDto = (id: string, over: Record<string, unknown> = {}) => ({
    outcome: "NO_CHANGE" as const, verificationMethod: "RECORDS_REVIEW" as const, resolutionReference: "TICKET-302", reason: "IDENTITY_NOT_ESTABLISHED" as const, confirm: `NO_CHANGE ${id}`, ...over,
  });

  const snapshot = (businessId: string) => Promise.all([
    db.business.findUniqueOrThrow({ where: { id: businessId } }),
    db.customer.findMany({ where: { businessId } }),
    db.order.findMany({ where: { businessId } }),
    db.metaUserLink.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
  ]);
  const resolvedEvents = (requestId: string) => db.metaCallbackEvent.count({ where: { requestId, action: "RESOLVED" } });

  it("an unverified deauthorization is parked for review and the review queue shows it without any Facebook user id", async () => {
    const a = await seedMerchant("queue");
    const before = await snapshot(a.business.id);
    const { row, user } = await parkedDeauth([a.business.id]);

    expect((await snapshot(a.business.id)).slice(0, 3)).toEqual(before.slice(0, 3));
    expect(meta.deauthorize).not.toHaveBeenCalled();

    const queue = await review.list({});
    expect(queue.map((r) => r.id)).toContain(row.id);
    expect(queue.every((r) => r.kind === "DEAUTHORIZATION" && r.status === "NO_ACTION_UNVERIFIED")).toBe(true);
    const detail = await review.get(row.id);
    expect(detail.events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED"]);
    expect(detail.events[1].detail).toMatchObject({ reason: "IDENTITY_MATCH_UNVERIFIED", candidateBusinessIds: [a.business.id] });
    expect(JSON.stringify([queue, detail])).not.toContain(user);
  });

  it("the queue excludes data-deletion requests, and the two review workflows refuse each other's records", async () => {
    const a = await seedMerchant("separate");
    const { row: deauth } = await parkedDeauth([a.business.id]);
    const deletionUser = uid();
    const response = await callbacks.handleDataDeletion(signedFor(deletionUser));
    const deletion = await db.metaCallbackRequest.findFirstOrThrow({ where: { confirmationCode: response.confirmation_code } });

    expect((await review.list({ take: 100 })).map((r) => r.id)).not.toContain(deletion.id);
    await expect(review.get(deletion.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(review.previewResolution(deletion.id, { outcome: "NO_CHANGE" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(review.resolve(deletion.id, noChangeDto(deletion.id), ACTOR)).rejects.toBeInstanceOf(NotFoundException);

    await expect(deletionReview.get(deauth.id)).resolves.toBeDefined(); // the generic read-only detail can show any kind
    await expect(deletionReview.previewResolution(deauth.id, { outcome: "NO_DATA_HELD" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(deletionReview.resolve(deauth.id, { outcome: "NO_DATA_HELD", verificationMethod: "RECORDS_SEARCH_NO_MATCH", resolutionReference: "TICKET-303", confirm: `RESOLVE ${deauth.confirmationCode}` }, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: deauth.id } })).status).toBe("NO_ACTION_UNVERIFIED");
  });

  it("preview shows the candidates and the proposed action and writes nothing", async () => {
    const a = await seedMerchant("pvA");
    const b = await seedMerchant("pvB");
    const { row } = await parkedDeauth([a.business.id, b.business.id]);
    const before = await Promise.all([snapshot(a.business.id), snapshot(b.business.id)]);

    const preview = await review.previewResolution(row.id, { outcome: "DISCONNECT_VERIFIED", businessIds: [a.business.id] });

    expect(preview).toMatchObject({ dryRun: true, requestId: row.id, confirmationRequired: `DISCONNECT_VERIFIED ${row.id}`, warnings: [] });
    expect(preview.candidates.map((c) => [c.id, c.stillLinked, c.eligibleToDisconnect, c.wouldDisconnect]).sort()).toEqual([
      [a.business.id, true, true, true], [b.business.id, true, true, false],
    ].sort());
    expect(await Promise.all([snapshot(a.business.id), snapshot(b.business.id)])).toEqual(before);
    expect(await resolvedEvents(row.id)).toBe(0);
    expect(meta.deauthorize).not.toHaveBeenCalled();
  });

  it("DISCONNECT_VERIFIED disconnects only the named business, keeps its records, and leaves every other candidate and merchant untouched", async () => {
    const a = await seedMerchant("dcA");
    const b = await seedMerchant("dcB");
    const other = await seedMerchant("dcOther");
    const { row, user } = await parkedDeauth([a.business.id, b.business.id]);
    await parkedDeauth([other.business.id]); // an unrelated merchant with an unrelated event
    const [bBefore, otherBefore] = await Promise.all([snapshot(b.business.id), snapshot(other.business.id)]);
    const aRecords = await Promise.all([db.customer.findMany({ where: { businessId: a.business.id } }), db.order.findMany({ where: { businessId: a.business.id } })]);

    const result = await review.resolve(row.id, disconnectDto(row.id, [a.business.id]), ACTOR);

    expect(result).toMatchObject({ requestId: row.id, status: "COMPLETED", alreadyResolved: false, matchedBusinessIds: [a.business.id], connectionsRevoked: 1 });
    expect(await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).toMatchObject({ whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null, whatsappPhoneNumberId: null, whatsappBusinessAccountId: null });
    expect(await Promise.all([db.customer.findMany({ where: { businessId: a.business.id } }), db.order.findMany({ where: { businessId: a.business.id } })])).toEqual(aRecords);
    expect(await db.metaUserLink.findFirstOrThrow({ where: { businessId: a.business.id, metaUserId: user } })).toMatchObject({ revokedReason: "DEAUTHORIZED" });
    // the other candidate and the unrelated merchant are byte-for-byte unchanged
    expect(await snapshot(b.business.id)).toEqual(bBefore);
    expect(await snapshot(other.business.id)).toEqual(otherBefore);
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    expect(meta.deauthorize).toHaveBeenCalledWith(a.waba, a.token);

    expect(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "COMPLETED", resolvedByUserId: ACTOR, resolutionReference: "TICKET-301", verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", matchedBusinessIds: [a.business.id] });
    const events = (await review.get(row.id)).events;
    expect(events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    expect(events[2]).toMatchObject({ actorUserId: ACTOR, fromStatus: "NO_ACTION_UNVERIFIED", toStatus: "COMPLETED" });
    expect(JSON.stringify([result, events])).not.toContain(user);
    expect(logged.join("\n")).not.toContain(user);
    expect(logged.join("\n")).not.toContain(a.token);
  });

  it("NO_CHANGE records the documented reason and changes no business, link or connection", async () => {
    const a = await seedMerchant("nc");
    const { row } = await parkedDeauth([a.business.id]);
    const before = await snapshot(a.business.id);

    const result = await review.resolve(row.id, noChangeDto(row.id, { reason: "MERCHANT_CONFIRMED_KEEP_CONNECTED", verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" }), ACTOR);

    expect(result).toMatchObject({ status: "NO_CHANGE_RECORDED", connectionsRevoked: 0, matchedBusinessIds: [], resolutionReason: "MERCHANT_CONFIRMED_KEEP_CONNECTED" });
    expect(await snapshot(a.business.id)).toEqual(before);
    expect(meta.deauthorize).not.toHaveBeenCalled();
    expect(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "NO_CHANGE_RECORDED", resolvedByUserId: ACTOR, resolutionReference: "TICKET-302", resolutionReason: "MERCHANT_CONFIRMED_KEEP_CONNECTED", verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" });
    expect(await resolvedEvents(row.id)).toBe(1);
    expect((await review.list({})).map((r) => r.id)).not.toContain(row.id);
    expect((await review.list({ status: "NO_CHANGE_RECORDED", take: 100 })).map((r) => r.id)).toContain(row.id);
  });

  it("requires the exact confirmation phrase, and the verification rules for each outcome", async () => {
    const a = await seedMerchant("rules");
    const { row } = await parkedDeauth([a.business.id]);

    await expect(review.resolve(row.id, disconnectDto(row.id, [a.business.id], { confirm: "DISCONNECT_VERIFIED" }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(review.resolve(row.id, disconnectDto(row.id, [a.business.id], { confirm: `NO_CHANGE ${row.id}` }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(review.resolve(row.id, disconnectDto(row.id, [a.business.id], { verificationMethod: "RECORDS_REVIEW" }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(review.resolve(row.id, disconnectDto(row.id, []), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(review.resolve(row.id, noChangeDto(row.id, { reason: undefined }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(review.resolve(row.id, noChangeDto(row.id, { businessIds: [a.business.id] }), ACTOR)).rejects.toBeInstanceOf(BadRequestException);

    expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("NO_ACTION_UNVERIFIED");
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
  });

  it("unknown business ids and merchants that are not candidates of the event are indistinguishable (404) and nothing changes", async () => {
    const a = await seedMerchant("iso");
    const stranger = await seedMerchant("stranger"); // a real merchant, linked to a different Facebook account
    await db.metaUserLink.create({ data: { businessId: stranger.business.id, metaUserId: uid(), source: "ES_SYSTEM_USER" } });
    const { row } = await parkedDeauth([a.business.id]);
    const [aBefore, strangerBefore] = await Promise.all([snapshot(a.business.id), snapshot(stranger.business.id)]);

    for (const businessIds of [["ckdoesnotexist00001"], [stranger.business.id], [a.business.id, stranger.business.id], [a.business.id, "ckdoesnotexist00001"]]) {
      await expect(review.resolve(row.id, disconnectDto(row.id, businessIds), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    }

    expect(await snapshot(a.business.id)).toEqual(aBefore);
    expect(await snapshot(stranger.business.id)).toEqual(strangerBefore);
    expect(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "NO_ACTION_UNVERIFIED", resolvedByUserId: null, resolutionReference: null });
    expect(await resolvedEvents(row.id)).toBe(0);
    expect(meta.deauthorize).not.toHaveBeenCalled();
  });

  it("refuses to disconnect a connection that is no longer the one the event concerns (relinked or reconnected since) and changes nothing", async () => {
    const relinked = await seedMerchant("stale1");
    const reconnected = await seedMerchant("stale2");
    const { row: row1 } = await parkedDeauth([relinked.business.id]);
    const { row: row2 } = await parkedDeauth([reconnected.business.id]);

    await db.metaUserLink.updateMany({ where: { businessId: relinked.business.id }, data: { revokedAt: new Date(), revokedReason: "SUPERSEDED" } });
    await db.business.update({ where: { id: reconnected.business.id }, data: { whatsappConnectedAt: new Date(Date.now() + 600_000) } });

    const preview = await review.previewResolution(row2.id, { outcome: "DISCONNECT_VERIFIED", businessIds: [reconnected.business.id] });
    expect(preview.warnings.map((w) => w.code)).toEqual(["RECONNECTED_AFTER_EVENT"]);
    await expect(review.resolve(row1.id, disconnectDto(row1.id, [relinked.business.id]), ACTOR)).rejects.toBeInstanceOf(ConflictException);
    await expect(review.resolve(row2.id, disconnectDto(row2.id, [reconnected.business.id]), ACTOR)).rejects.toBeInstanceOf(ConflictException);

    for (const m of [relinked, reconnected]) expect((await db.business.findUniqueOrThrow({ where: { id: m.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(await db.metaCallbackRequest.count({ where: { id: { in: [row1.id, row2.id] }, status: "NO_ACTION_UNVERIFIED" } })).toBe(2);
    expect(meta.deauthorize).not.toHaveBeenCalled();
  });

  it("an event whose identifier was deleted by a data-deletion resolution can no longer disconnect anything, but can still be closed as NO_CHANGE", async () => {
    const a = await seedMerchant("deleted");
    const { row, user } = await parkedDeauth([a.business.id]);
    // the same Facebook account also asked for deletion; with matching unverified it is parked, then an admin resolves it
    const response = await callbacks.handleDataDeletion(signedFor(user, 1_790_000_100));
    const deletion = await db.metaCallbackRequest.findFirstOrThrow({ where: { confirmationCode: response.confirmation_code } });
    await deletionReview.resolve(deletion.id, { outcome: "COMPLETED", businessIds: [a.business.id], verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", resolutionReference: "TICKET-305", confirm: `RESOLVE ${response.confirmation_code}` }, ACTOR);

    const afterDeletion = await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterDeletion).toMatchObject({ status: "NO_ACTION_UNVERIFIED", metaUserId: null });
    expect((await review.previewResolution(row.id, { outcome: "NO_CHANGE" })).warnings.map((w) => w.code)).toEqual(["IDENTIFIER_DELETED"]);
    await expect(review.resolve(row.id, disconnectDto(row.id, [a.business.id]), ACTOR)).rejects.toBeInstanceOf(ConflictException);
    await expect(review.resolve(row.id, noChangeDto(row.id, { reason: "SUPERSEDED_BY_DATA_DELETION" }), ACTOR)).resolves.toMatchObject({ status: "NO_CHANGE_RECORDED" });
  });

  describe("idempotency", () => {
    it("the same reference returns the existing outcome and repeats no side effect, for both outcomes", async () => {
      const a = await seedMerchant("idemA");
      const b = await seedMerchant("idemB");
      const { row: disconnectRow } = await parkedDeauth([a.business.id]);
      const { row: noChangeRow } = await parkedDeauth([b.business.id]);
      const disconnect = disconnectDto(disconnectRow.id, [a.business.id]);
      const noChange = noChangeDto(noChangeRow.id);
      await review.resolve(disconnectRow.id, disconnect, ACTOR);
      await review.resolve(noChangeRow.id, noChange, ACTOR);

      await expect(review.resolve(disconnectRow.id, disconnect, ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED", matchedBusinessIds: [a.business.id] });
      await expect(review.resolve(noChangeRow.id, noChange, ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "NO_CHANGE_RECORDED" });

      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(await resolvedEvents(disconnectRow.id)).toBe(1);
      expect(await resolvedEvents(noChangeRow.id)).toBe(1);
    });

    it("a conflicting retry (other reference, outcome, business set or reason) answers 409 without repeating any side effect", async () => {
      const a = await seedMerchant("conflict");
      const b = await seedMerchant("conflict2");
      const { row } = await parkedDeauth([a.business.id, b.business.id]);
      await review.resolve(row.id, disconnectDto(row.id, [a.business.id]), ACTOR);
      meta.deauthorize.mockClear();

      await expect(review.resolve(row.id, disconnectDto(row.id, [a.business.id], { resolutionReference: "TICKET-OTHER" }), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      await expect(review.resolve(row.id, disconnectDto(row.id, [b.business.id]), ACTOR)).rejects.toBeInstanceOf(ConflictException);
      await expect(review.resolve(row.id, noChangeDto(row.id, { resolutionReference: "TICKET-301" }), ACTOR)).rejects.toBeInstanceOf(ConflictException);

      expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(await resolvedEvents(row.id)).toBe(1);

      const { row: ncRow } = await parkedDeauth([(await seedMerchant("conflict3")).business.id]);
      await review.resolve(ncRow.id, noChangeDto(ncRow.id), ACTOR);
      await expect(review.resolve(ncRow.id, noChangeDto(ncRow.id, { reason: "CONNECTION_ALREADY_REPLACED" }), ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it("a retry with a different verification method answers 409 and leaves the stored resolution and audit history exactly as they were", async () => {
      const a = await seedMerchant("idemMethodA");
      const b = await seedMerchant("idemMethodB");
      const { row: disconnectRow } = await parkedDeauth([a.business.id]);
      const { row: noChangeRow } = await parkedDeauth([b.business.id]);
      const disconnect = disconnectDto(disconnectRow.id, [a.business.id]);
      const noChange = noChangeDto(noChangeRow.id);
      await review.resolve(disconnectRow.id, disconnect, ACTOR);
      await review.resolve(noChangeRow.id, noChange, ACTOR);
      meta.deauthorize.mockClear();

      const stored = async (requestId: string) => ({
        request: await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: requestId } }),
        events: await db.metaCallbackEvent.findMany({ where: { requestId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      });
      const before = await Promise.all([stored(disconnectRow.id), stored(noChangeRow.id), snapshot(a.business.id), snapshot(b.business.id)]);

      await expect(review.resolve(disconnectRow.id, { ...disconnect, verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS" }, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      await expect(review.resolve(noChangeRow.id, { ...noChange, verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION" }, ACTOR)).rejects.toBeInstanceOf(ConflictException);

      expect(await Promise.all([stored(disconnectRow.id), stored(noChangeRow.id), snapshot(a.business.id), snapshot(b.business.id)])).toEqual(before);
      expect(before[0].request.verificationMethod).toBe("MERCHANT_WRITTEN_CONFIRMATION");
      expect(before[1].request.verificationMethod).toBe("RECORDS_REVIEW");
      expect(await resolvedEvents(disconnectRow.id)).toBe(1);
      expect(await resolvedEvents(noChangeRow.id)).toBe(1);
      expect(meta.deauthorize).not.toHaveBeenCalled();

      // the identical retries still return the stored results
      await expect(review.resolve(disconnectRow.id, disconnect, ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "COMPLETED" });
      await expect(review.resolve(noChangeRow.id, noChange, ACTOR)).resolves.toMatchObject({ alreadyResolved: true, status: "NO_CHANGE_RECORDED" });
    });

    it("a repeated Meta callback does not create a second event to review", async () => {
      const a = await seedMerchant("dupcb");
      const { row, user } = await parkedDeauth([a.business.id]);
      await callbacks.handleDeauthorization(signedFor(user));
      await callbacks.handleDeauthorization(signedFor(user));
      expect(await db.metaCallbackRequest.count({ where: { kind: "DEAUTHORIZATION", metaUserId: user } })).toBe(1);
      expect((await review.get(row.id)).events).toHaveLength(2);
    });
  });

  describe("concurrency", () => {
    it("simultaneous resolutions with the same reference produce one resolution, one revocation and one audit event", async () => {
      const a = await seedMerchant("raceSame");
      const { row } = await parkedDeauth([a.business.id]);
      const dto = disconnectDto(row.id, [a.business.id]);

      const results = await Promise.allSettled([1, 2, 3, 4].map(() => review.resolve(row.id, dto, ACTOR)));

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(await resolvedEvents(row.id)).toBe(1);
    });

    it("simultaneous resolutions with different references: exactly one wins and the rest conflict", async () => {
      const a = await seedMerchant("raceDiff");
      const { row } = await parkedDeauth([a.business.id]);

      const results = await Promise.allSettled([1, 2, 3].map((n) => review.resolve(row.id, disconnectDto(row.id, [a.business.id], { resolutionReference: `TICKET-RACE-${n}` }), ACTOR)));

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictException);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(await resolvedEvents(row.id)).toBe(1);
    });

    it("simultaneous resolutions with the same reference but different verification methods: exactly one wins, the rest conflict, and the winner's method is the one stored", async () => {
      const a = await seedMerchant("raceMethod");
      const { row } = await parkedDeauth([a.business.id]);
      const methods = ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS"] as const;

      const results = await Promise.allSettled(methods.map((verificationMethod) => review.resolve(row.id, disconnectDto(row.id, [a.business.id], { verificationMethod }), ACTOR)));

      const winner = results.findIndex((r) => r.status === "fulfilled");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictException);
      expect((await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).verificationMethod).toBe(methods[winner]);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(await resolvedEvents(row.id)).toBe(1);
    });

    it("two events naming the same business at the same time disconnect it once; the other is told the link is gone", async () => {
      const a = await seedMerchant("raceBiz");
      const user = uid();
      const { row: first } = await parkedDeauth([a.business.id], user, 1_790_000_000);
      await callbacks.handleDeauthorization(signedFor(user, 1_790_000_500));
      const second = await db.metaCallbackRequest.findFirstOrThrow({ where: { kind: "DEAUTHORIZATION", metaUserId: user, signedRequestIssuedAt: new Date(1_790_000_500 * 1000) } });

      const results = await Promise.allSettled([
        review.resolve(first.id, disconnectDto(first.id, [a.business.id], { resolutionReference: "TICKET-A" }), ACTOR),
        review.resolve(second.id, disconnectDto(second.id, [a.business.id], { resolutionReference: "TICKET-B" }), ACTOR),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(ConflictException) });
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(await db.metaCallbackEvent.count({ where: { requestId: { in: [first.id, second.id] }, action: "RESOLVED" } })).toBe(1);
    });
  });

  it("rolls everything back when the audit write fails, so a retry with the same reference completes the resolution", async () => {
    const a = await seedMerchant("rollback");
    const { row } = await parkedDeauth([a.business.id]);
    const before = await snapshot(a.business.id);
    const dto = disconnectDto(row.id, [a.business.id]);

    probe.failResolvedEvent = true;
    await expect(review.resolve(row.id, dto, ACTOR)).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(await snapshot(a.business.id)).toEqual(before);
    expect(await db.metaCallbackRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "NO_ACTION_UNVERIFIED", resolvedByUserId: null, resolutionReference: null });
    expect(meta.deauthorize).not.toHaveBeenCalled();

    probe.failResolvedEvent = false;
    await expect(review.resolve(row.id, dto, ACTOR)).resolves.toMatchObject({ status: "COMPLETED", alreadyResolved: false });
    expect(meta.deauthorize).toHaveBeenCalledTimes(1);
  });

  describe("audit history order", () => {
    // the ids sort the opposite way to the lifecycle, so ordering by id would be exactly wrong; the rows are inserted scrambled in one statement
    const scrambledEvents = (requestId: string, createdAt?: Date) => [
      { id: `ckevt-a-resolved-${requestId}`, requestId, action: "RESOLVED", ...(createdAt ? { createdAt } : {}) },
      { id: `ckevt-m-processed-${requestId}`, requestId, action: "PROCESSED", ...(createdAt ? { createdAt } : {}) },
      { id: `ckevt-z-received-${requestId}`, requestId, action: "RECEIVED", ...(createdAt ? { createdAt } : {}) },
    ];

    it.each([
      ["an identical explicit timestamp", new Date("2026-10-26T10:00:00.000Z")],
      ["the timestamp the engine stamps on one multi-row write", undefined],
    ])("GET returns RECEIVED, PROCESSED, RESOLVED for events sharing %s, repeatably", async (_label, createdAt) => {
      const request = await db.metaCallbackRequest.create({ data: { kind: "DEAUTHORIZATION", dedupeKey: `order-${randomBytes(8).toString("hex")}`, status: "NO_ACTION_UNVERIFIED" } });
      await db.metaCallbackEvent.createMany({ data: scrambledEvents(request.id, createdAt) });
      const byIdentity = await db.metaCallbackEvent.findMany({ where: { requestId: request.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      expect(byIdentity.map((e) => e.action)).toEqual(["RESOLVED", "PROCESSED", "RECEIVED"]); // what ordering by timestamp then id would give

      for (let i = 0; i < 3; i += 1) expect((await review.get(request.id)).events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    });

    it("the audit history of a parked event keeps RECEIVED before PROCESSED", async () => {
      const a = await seedMerchant("orderPark");
      const { row } = await parkedDeauth([a.business.id]);
      expect((await review.get(row.id)).events.map((e) => e.action)).toEqual(["RECEIVED", "PROCESSED"]);
    });
  });

  it("never turns the gate on, never deletes anything, and a later matching callback still only parks", async () => {
    const a = await seedMerchant("gate");
    const { row, user } = await parkedDeauth([a.business.id]);
    await review.resolve(row.id, noChangeDto(row.id), ACTOR);

    expect(process.env.META_CALLBACK_IDENTITY_MATCH_VERIFIED).toBe("");
    await callbacks.handleDeauthorization(signedFor(user, 1_790_000_900));
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    expect(await db.customer.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await db.order.count({ where: { businessId: a.business.id } })).toBe(1);
  });
});
