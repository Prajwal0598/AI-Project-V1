import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";
import { InternalServerErrorException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { MetaCallbacksService } from "./meta-callbacks.service";
import { MetaUserLinkService } from "./meta-user-link.service";
import { BusinessService } from "../../businesses/business.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

// Meta deauthorization / data-deletion callbacks against a REAL PostgreSQL. Opt-in: `pnpm test` skips this file unless INTEGRATION_DATABASE_URL is set.
// Start any throwaway PostgreSQL on localhost, e.g. `docker run -d --rm -p 127.0.0.1:54329:5432 -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=relay_integration postgres:16`,
// set INTEGRATION_DATABASE_URL to its localhost connection string, then run `pnpm --filter @ai-customer-agent/api test:integration`.
// It only talks to localhost, migrates a private schema (it_<random>) inside that database, and drops the schema afterwards.
// Every row it seeds is synthetic; only the outbound Meta Graph call is stubbed.

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

const APP_SECRET = "integration-app-secret-not-real";
const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function sign(payload: Record<string, unknown>, secret = APP_SECRET): string {
  const encoded = b64u(JSON.stringify(payload));
  return `${b64u(createHmac("sha256", secret).update(encoded).digest())}.${encoded}`;
}
const signedFor = (userId: string, issuedAt = 1_790_000_000) => sign({ algorithm: "HMAC-SHA256", issued_at: issuedAt, user_id: userId });

describeDb("Meta callbacks against PostgreSQL", () => {
  jest.setTimeout(60_000);

  const schema = `it_${randomBytes(8).toString("hex")}`;
  const ORIGINAL_ENV = { ...process.env };
  let localHostConfirmed = false;
  let admin: PrismaClient;
  let db: PrismaClient; // plain client: seeding and assertions
  let callbacks: MetaCallbacksService;
  let links: MetaUserLinkService;
  let businesses: BusinessService;
  const meta = { deauthorize: jest.fn() };
  const probe = { failBusinessUpdate: false };

  beforeAll(async () => {
    const url = privateSchemaUrl(databaseUrl as string, schema); // refuses a non-local host before anything connects
    localHostConfirmed = true;
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_FILE], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });

    db = new PrismaClient({ datasourceUrl: url });
    // lets one test make a statement inside the callback transaction fail, to prove the whole callback rolls back
    const instrumented = db.$extends({
      query: {
        business: {
          async updateMany({ args, query }: any) {
            if (probe.failBusinessUpdate) throw new Error("simulated database failure");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;
    callbacks = new MetaCallbacksService(instrumented, meta as unknown as MetaGraphApiService);
    links = new MetaUserLinkService(db as unknown as PrismaService);
    businesses = new BusinessService(db as unknown as PrismaService);
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
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: APP_SECRET, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64), WEB_ORIGIN: "https://relayshift.in,https://www.relayshift.in", META_CALLBACK_IDENTITY_MATCH_VERIFIED: "true" };
    probe.failBusinessUpdate = false;
    meta.deauthorize.mockReset().mockResolvedValue(undefined);
  });

  let seq = 0;
  const uid = () => { seq += 1; return `${3_000_000_000_000_000 + seq}`; }; // a fresh Facebook user id per test

  /** A merchant whose WhatsApp was connected through Embedded Signup, plus customer data that must never be touched. */
  async function seedConnectedMerchant(label: string) {
    seq += 1;
    const business = await db.business.create({
      data: {
        name: `Meta Shop ${label} ${seq}`, whatsappPhoneNumberId: `phone-${label}-${seq}`, whatsappBusinessAccountId: `waba-${label}-${seq}`, whatsappDisplayPhoneNumber: "+91 90000 00000",
        metaBusinessId: `mbiz-${label}-${seq}`, whatsappAccessTokenEncrypted: encryptSecret(`EAAG_token_${label}_${seq}`), whatsappConnectionStatus: "CONNECTED", whatsappConnectedAt: new Date(), whatsappLastValidatedAt: new Date(),
      },
    });
    const customer = await db.customer.create({ data: { businessId: business.id, firstName: "Asha", phone: "+919000000000" } });
    await db.order.create({ data: { businessId: business.id, customerId: customer.id, status: "PAID", subtotal: "799.00", total: "799.00", shippingAddress: { line1: "12 Rose Street" } } });
    return { business, customer, token: `EAAG_token_${label}_${seq}`, waba: `waba-${label}-${seq}` };
  }

  async function authorise(businessId: string, userId: string) {
    expect(await links.recordVerifiedUser(businessId, userId)).toBe(true);
  }

  const snapshot = (businessId: string) => Promise.all([
    db.business.findUniqueOrThrow({ where: { id: businessId } }),
    db.customer.findMany({ where: { businessId } }),
    db.order.findMany({ where: { businessId } }),
    db.metaUserLink.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
  ]);

  const requests = (userIdOrNull: string | null, kind?: string) => db.metaCallbackRequest.findMany({ where: { ...(userIdOrNull ? { metaUserId: userIdOrNull } : {}), ...(kind ? { kind } : {}) } });

  describe("association (server-verified ids only)", () => {
    it("stores the system-user id from a new connection, and rejects ids of an unexpected shape", async () => {
      const m = await seedConnectedMerchant("assoc");
      const user = uid();

      expect(await links.replaceConnectionLinks(m.business.id, user)).toBe(true);
      expect(await links.replaceConnectionLinks(m.business.id, "not an id; DROP")).toBe(false);
      expect(await links.recordVerifiedUser(m.business.id, "")).toBe(false);

      const rows = await db.metaUserLink.findMany({ where: { businessId: m.business.id } });
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(0); // the bad call retired the earlier link and added none
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ metaUserId: user, source: "ES_SYSTEM_USER", revokedReason: "SUPERSEDED" });
    });

    it("a verified person is linked alongside the system user, and a new connection retires both", async () => {
      const m = await seedConnectedMerchant("both");
      const sys = uid(), person = uid();
      await links.replaceConnectionLinks(m.business.id, sys);
      await links.recordVerifiedUser(m.business.id, person);
      expect((await db.metaUserLink.findMany({ where: { businessId: m.business.id, revokedAt: null } })).map((r) => r.source).sort()).toEqual(["ES_SYSTEM_USER", "FACEBOOK_LOGIN_USER_TOKEN"]);

      await links.replaceConnectionLinks(m.business.id, null);
      expect(await db.metaUserLink.count({ where: { businessId: m.business.id, revokedAt: null } })).toBe(0);
    });

    it("keeps only the latest connection's id active and marks the earlier one superseded", async () => {
      const m = await seedConnectedMerchant("supersede");
      const first = uid(), second = uid();
      await links.replaceConnectionLinks(m.business.id, first);
      await links.replaceConnectionLinks(m.business.id, second);

      const rows = await db.metaUserLink.findMany({ where: { businessId: m.business.id } });
      expect(rows.find((r) => r.metaUserId === first)).toMatchObject({ revokedReason: "SUPERSEDED" });
      expect(rows.find((r) => r.metaUserId === first)?.revokedAt).toBeInstanceOf(Date);
      expect(rows.find((r) => r.metaUserId === second)).toMatchObject({ revokedAt: null, revokedReason: null });
    });

    it("reconnecting as the same user reactivates the link rather than duplicating it", async () => {
      const m = await seedConnectedMerchant("again");
      const user = uid();
      await links.replaceConnectionLinks(m.business.id, user);
      await links.replaceConnectionLinks(m.business.id, uid());
      await links.replaceConnectionLinks(m.business.id, user);

      const rows = await db.metaUserLink.findMany({ where: { businessId: m.business.id, metaUserId: user } });
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).toBeNull();
    });

    it("manual credentials supersede the link, but an unchanged phone number id (resent by every Settings save) does not", async () => {
      const m = await seedConnectedMerchant("manual");
      const user = uid();
      await authorise(m.business.id, user);

      await businesses.update(m.business.id, { whatsappPhoneNumberId: m.business.whatsappPhoneNumberId ?? undefined, name: "Renamed Shop" });
      expect((await db.metaUserLink.findFirstOrThrow({ where: { businessId: m.business.id } })).revokedAt).toBeNull();

      await businesses.update(m.business.id, { whatsappAccessToken: "EAAG_manually_pasted_token" });
      expect(await db.metaUserLink.findFirstOrThrow({ where: { businessId: m.business.id } })).toMatchObject({ revokedReason: "SUPERSEDED" });

      // so a later deauthorization from that Facebook user cannot wipe the credentials the merchant now owns
      await callbacks.handleDeauthorization(signedFor(user));
      const after = await db.business.findUniqueOrThrow({ where: { id: m.business.id } });
      expect(after.whatsappConnectionStatus).toBe("CONNECTED");
      expect(after.whatsappAccessTokenEncrypted).not.toBeNull();
    });
  });

  describe("deauthorization", () => {
    it("disconnects exactly the business that user authorised, keeping the business, customers and orders, and leaving other merchants untouched", async () => {
      const a = await seedConnectedMerchant("A");
      const b = await seedConnectedMerchant("B");
      const userA = uid(), userB = uid();
      await authorise(a.business.id, userA);
      await authorise(b.business.id, userB);
      const otherBefore = await snapshot(b.business.id);
      const customersBefore = await db.customer.findMany({ where: { businessId: a.business.id } });
      const ordersBefore = await db.order.findMany({ where: { businessId: a.business.id } });

      await expect(callbacks.handleDeauthorization(signedFor(userA))).resolves.toEqual({ success: true });

      const after = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
      expect(after).toMatchObject({
        whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null, whatsappPhoneNumberId: null, whatsappBusinessAccountId: null,
        whatsappDisplayPhoneNumber: null, metaBusinessId: null, whatsappConnectedAt: null,
      });
      expect(after.whatsappLastErrorMessage).toContain("Connect WhatsApp again");
      // the merchant account and everything it owns survive
      expect(await db.customer.findMany({ where: { businessId: a.business.id } })).toEqual(customersBefore);
      expect(await db.order.findMany({ where: { businessId: a.business.id } })).toEqual(ordersBefore);
      // another merchant is byte-for-byte unchanged
      expect(await snapshot(b.business.id)).toEqual(otherBefore);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect(meta.deauthorize).toHaveBeenCalledWith(a.waba, a.token);

      expect(await db.metaUserLink.findFirstOrThrow({ where: { businessId: a.business.id } })).toMatchObject({ metaUserId: userA, revokedReason: "DEAUTHORIZED" });
      const [audit] = await requests(userA, "DEAUTHORIZATION");
      expect(audit).toMatchObject({ kind: "DEAUTHORIZATION", status: "COMPLETED", matchedBusinessIds: [a.business.id], connectionsRevoked: 1, confirmationCode: null });
    });

    it("changes nothing when the Facebook user has no association with any business", async () => {
      const m = await seedConnectedMerchant("unlinked");
      const before = await snapshot(m.business.id);
      const stranger = uid();

      await expect(callbacks.handleDeauthorization(signedFor(stranger))).resolves.toEqual({ success: true });

      expect(await snapshot(m.business.id)).toEqual(before);
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect((await requests(stranger))[0]).toMatchObject({ kind: "DEAUTHORIZATION", status: "NO_MATCH", matchedBusinessIds: [], connectionsRevoked: 0 });
    });

    it("ignores a deauthorization from a user who is no longer the authoriser", async () => {
      const m = await seedConnectedMerchant("older");
      const older = uid(), current = uid();
      await links.replaceConnectionLinks(m.business.id, older);
      await links.replaceConnectionLinks(m.business.id, current);
      const before = await db.business.findUniqueOrThrow({ where: { id: m.business.id } });

      await callbacks.handleDeauthorization(signedFor(older));

      expect(await db.business.findUniqueOrThrow({ where: { id: m.business.id } })).toEqual(before);
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("never rewrites a merchant who connected WhatsApp manually, even when a stale link exists", async () => {
      const manual = await db.business.create({ data: { name: "Manual Shop", whatsappPhoneNumberId: `manual-phone-${uid()}`, whatsappAccessTokenEncrypted: encryptSecret("EAAG_manual") } }); // status stays DISCONNECTED on the manual path
      const user = uid();
      await db.metaUserLink.create({ data: { businessId: manual.id, metaUserId: user, source: "ES_SYSTEM_USER" } });

      await callbacks.handleDeauthorization(signedFor(user));

      const after = await db.business.findUniqueOrThrow({ where: { id: manual.id } });
      expect(after.whatsappAccessTokenEncrypted).toBe(manual.whatsappAccessTokenEncrypted);
      expect(after.whatsappPhoneNumberId).toBe(manual.whatsappPhoneNumberId);
      expect(after.whatsappConnectionStatus).toBe("DISCONNECTED");
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("is idempotent: a retried callback produces one audit row and one revocation", async () => {
      const m = await seedConnectedMerchant("retry");
      const user = uid();
      await authorise(m.business.id, user);

      await callbacks.handleDeauthorization(signedFor(user));
      const afterFirst = await snapshot(m.business.id);
      await expect(callbacks.handleDeauthorization(signedFor(user))).resolves.toEqual({ success: true });

      expect(await snapshot(m.business.id)).toEqual(afterFirst);
      expect(await requests(user, "DEAUTHORIZATION")).toHaveLength(1);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    });

    it("handles simultaneous duplicate callbacks as one", async () => {
      const m = await seedConnectedMerchant("race");
      const user = uid();
      await authorise(m.business.id, user);

      const results = await Promise.all([callbacks.handleDeauthorization(signedFor(user)), callbacks.handleDeauthorization(signedFor(user)), callbacks.handleDeauthorization(signedFor(user))]);

      expect(results).toEqual([{ success: true }, { success: true }, { success: true }]);
      expect(await requests(user, "DEAUTHORIZATION")).toHaveLength(1);
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
      expect((await db.business.findUniqueOrThrow({ where: { id: m.business.id } })).whatsappConnectionStatus).toBe("DEAUTHORIZED");
    });

    it("rolls everything back when a step fails, so Meta's retry can complete it", async () => {
      const m = await seedConnectedMerchant("rollback");
      const user = uid();
      await authorise(m.business.id, user);
      const before = await snapshot(m.business.id);

      probe.failBusinessUpdate = true;
      await expect(callbacks.handleDeauthorization(signedFor(user))).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(await snapshot(m.business.id)).toEqual(before);
      expect(await requests(user)).toHaveLength(0);
      expect(meta.deauthorize).not.toHaveBeenCalled();

      probe.failBusinessUpdate = false;
      await expect(callbacks.handleDeauthorization(signedFor(user))).resolves.toEqual({ success: true });
      expect((await db.business.findUniqueOrThrow({ where: { id: m.business.id } })).whatsappConnectionStatus).toBe("DEAUTHORIZED");
      expect(meta.deauthorize).toHaveBeenCalledTimes(1);
    });
  });

  describe("data deletion", () => {
    it("without a verified association creates a PENDING_REVIEW request, returns Meta's JSON, and changes no merchant data", async () => {
      const m = await seedConnectedMerchant("nolink");
      const before = await snapshot(m.business.id);
      const stranger = uid();

      const response = await callbacks.handleDataDeletion(signedFor(stranger));

      expect(Object.keys(response).sort()).toEqual(["confirmation_code", "url"]);
      expect(response.url).toBe(`https://relayshift.in/data-deletion/status?code=${response.confirmation_code}`);
      expect(await snapshot(m.business.id)).toEqual(before);
      expect(meta.deauthorize).not.toHaveBeenCalled();
      const [row] = await requests(stranger, "DATA_DELETION");
      expect(row).toMatchObject({ status: "PENDING_REVIEW", confirmationCode: response.confirmation_code, matchedBusinessIds: [], metaUserId: stranger });

      const status = await callbacks.getDeletionStatus(response.confirmation_code);
      expect(status).toMatchObject({ status: "PENDING_REVIEW", confirmationCode: response.confirmation_code, completedAt: null });
      expect(JSON.stringify(status)).not.toContain(stranger);
    });

    it("with a verified association disconnects only that user's connection, deletes the identifier everywhere, and keeps the account's records", async () => {
      const a = await seedConnectedMerchant("delA");
      const b = await seedConnectedMerchant("delB");
      const userA = uid(), userB = uid();
      await authorise(a.business.id, userA);
      await authorise(b.business.id, userB);
      const otherBefore = await snapshot(b.business.id);
      const customersBefore = await db.customer.findMany({ where: { businessId: a.business.id } });
      const ordersBefore = await db.order.findMany({ where: { businessId: a.business.id } });

      const response = await callbacks.handleDataDeletion(signedFor(userA));

      expect(await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).toMatchObject({ whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null, whatsappPhoneNumberId: null });
      expect(await db.customer.findMany({ where: { businessId: a.business.id } })).toEqual(customersBefore);
      expect(await db.order.findMany({ where: { businessId: a.business.id } })).toEqual(ordersBefore);
      expect(await db.metaUserLink.count({ where: { metaUserId: userA } })).toBe(0);
      // cross-merchant isolation
      expect(await snapshot(b.business.id)).toEqual(otherBefore);
      expect(await db.metaUserLink.count({ where: { metaUserId: userB } })).toBe(1);

      const row = await db.metaCallbackRequest.findUniqueOrThrow({ where: { confirmationCode: response.confirmation_code } });
      expect(row).toMatchObject({ kind: "DATA_DELETION", status: "COMPLETED", matchedBusinessIds: [a.business.id], connectionsRevoked: 1, metaUserId: null });
      expect(await callbacks.getDeletionStatus(response.confirmation_code)).toMatchObject({ status: "COMPLETED", message: expect.stringContaining("tax and accounting") });
    });

    it("treats deauthorization and data deletion as separate events, and the deletion also clears the id from the earlier deauthorization record", async () => {
      const m = await seedConnectedMerchant("both");
      const user = uid();
      await authorise(m.business.id, user);

      await callbacks.handleDeauthorization(signedFor(user, 1_790_000_100));
      const deletion = await callbacks.handleDataDeletion(signedFor(user, 1_790_000_200));

      const all = await db.metaCallbackRequest.findMany({ where: { OR: [{ kind: "DEAUTHORIZATION" }, { kind: "DATA_DELETION" }] }, orderBy: { createdAt: "asc" } });
      const mine = all.filter((r) => r.matchedBusinessIds.includes(m.business.id));
      expect(mine.map((r) => r.kind).sort()).toEqual(["DATA_DELETION", "DEAUTHORIZATION"]);
      expect(mine.every((r) => r.metaUserId === null)).toBe(true);
      expect(await db.metaUserLink.count({ where: { businessId: m.business.id } })).toBe(0);
      expect(await callbacks.getDeletionStatus(deletion.confirmation_code)).toMatchObject({ status: "COMPLETED" });
      // the deauthorization-only record is not reachable through the public deletion status page
      const deauthCode = mine.find((r) => r.kind === "DEAUTHORIZATION")?.confirmationCode;
      expect(deauthCode).toBeNull();
    });

    it("is idempotent: a retry returns the same status url and code, and creates nothing new", async () => {
      const user = uid();
      const first = await callbacks.handleDataDeletion(signedFor(user));
      const retry = await callbacks.handleDataDeletion(signedFor(user));

      expect(retry).toEqual(first);
      expect(await requests(user, "DATA_DELETION")).toHaveLength(1);
    });

    it("hands every simultaneous duplicate the same confirmation code", async () => {
      const user = uid();
      const responses = await Promise.all([callbacks.handleDataDeletion(signedFor(user)), callbacks.handleDataDeletion(signedFor(user)), callbacks.handleDataDeletion(signedFor(user))]);

      expect(new Set(responses.map((r) => r.confirmation_code)).size).toBe(1);
      expect(await requests(user, "DATA_DELETION")).toHaveLength(1);
    });

    it("a later, genuinely new request from the same user gets its own code", async () => {
      const user = uid();
      const first = await callbacks.handleDataDeletion(signedFor(user, 1_790_000_000));
      const second = await callbacks.handleDataDeletion(signedFor(user, 1_790_900_000));
      expect(second.confirmation_code).not.toBe(first.confirmation_code);
      expect(await requests(user, "DATA_DELETION")).toHaveLength(2);
    });

    it("rolls back completely on failure and completes on retry with the same signed request", async () => {
      const m = await seedConnectedMerchant("delrollback");
      const user = uid();
      await authorise(m.business.id, user);
      const before = await snapshot(m.business.id);

      probe.failBusinessUpdate = true;
      await expect(callbacks.handleDataDeletion(signedFor(user))).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(await snapshot(m.business.id)).toEqual(before);
      expect(await requests(user)).toHaveLength(0);

      probe.failBusinessUpdate = false;
      const response = await callbacks.handleDataDeletion(signedFor(user));
      expect(await callbacks.getDeletionStatus(response.confirmation_code)).toMatchObject({ status: "COMPLETED" });
    });

    it("the status lookup is keyed only by the unguessable code: other requests and unknown codes are not reachable", async () => {
      const a = await callbacks.handleDataDeletion(signedFor(uid()));
      await expect(callbacks.getDeletionStatus("0".repeat(32))).rejects.toThrow("Request not found.");
      const view = await callbacks.getDeletionStatus(a.confirmation_code);
      expect(Object.keys(view).sort()).toEqual(["completedAt", "confirmationCode", "message", "receivedAt", "status"]);
    });
  });

  describe("while identity matching is unverified (the default)", () => {
    beforeEach(() => { delete process.env.META_CALLBACK_IDENTITY_MATCH_VERIFIED; });

    it("a deauthorization that matches a stored link disconnects nothing and keeps the link", async () => {
      const m = await seedConnectedMerchant("unv-deauth");
      const user = uid();
      await links.replaceConnectionLinks(m.business.id, user);
      const before = await snapshot(m.business.id);

      await expect(callbacks.handleDeauthorization(signedFor(user))).resolves.toEqual({ success: true });

      expect(await snapshot(m.business.id)).toEqual(before);
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect((await requests(user, "DEAUTHORIZATION"))[0]).toMatchObject({ status: "NO_ACTION_UNVERIFIED", matchedBusinessIds: [], connectionsRevoked: 0 });
    });

    it("a matching data-deletion request stays PENDING_REVIEW, changes no merchant data, and answers Meta normally", async () => {
      const m = await seedConnectedMerchant("unv-del");
      const user = uid();
      await links.replaceConnectionLinks(m.business.id, user);
      const before = await snapshot(m.business.id);

      const response = await callbacks.handleDataDeletion(signedFor(user));

      expect(response.confirmation_code).toMatch(/^[a-f0-9]{32}$/);
      expect(await snapshot(m.business.id)).toEqual(before);
      expect(meta.deauthorize).not.toHaveBeenCalled();
      const [row] = await requests(user, "DATA_DELETION");
      expect(row).toMatchObject({ status: "PENDING_REVIEW", metaUserId: user, matchedBusinessIds: [], connectionsRevoked: 0 });
      const events = await db.metaCallbackEvent.findMany({ where: { requestId: row.id } });
      expect(events.find((e) => e.action === "PROCESSED")).toMatchObject({ toStatus: "PENDING_REVIEW", detail: { reason: "IDENTITY_MATCH_UNVERIFIED", candidateBusinessIds: [m.business.id] } });
      expect(await callbacks.getDeletionStatus(response.confirmation_code)).toMatchObject({ status: "PENDING_REVIEW" });
    });

    it("retries and simultaneous duplicates stay idempotent: one request, one code, still nothing changed", async () => {
      const m = await seedConnectedMerchant("unv-dup");
      const user = uid();
      await links.replaceConnectionLinks(m.business.id, user);

      const responses = await Promise.all([1, 2, 3].map(() => callbacks.handleDataDeletion(signedFor(user))));
      await callbacks.handleDeauthorization(signedFor(user));
      await callbacks.handleDeauthorization(signedFor(user));

      expect(new Set(responses.map((r) => r.confirmation_code)).size).toBe(1);
      expect(await requests(user, "DATA_DELETION")).toHaveLength(1);
      expect(await requests(user, "DEAUTHORIZATION")).toHaveLength(1);
      expect((await db.business.findUniqueOrThrow({ where: { id: m.business.id } })).whatsappConnectionStatus).toBe("CONNECTED");
    });
  });

  it("deleting a business removes its links with it (no orphaned Facebook identifiers)", async () => {
    const m = await seedConnectedMerchant("cascade");
    await authorise(m.business.id, uid());
    await db.order.deleteMany({ where: { businessId: m.business.id } });
    await db.business.delete({ where: { id: m.business.id } });
    expect(await db.metaUserLink.count({ where: { businessId: m.business.id } })).toBe(0);
  });
});
