import { createHmac } from "node:crypto";
import { BadRequestException, ForbiddenException, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { MetaCallbacksService } from "./meta-callbacks.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { encryptSecret } from "../../../common/crypto.helper";

const APP_SECRET = "test-app-secret-not-real";
const USER_A = "1000000000000001";
const USER_B = "2000000000000002";
const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function sign(payload: Record<string, unknown>, secret = APP_SECRET): string {
  const encoded = b64u(JSON.stringify(payload));
  return `${b64u(createHmac("sha256", secret).update(encoded).digest())}.${encoded}`;
}
const signedFor = (userId: string, issuedAt = 1_790_000_000) => sign({ algorithm: "HMAC-SHA256", issued_at: issuedAt, user_id: userId });

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
}

describe("MetaCallbacksService", () => {
  const ORIGINAL_ENV = { ...process.env };
  let prisma: any;
  let meta: { deauthorize: jest.Mock };
  let service: MetaCallbacksService;
  let logged: string[];

  const link = (businessId: string, metaUserId: string, over: Record<string, unknown> = {}) => ({ id: `link-${businessId}`, businessId, metaUserId, revokedAt: null, ...over });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: APP_SECRET, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64), WEB_ORIGIN: "https://relayshift.in,https://www.relayshift.in", META_CALLBACK_IDENTITY_MATCH_VERIFIED: "true" };
    prisma = {
      metaCallbackRequest: { create: jest.fn().mockResolvedValue({ id: "req1" }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }), findUnique: jest.fn().mockResolvedValue(null) },
      metaCallbackEvent: { create: jest.fn().mockResolvedValue({}) },
      metaUserLink: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      business: { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
    meta = { deauthorize: jest.fn().mockResolvedValue(undefined) };
    service = new MetaCallbacksService(prisma as unknown as PrismaService, meta as unknown as MetaGraphApiService);

    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { process.env = ORIGINAL_ENV; });

  /** A connected business as the database would hold it, with a real encrypted token. */
  function connectedBusiness(token = "EAAG_business_token") {
    return { whatsappBusinessAccountId: "waba-1", whatsappAccessTokenEncrypted: encryptSecret(token) };
  }

  function expectNoWrites() {
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.metaCallbackRequest.create).not.toHaveBeenCalled();
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
    expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
  }

  describe("request verification (both callbacks)", () => {
    const calls: Array<[string, (s: MetaCallbacksService, input: unknown) => Promise<unknown>]> = [
      ["deauthorization", (s, input) => s.handleDeauthorization(input)],
      ["data deletion", (s, input) => s.handleDataDeletion(input)],
    ];

    it.each(calls)("%s rejects a request signed with the wrong secret with 403 and writes nothing", async (_name, call) => {
      await expect(call(service, sign({ algorithm: "HMAC-SHA256", user_id: USER_A }, "someone-elses-secret"))).rejects.toBeInstanceOf(ForbiddenException);
      expectNoWrites();
    });

    it.each(calls)("%s rejects a tampered payload with 403 and writes nothing", async (_name, call) => {
      const [signature] = signedFor(USER_A).split(".");
      const tampered = `${signature}.${b64u(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: USER_B }))}`;
      await expect(call(service, tampered)).rejects.toBeInstanceOf(ForbiddenException);
      expectNoWrites();
    });

    it.each(calls)("%s rejects a malformed or missing signed_request with 400 and writes nothing", async (_name, call) => {
      for (const bad of [undefined, "", 42, "no-dot", "a.b.c", { signed_request: "x" }]) {
        await expect(call(service, bad)).rejects.toBeInstanceOf(BadRequestException);
      }
      expectNoWrites();
    });

    it.each(calls)("%s fails closed (503) when the app secret is not configured — verification is never skipped", async (_name, call) => {
      delete process.env.WHATSAPP_APP_SECRET;
      await expect(call(service, signedFor(USER_A))).rejects.toBeInstanceOf(ServiceUnavailableException);
      expectNoWrites();
    });

    it.each(calls)("%s does not log the signed request, the user id or the secret when rejecting", async (_name, call) => {
      const forged = sign({ algorithm: "HMAC-SHA256", user_id: USER_A }, "someone-elses-secret");
      await call(service, forged).catch(() => undefined);
      const output = logged.join("\n");
      expect(output).not.toContain(forged);
      expect(output).not.toContain(USER_A);
      expect(output).not.toContain(APP_SECRET);
    });
  });

  describe("handleDeauthorization", () => {
    it("revokes the connection of exactly the business linked to that Facebook user, and answers 200-style success", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.handleDeauthorization(signedFor(USER_A))).resolves.toEqual({ success: true });

      // only users' ACTIVE links are looked up, by that user id
      expect(prisma.metaUserLink.findMany).toHaveBeenCalledWith({ where: { metaUserId: USER_A, revokedAt: null } });
      expect(prisma.business.updateMany).toHaveBeenCalledTimes(1);
      const update = prisma.business.updateMany.mock.calls[0][0];
      expect(update.where.id).toBe("bizA");
      expect(update.data).toMatchObject({
        whatsappConnectionStatus: "DEAUTHORIZED", whatsappAccessTokenEncrypted: null, whatsappPhoneNumberId: null,
        whatsappBusinessAccountId: null, whatsappDisplayPhoneNumber: null, metaBusinessId: null, whatsappConnectedAt: null,
      });
      // a connection that is already DISCONNECTED/DEAUTHORIZED is never rewritten
      expect(update.where.whatsappConnectionStatus).toEqual({ notIn: ["DISCONNECTED", "DEAUTHORIZED"] });
    });

    it("keeps an auditable DEAUTHORIZATION record (not a deletion record) and marks the link revoked", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDeauthorization(signedFor(USER_A));

      expect(prisma.metaCallbackRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "DEAUTHORIZATION", metaUserId: USER_A }) });
      const created = prisma.metaCallbackRequest.create.mock.calls[0][0].data;
      expect(created.confirmationCode).toBeUndefined();
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({
        where: { id: "req1" },
        data: expect.objectContaining({ status: "COMPLETED", matchedBusinessIds: ["bizA"], connectionsRevoked: 1 }),
      });
      expect(prisma.metaUserLink.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["link-bizA"] } }, data: expect.objectContaining({ revokedReason: "DEAUTHORIZED" }) });
      // never deletes a link: the id is kept so a later deletion request from this user can still be matched
      expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
    });

    it("best-effort unsubscribes the WABA with the decrypted token only after the local revocation committed", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness("EAAG_business_token"));
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDeauthorization(signedFor(USER_A));

      expect(meta.deauthorize).toHaveBeenCalledWith("waba-1", "EAAG_business_token");
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(meta.deauthorize.mock.invocationCallOrder[0]);
    });

    it("still succeeds and keeps the local revocation when Meta's unsubscribe fails", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });
      meta.deauthorize.mockRejectedValue(new Error("Meta unreachable"));

      await expect(service.handleDeauthorization(signedFor(USER_A))).resolves.toEqual({ success: true });
    });

    it("changes nothing when no business is linked to that Facebook user (no association) — only an audit row is written", async () => {
      await expect(service.handleDeauthorization(signedFor(USER_B))).resolves.toEqual({ success: true });

      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({
        where: { id: "req1" },
        data: expect.objectContaining({ status: "NO_MATCH", matchedBusinessIds: [], connectionsRevoked: 0 }),
      });
    });

    it("never touches another merchant: only businesses with an active link to the signing user are updated", async () => {
      // user A is linked to bizA only; bizB belongs to someone else entirely and has no link
      prisma.metaUserLink.findMany.mockImplementation(async ({ where }: any) => (where.metaUserId === USER_A ? [link("bizA", USER_A)] : []));
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDeauthorization(signedFor(USER_A));

      for (const call of prisma.business.updateMany.mock.calls) expect(call[0].where.id).toBe("bizA");
      for (const call of prisma.business.findUnique.mock.calls) expect(call[0].where.id).toBe("bizA");
    });

    it("leaves an already-disconnected business alone (a manual or merchant-initiated disconnect is not rewritten)", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue({ whatsappBusinessAccountId: null, whatsappAccessTokenEncrypted: null });
      prisma.business.updateMany.mockResolvedValue({ count: 0 }); // the notIn guard matched nothing

      await service.handleDeauthorization(signedFor(USER_A));

      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: "req1" }, data: expect.objectContaining({ status: "COMPLETED", connectionsRevoked: 0 }) });
    });

    it("never deletes a business, customer, conversation or order", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDeauthorization(signedFor(USER_A));

      expect(Object.keys(prisma).sort()).toEqual(["$transaction", "business", "metaCallbackEvent", "metaCallbackRequest", "metaUserLink"]);
      expect(prisma.business.delete).toBeUndefined();
      expect(prisma.business.deleteMany).toBeUndefined();
    });

    it("is idempotent: a retry of an already-processed callback does nothing and still answers success", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ confirmationCode: null });

      await expect(service.handleDeauthorization(signedFor(USER_A))).resolves.toEqual({ success: true });

      expectNoWrites();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("uses the same dedupe key for the same signed request and a different one for a later request from the same user", async () => {
      await service.handleDeauthorization(signedFor(USER_A, 1_790_000_000));
      await service.handleDeauthorization(signedFor(USER_A, 1_790_000_000));
      await service.handleDeauthorization(signedFor(USER_A, 1_790_000_999));
      const keys = prisma.metaCallbackRequest.create.mock.calls.map((c: any) => c[0].data.dedupeKey);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
      for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
    });

    it("treats a concurrent duplicate that loses the unique-key race as success, without a second revocation or unsubscribe", async () => {
      prisma.metaCallbackRequest.create.mockRejectedValue(duplicateError());

      await expect(service.handleDeauthorization(signedFor(USER_A))).resolves.toEqual({ success: true });

      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("returns 500 (so Meta retries) and never unsubscribes when the transaction fails", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockRejectedValue(new Error("database down"));

      await expect(service.handleDeauthorization(signedFor(USER_A))).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(meta.deauthorize).not.toHaveBeenCalled();
    });

    it("does not log the signed request, the user id, the token or the app secret on success or failure", async () => {
      const signed = signedFor(USER_A);
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness("EAAG_business_token"));
      prisma.business.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error(`boom ${USER_A}`));

      await service.handleDeauthorization(signed);
      await service.handleDeauthorization(signedFor(USER_A, 1)).catch(() => undefined);

      const output = logged.join("\n");
      for (const secret of [signed, USER_A, "EAAG_business_token", APP_SECRET]) expect(output).not.toContain(secret);
    });
  });

  describe("handleDataDeletion", () => {
    const CODE = /^[a-f0-9]{32}$/;

    it("returns the JSON Meta expects: a status url on the public web origin and an alphanumeric confirmation code", async () => {
      const response = await service.handleDataDeletion(signedFor(USER_A));

      expect(Object.keys(response).sort()).toEqual(["confirmation_code", "url"]);
      expect(response.confirmation_code).toMatch(CODE);
      expect(response.url).toBe(`https://relayshift.in/data-deletion/status?code=${response.confirmation_code}`);
    });

    it("parks the request for manual review — and changes no merchant data — when the Facebook user cannot be associated with any business", async () => {
      const response = await service.handleDataDeletion(signedFor(USER_B));

      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: "DATA_DELETION", confirmationCode: response.confirmation_code, metaUserId: USER_B }),
      });
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: "req1" }, data: { status: "PENDING_REVIEW" } });
    });

    it("for a verified association: revokes only that user's connections, deletes only that user's links, and clears the stored id", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A), link("bizOld", USER_A, { revokedAt: new Date(), revokedReason: "DEAUTHORIZED" })]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDataDeletion(signedFor(USER_A));

      expect(prisma.metaUserLink.findMany).toHaveBeenCalledWith({ where: { metaUserId: USER_A } });
      // only the business whose connection this user still authorises is disconnected; the revoked link's business is not touched
      expect(prisma.business.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.business.updateMany.mock.calls[0][0].where.id).toBe("bizA");
      expect(prisma.metaUserLink.deleteMany).toHaveBeenCalledWith({ where: { metaUserId: USER_A } });
      // the identifier is also removed from every audit row that held it (this request's and any earlier deauthorization's)
      expect(prisma.metaCallbackRequest.updateMany).toHaveBeenCalledWith({ where: { metaUserId: USER_A }, data: { metaUserId: null } });
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({
        where: { id: "req1" },
        data: expect.objectContaining({ status: "COMPLETED", matchedBusinessIds: ["bizA", "bizOld"], connectionsRevoked: 1 }),
      });
      expect(prisma.metaCallbackRequest.update.mock.calls[0][0].data).not.toHaveProperty("metaUserId");
      expect(meta.deauthorize).toHaveBeenCalledWith("waba-1", "EAAG_business_token");
    });

    it("never deletes a business account, customers, conversations or orders", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDataDeletion(signedFor(USER_A));

      expect(Object.keys(prisma).sort()).toEqual(["$transaction", "business", "metaCallbackEvent", "metaCallbackRequest", "metaUserLink"]);
      expect(prisma.business.delete).toBeUndefined();
      expect(prisma.business.deleteMany).toBeUndefined();
    });

    it("prevents cross-merchant deletion: a request for one user never reaches a business linked only to another user", async () => {
      prisma.metaUserLink.findMany.mockImplementation(async ({ where }: any) => (where.metaUserId === USER_A ? [link("bizA", USER_A)] : [link("bizB", USER_B)]));
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDataDeletion(signedFor(USER_A));

      for (const call of prisma.business.updateMany.mock.calls) expect(call[0].where.id).not.toBe("bizB");
      for (const call of prisma.metaUserLink.deleteMany.mock.calls) expect(call[0].where).toEqual({ metaUserId: USER_A });
    });

    it("is idempotent: a retry returns the same status url and confirmation code and does nothing else", async () => {
      const first = await service.handleDataDeletion(signedFor(USER_A));
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ confirmationCode: first.confirmation_code });
      prisma.$transaction.mockClear();
      prisma.metaCallbackRequest.create.mockClear();

      const retry = await service.handleDataDeletion(signedFor(USER_A));

      expect(retry).toEqual(first);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.create).not.toHaveBeenCalled();
    });

    it("returns the winner's code when a concurrent duplicate loses the unique-key race", async () => {
      prisma.metaCallbackRequest.create.mockRejectedValue(duplicateError());
      prisma.metaCallbackRequest.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ confirmationCode: "a".repeat(32) });

      const response = await service.handleDataDeletion(signedFor(USER_A));

      expect(response).toEqual({ url: `https://relayshift.in/data-deletion/status?code=${"a".repeat(32)}`, confirmation_code: "a".repeat(32) });
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });

    it("gives a different confirmation code to a genuinely new request", async () => {
      const first = await service.handleDataDeletion(signedFor(USER_A, 1_790_000_000));
      const second = await service.handleDataDeletion(signedFor(USER_A, 1_790_500_000));
      expect(second.confirmation_code).not.toBe(first.confirmation_code);
    });

    it("builds the status url from the first WEB_ORIGIN entry, never from request data", async () => {
      process.env.WEB_ORIGIN = "https://www.relayshift.in,https://relayshift.in";
      const response = await service.handleDataDeletion(signedFor(USER_A));
      expect(response.url.startsWith("https://www.relayshift.in/data-deletion/status?code=")).toBe(true);
    });

    it("returns 500 (so Meta retries) when the transaction fails", async () => {
      prisma.metaCallbackRequest.create.mockRejectedValue(new Error("database down"));
      await expect(service.handleDataDeletion(signedFor(USER_A))).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it("does not log the signed request, user id, confirmation code or token", async () => {
      const signed = signedFor(USER_A);
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness("EAAG_business_token"));
      prisma.business.updateMany.mockResolvedValue({ count: 1 });

      const response = await service.handleDataDeletion(signed);

      const output = logged.join("\n");
      for (const secret of [signed, USER_A, response.confirmation_code, "EAAG_business_token", APP_SECRET]) expect(output).not.toContain(secret);
    });
  });

  describe("getDeletionStatus", () => {
    const code = "b".repeat(32);
    const row = { confirmationCode: code, kind: "DATA_DELETION", status: "PENDING_REVIEW", createdAt: new Date("2026-10-26T00:00:00Z"), completedAt: null };

    it("returns a human-readable status by confirmation code and nothing identifying", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row);

      const view = await service.getDeletionStatus(code);

      expect(view).toEqual({ confirmationCode: code, status: "PENDING_REVIEW", message: expect.stringContaining("review"), receivedAt: row.createdAt, completedAt: null });
      expect(Object.keys(view).sort()).toEqual(["completedAt", "confirmationCode", "message", "receivedAt", "status"]);
    });

    it("selects only non-identifying columns, so another person's or merchant's ids can never be returned", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(row);
      await service.getDeletionStatus(code);

      const query = prisma.metaCallbackRequest.findUnique.mock.calls[0][0];
      expect(query.where).toEqual({ confirmationCode: code });
      expect(Object.keys(query.select).sort()).toEqual(["completedAt", "confirmationCode", "createdAt", "kind", "status"]);
    });

    it.each([
      ["COMPLETED", "removed"],
      ["NO_DATA_HELD", "no data"],
      ["PENDING_REVIEW", "manually"],
    ])("explains the %s outcome in plain language", async (status, phrase) => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ ...row, status });
      expect((await service.getDeletionStatus(code)).message.toLowerCase()).toContain(phrase);
    });

    it("tells the user what is retained and why when the request is completed", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ ...row, status: "COMPLETED" });
      expect((await service.getDeletionStatus(code)).message).toMatch(/tax and accounting/);
    });

    it("answers 404 for an unknown code without distinguishing 'unknown' from 'wrong kind'", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue(null);
      await expect(service.getDeletionStatus(code)).rejects.toBeInstanceOf(NotFoundException);
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ ...row, kind: "DEAUTHORIZATION" });
      await expect(service.getDeletionStatus(code)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(["", "abc", "ZZZ", "b".repeat(31), "b".repeat(33), `${"b".repeat(31)}'`, "../etc/passwd", "B".repeat(32)])("rejects the malformed code %p before touching the database", async (bad) => {
      await expect(service.getDeletionStatus(bad)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.metaCallbackRequest.findUnique).not.toHaveBeenCalled();
    });
  });

  // Meta's callback user_id has not been seen to match the ids stored at connect time, so by default a match must never act on its own
  describe.each([["unset", undefined], ["empty", ""], ["TRUE (wrong case)", "TRUE"], ["1", "1"], ["yes", "yes"]])("while identity matching is unverified (META_CALLBACK_IDENTITY_MATCH_VERIFIED %s)", (_label, value) => {
    beforeEach(() => {
      if (value === undefined) delete process.env.META_CALLBACK_IDENTITY_MATCH_VERIFIED;
      else process.env.META_CALLBACK_IDENTITY_MATCH_VERIFIED = value;
      prisma.metaUserLink.findMany.mockResolvedValue([link("bizA", USER_A)]);
      prisma.business.findUnique.mockResolvedValue(connectedBusiness());
      prisma.business.updateMany.mockResolvedValue({ count: 1 });
    });

    function expectMerchantUntouched() {
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.business.findUnique).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.deleteMany).not.toHaveBeenCalled();
      expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaCallbackRequest.updateMany).not.toHaveBeenCalled();
      expect(meta.deauthorize).not.toHaveBeenCalled();
    }

    it("a matching deauthorization is recorded as NO_ACTION_UNVERIFIED and disconnects nothing", async () => {
      await expect(service.handleDeauthorization(signedFor(USER_A))).resolves.toEqual({ success: true });

      expectMerchantUntouched();
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: "req1" }, data: expect.objectContaining({ status: "NO_ACTION_UNVERIFIED" }) });
      expect(prisma.metaCallbackRequest.update.mock.calls[0][0].data).not.toHaveProperty("matchedBusinessIds");
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ toStatus: "NO_ACTION_UNVERIFIED", detail: { matchedBusinesses: 0, reason: "IDENTITY_MATCH_UNVERIFIED", candidateBusinessIds: ["bizA"] } }),
      });
    });

    it("a matching data-deletion request stays PENDING_REVIEW, keeps the identifier and links for the reviewer, and disconnects nothing", async () => {
      const response = await service.handleDataDeletion(signedFor(USER_A));

      expect(response.confirmation_code).toMatch(/^[a-f0-9]{32}$/);
      expectMerchantUntouched();
      expect(prisma.metaCallbackRequest.update).toHaveBeenCalledWith({ where: { id: "req1" }, data: { status: "PENDING_REVIEW" } });
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ toStatus: "PENDING_REVIEW", detail: { matchedBusinesses: 0, reason: "IDENTITY_MATCH_UNVERIFIED", candidateBusinessIds: ["bizA"] } }),
      });
    });

    it("never reports a connection as revoked or a request as COMPLETED", async () => {
      await service.handleDeauthorization(signedFor(USER_A));
      await service.handleDataDeletion(signedFor(USER_A, 1_790_000_500));

      for (const call of prisma.metaCallbackRequest.update.mock.calls) {
        expect(call[0].data.status).not.toBe("COMPLETED");
        expect(call[0].data.connectionsRevoked).toBeUndefined();
      }
    });

    it("an unmatched request behaves exactly as before (PENDING_REVIEW, reason NO_VERIFIED_ASSOCIATION)", async () => {
      prisma.metaUserLink.findMany.mockResolvedValue([]);
      await service.handleDataDeletion(signedFor(USER_B));
      expect(prisma.metaCallbackEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ toStatus: "PENDING_REVIEW", detail: { matchedBusinesses: 0, reason: "NO_VERIFIED_ASSOCIATION" } }) });
      expectMerchantUntouched();
    });
  });
});
