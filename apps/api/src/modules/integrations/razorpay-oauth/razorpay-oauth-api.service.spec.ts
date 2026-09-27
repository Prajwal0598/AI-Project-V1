import { ServiceUnavailableException } from "@nestjs/common";
import { RazorpayOAuthApiService } from "./razorpay-oauth-api.service";

describe("RazorpayOAuthApiService", () => {
  let service: RazorpayOAuthApiService;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    service = new RazorpayOAuthApiService();
    process.env = { ...ORIGINAL_ENV, RAZORPAY_OAUTH_CLIENT_ID: "client123", RAZORPAY_OAUTH_CLIENT_SECRET: "secret456" };
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("buildAuthorizeUrl", () => {
    it("throws when the Partner client isn't configured", () => {
      delete process.env.RAZORPAY_OAUTH_CLIENT_ID;
      expect(() => service.buildAuthorizeUrl("state-token", "https://relay.example/callback")).toThrow(ServiceUnavailableException);
    });

    it("builds the authorize URL with client_id, redirect_uri and state", () => {
      const url = service.buildAuthorizeUrl("state-token", "https://relay.example/callback");
      expect(url).toContain("https://auth.razorpay.com/authorize?");
      expect(url).toContain("client_id=client123");
      expect(url).toContain("response_type=code");
      expect(url).toContain(`redirect_uri=${encodeURIComponent("https://relay.example/callback")}`);
      expect(url).toContain("state=state-token");
    });
  });

  describe("exchangeCodeForToken", () => {
    it("returns the full token set on a successful exchange", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "acc_tok", refresh_token: "ref_tok", public_token: "rzp_test_oauth_x", expires_in: 7862400, razorpay_account_id: "acc_123" }),
      } as Response);

      const result = await service.exchangeCodeForToken("auth-code", "https://relay.example/callback");

      expect(result).toEqual({ accessToken: "acc_tok", refreshToken: "ref_tok", publicToken: "rzp_test_oauth_x", expiresInSeconds: 7862400, razorpayAccountId: "acc_123" });
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://auth.razorpay.com/token");
      const body = JSON.parse(options?.body as string);
      expect(body).toEqual({ client_id: "client123", client_secret: "secret456", grant_type: "authorization_code", redirect_uri: "https://relay.example/callback", code: "auth-code" });
    });

    it("throws a safe error (no raw response) when Razorpay rejects the exchange", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 400 } as Response);
      await expect(service.exchangeCodeForToken("bad-code", "https://relay.example/callback")).rejects.toThrow(ServiceUnavailableException);
    });

    it("throws when the response is missing required token fields", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ access_token: "acc_tok" }) } as Response);
      await expect(service.exchangeCodeForToken("auth-code", "https://relay.example/callback")).rejects.toThrow(ServiceUnavailableException);
    });

    it("throws when the network request itself fails", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
      await expect(service.exchangeCodeForToken("auth-code", "https://relay.example/callback")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("refreshAccessToken", () => {
    it("sends grant_type=refresh_token and returns the new token set", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "new_acc", refresh_token: "new_ref", public_token: "rzp_test_oauth_y", expires_in: 7862400 }),
      } as Response);

      const result = await service.refreshAccessToken("old_ref_tok");

      expect(result.accessToken).toBe("new_acc");
      expect(result.razorpayAccountId).toBeUndefined();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old_ref_tok");
    });

    it("throws on a non-ok response", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 401 } as Response);
      await expect(service.refreshAccessToken("old_ref_tok")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("revokeToken", () => {
    it("never throws even if the Razorpay call fails (best-effort)", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
      await expect(service.revokeToken("some-token", "access_token")).resolves.toBeUndefined();
    });
  });
});
