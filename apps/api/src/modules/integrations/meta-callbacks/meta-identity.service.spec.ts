import { BadRequestException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { MetaIdentityService } from "./meta-identity.service";
import type { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import type { MetaUserLinkService } from "./meta-user-link.service";

const APP_ID = "app123";
const APP_SECRET = "test-app-secret-not-real";
const USER_TOKEN = "EAAG_user_token_not_real";
const USER_ID = "1234567890123456";

describe("MetaIdentityService.verifyAndLink", () => {
  const ORIGINAL_ENV = { ...process.env };
  let meta: { exchangeCodeForToken: jest.Mock; debugToken: jest.Mock };
  let links: { recordVerifiedUser: jest.Mock };
  let service: MetaIdentityService;
  let logged: string[];

  const inspected = (over: Record<string, unknown> = {}) => ({ isValid: true, appId: APP_ID, type: "USER", userId: USER_ID, ...over });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, META_APP_ID: APP_ID, WHATSAPP_APP_SECRET: APP_SECRET };
    meta = { exchangeCodeForToken: jest.fn().mockResolvedValue(USER_TOKEN), debugToken: jest.fn().mockResolvedValue(inspected()) };
    links = { recordVerifiedUser: jest.fn().mockResolvedValue(true) };
    service = new MetaIdentityService(meta as unknown as MetaGraphApiService, links as unknown as MetaUserLinkService);

    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { process.env = ORIGINAL_ENV; });

  const expectNothingLinked = () => expect(links.recordVerifiedUser).not.toHaveBeenCalled();

  describe("successful verification", () => {
    it("links the id Meta reported for the token to the signed-in business and returns only { verified: true }", async () => {
      await expect(service.verifyAndLink("biz1", "auth-code")).resolves.toEqual({ verified: true });

      expect(meta.exchangeCodeForToken).toHaveBeenCalledWith("auth-code");
      expect(meta.debugToken).toHaveBeenCalledWith(USER_TOKEN);
      expect(links.recordVerifiedUser).toHaveBeenCalledTimes(1);
      expect(links.recordVerifiedUser).toHaveBeenCalledWith("biz1", USER_ID);
    });

    it("never stores, returns or logs the user token or the authorization code", async () => {
      const result = await service.verifyAndLink("biz1", "auth-code-secret");

      expect(JSON.stringify(result)).not.toContain(USER_TOKEN);
      expect(JSON.stringify(links.recordVerifiedUser.mock.calls)).not.toContain(USER_TOKEN);
      expect(JSON.stringify(links.recordVerifiedUser.mock.calls)).not.toContain("auth-code-secret");
      const output = logged.join("\n");
      for (const secret of [USER_TOKEN, "auth-code-secret", APP_SECRET]) expect(output).not.toContain(secret);
    });
  });

  describe("missing configuration", () => {
    it.each([
      ["META_APP_ID", ["META_APP_ID"]],
      ["WHATSAPP_APP_SECRET", ["WHATSAPP_APP_SECRET"]],
      ["both", ["META_APP_ID", "WHATSAPP_APP_SECRET"]],
    ])("answers 503 naming only the missing variable name(s) when %s is unset, and calls Meta never", async (_label, missing) => {
      for (const name of missing) delete process.env[name];

      const error = await service.verifyAndLink("biz1", "auth-code").catch((e) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      for (const name of missing) expect(error.message).toContain(name);
      for (const name of ["META_APP_ID", "WHATSAPP_APP_SECRET"].filter((n) => !missing.includes(n))) expect(error.message).not.toContain(name);
      expect(error.message).not.toContain(APP_SECRET);
      expect(meta.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(meta.debugToken).not.toHaveBeenCalled();
      expectNothingLinked();
    });

    it.each(["", "   "])("treats a blank variable (%p) as missing", async (blank) => {
      process.env.META_APP_ID = blank;
      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(meta.exchangeCodeForToken).not.toHaveBeenCalled();
    });
  });

  describe("invalid or expired tokens", () => {
    it.each([
      ["invalid", { isValid: false }],
      ["expired (Meta reports is_valid false)", { isValid: false, appId: APP_ID, type: "USER", userId: USER_ID }],
    ])("rejects a %s token with 400 and links nothing", async (_label, over) => {
      meta.debugToken.mockResolvedValue(inspected(over));

      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(BadRequestException);
      expectNothingLinked();
    });

    it("lets a rejected, expired or already-used authorization code fail before the token is ever inspected", async () => {
      meta.exchangeCodeForToken.mockRejectedValue(new BadRequestException("Meta rejected the WhatsApp onboarding authorization."));

      await expect(service.verifyAndLink("biz1", "stale-code")).rejects.toBeInstanceOf(BadRequestException);
      expect(meta.debugToken).not.toHaveBeenCalled();
      expectNothingLinked();
    });

    it("propagates a failed token inspection (Meta unreachable or rejecting) and links nothing", async () => {
      meta.debugToken.mockRejectedValue(new ServiceUnavailableException("Meta could not verify the Facebook login."));

      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(ServiceUnavailableException);
      expectNothingLinked();
    });

    it("gives the caller a message that does not reveal which check failed", async () => {
      const messages = new Set<string>();
      for (const over of [{ isValid: false }, { appId: "other-app" }, { type: "PAGE" }, { userId: null }]) {
        meta.debugToken.mockResolvedValue(inspected(over));
        messages.add(((await service.verifyAndLink("biz1", "auth-code").catch((e) => e)) as Error).message);
      }
      expect(messages.size).toBe(1);
    });
  });

  describe("wrong app id", () => {
    it.each([["another app", "other-app-999"], ["no app id", null], ["a prefix of ours", "app12"], ["ours with a suffix", "app1234"]])("rejects a token issued to %s", async (_label, appId) => {
      meta.debugToken.mockResolvedValue(inspected({ appId }));

      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(BadRequestException);
      expectNothingLinked();
    });
  });

  describe("wrong token type", () => {
    it.each([["a page token", "PAGE"], ["an app token", "APP"], ["a system-user token", "SYSTEM_USER"], ["a lower-case 'user'", "user"], ["no type", null]])("rejects %s — it says nothing about a person", async (_label, type) => {
      meta.debugToken.mockResolvedValue(inspected({ type }));

      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(BadRequestException);
      expectNothingLinked();
    });
  });

  describe("malformed identity", () => {
    it.each([
      ["missing", null],
      ["empty", ""],
      ["containing whitespace", "1234 5678"],
      ["containing punctuation", "12345;DROP TABLE"],
      ["path-like", "../1234"],
      ["longer than 64 characters", "1".repeat(65)],
      ["not a string", 1234567890123456],
    ])("rejects a token whose user id is %s", async (_label, userId) => {
      meta.debugToken.mockResolvedValue(inspected({ userId }));

      await expect(service.verifyAndLink("biz1", "auth-code")).rejects.toBeInstanceOf(BadRequestException);
      expectNothingLinked();
    });
  });
});
