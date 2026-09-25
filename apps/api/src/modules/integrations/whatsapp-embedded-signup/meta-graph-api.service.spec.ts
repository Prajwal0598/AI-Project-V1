import { ServiceUnavailableException } from "@nestjs/common";
import { MetaGraphApiService } from "./meta-graph-api.service";

describe("MetaGraphApiService", () => {
  let service: MetaGraphApiService;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    service = new MetaGraphApiService();
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: "secret456" };
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("exchangeCodeForToken", () => {
    it("throws without leaking the code/secret when META_APP_ID isn't configured", async () => {
      delete process.env.META_APP_ID;
      await expect(service.exchangeCodeForToken("auth-code")).rejects.toThrow(ServiceUnavailableException);
    });

    it("returns the access token on a successful exchange", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ access_token: "EAAG_system_user_token" }) } as Response);
      const token = await service.exchangeCodeForToken("auth-code");
      expect(token).toBe("EAAG_system_user_token");
      const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain("client_id=app123");
      expect(calledUrl).toContain("client_secret=secret456");
      expect(calledUrl).toContain("code=auth-code");
    });

    it("throws a safe error (no raw Meta response) when Meta rejects the exchange", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 400, json: async () => ({}) } as Response);
      await expect(service.exchangeCodeForToken("bad-code")).rejects.toThrow(ServiceUnavailableException);
    });

    it("throws when the network request itself fails", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
      await expect(service.exchangeCodeForToken("auth-code")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("subscribeAppToWaba", () => {
    it("resolves on success", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
      await expect(service.subscribeAppToWaba("waba1", "token")).resolves.toBeUndefined();
    });

    it("throws on a non-ok response", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 403 } as Response);
      await expect(service.subscribeAppToWaba("waba1", "token")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("registerPhoneNumber", () => {
    it("sends a generated PIN and resolves on success", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
      await service.registerPhoneNumber("phone1", "token");
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.messaging_product).toBe("whatsapp");
      expect(body.pin).toMatch(/^\d{6}$/);
    });

    it("throws on a non-ok response", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
      await expect(service.registerPhoneNumber("phone1", "token")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("getPhoneNumberDetails", () => {
    it("returns the real display number/verified name", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ display_phone_number: "+91 98765 43210", verified_name: "ABC Fashion" }) } as Response);
      const details = await service.getPhoneNumberDetails("phone1", "token");
      expect(details).toEqual({ displayPhoneNumber: "+91 98765 43210", verifiedName: "ABC Fashion" });
    });

    it("throws when Meta doesn't return a phone number", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      await expect(service.getPhoneNumberDetails("phone1", "token")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("deauthorize", () => {
    it("never throws even if the Meta call fails (best-effort)", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
      await expect(service.deauthorize("waba1", "token")).resolves.toBeUndefined();
    });
  });
});
