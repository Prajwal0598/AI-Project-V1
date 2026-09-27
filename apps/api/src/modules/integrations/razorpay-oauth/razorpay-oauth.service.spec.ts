import { NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { RazorpayOAuthService } from "./razorpay-oauth.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { RazorpayOAuthApiService } from "./razorpay-oauth-api.service";
import { decryptSecret } from "../../../common/crypto.helper";

describe("RazorpayOAuthService", () => {
  let prisma: any;
  let razorpayOAuth: Record<string, jest.Mock>;
  let jwt: { sign: jest.Mock; verify: jest.Mock };
  let service: RazorpayOAuthService;
  const ORIGINAL_ENV = { ...process.env };

  const disconnectedBusiness = {
    id: "biz1", razorpayConnectionStatus: "DISCONNECTED", razorpayAccountId: null,
    razorpayAccessTokenEncrypted: null, razorpayRefreshTokenEncrypted: null, razorpayPublicToken: null,
    razorpayTokenExpiresAt: null, razorpayConnectedAt: null, razorpayLastErrorMessage: null,
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) };
    prisma = { business: { findUnique: jest.fn(), update: jest.fn() } };
    razorpayOAuth = { buildAuthorizeUrl: jest.fn(), exchangeCodeForToken: jest.fn(), refreshAccessToken: jest.fn(), revokeToken: jest.fn() };
    jwt = { sign: jest.fn(), verify: jest.fn() };
    service = new RazorpayOAuthService(prisma as unknown as PrismaService, razorpayOAuth as unknown as RazorpayOAuthApiService, jwt as any);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("buildAuthorizeUrl", () => {
    it("signs a state token scoped to this business and passes it to the API service", () => {
      jwt.sign.mockReturnValue("signed-state-token");
      razorpayOAuth.buildAuthorizeUrl.mockReturnValue("https://auth.razorpay.com/authorize?state=signed-state-token");

      const url = service.buildAuthorizeUrl("biz1");

      expect(jwt.sign).toHaveBeenCalledWith({ businessId: "biz1", purpose: "razorpay_oauth_state" }, { expiresIn: "10m" });
      expect(razorpayOAuth.buildAuthorizeUrl).toHaveBeenCalledWith("signed-state-token", expect.stringContaining("/api/integrations/razorpay/callback"));
      expect(url).toBe("https://auth.razorpay.com/authorize?state=signed-state-token");
    });
  });

  describe("handleCallback", () => {
    it("rejects an invalid/expired state token without touching the database", async () => {
      jwt.verify.mockImplementation(() => { throw new Error("jwt expired"); });
      await expect(service.handleCallback("code", "bad-state")).rejects.toThrow(UnauthorizedException);
      expect(prisma.business.findUnique).not.toHaveBeenCalled();
    });

    it("rejects a state token signed for a different purpose", async () => {
      jwt.verify.mockReturnValue({ businessId: "biz1", purpose: "something_else" });
      await expect(service.handleCallback("code", "state")).rejects.toThrow(UnauthorizedException);
    });

    it("exchanges the code, encrypts the tokens, and marks the business CONNECTED", async () => {
      jwt.verify.mockReturnValue({ businessId: "biz1", purpose: "razorpay_oauth_state" });
      prisma.business.findUnique.mockResolvedValue(disconnectedBusiness);
      razorpayOAuth.exchangeCodeForToken.mockResolvedValue({
        accessToken: "real_access_token", refreshToken: "real_refresh_token", publicToken: "rzp_test_oauth_x", expiresInSeconds: 7862400, razorpayAccountId: "acc_123",
      });
      prisma.business.update.mockImplementation(({ data }: any) => Promise.resolve({ ...disconnectedBusiness, ...data }));

      const result = await service.handleCallback("auth-code", "good-state");

      expect(result).toEqual({ businessId: "biz1" });
      const updateData = prisma.business.update.mock.calls[0][0].data;
      expect(updateData.razorpayConnectionStatus).toBe("CONNECTED");
      expect(updateData.razorpayAccountId).toBe("acc_123");
      // never persists the raw token — only its encrypted form
      expect(updateData.razorpayAccessTokenEncrypted).not.toBe("real_access_token");
      expect(decryptSecret(updateData.razorpayAccessTokenEncrypted)).toBe("real_access_token");
      expect(decryptSecret(updateData.razorpayRefreshTokenEncrypted)).toBe("real_refresh_token");
    });

    it("marks RETRY_REQUIRED (not CONNECTED) when the code exchange fails", async () => {
      jwt.verify.mockReturnValue({ businessId: "biz1", purpose: "razorpay_oauth_state" });
      prisma.business.findUnique.mockResolvedValue(disconnectedBusiness);
      razorpayOAuth.exchangeCodeForToken.mockRejectedValue(new ServiceUnavailableException("Razorpay rejected the request"));
      prisma.business.update.mockResolvedValue(disconnectedBusiness);

      await expect(service.handleCallback("bad-code", "good-state")).rejects.toThrow(ServiceUnavailableException);
      const failureUpdate = prisma.business.update.mock.calls.at(-1)![0];
      expect(failureUpdate.data.razorpayConnectionStatus).toBe("RETRY_REQUIRED");
      expect(failureUpdate.where.id).toBe("biz1");
    });

    it("throws NotFoundException if the business in the state token no longer exists", async () => {
      jwt.verify.mockReturnValue({ businessId: "gone", purpose: "razorpay_oauth_state" });
      prisma.business.findUnique.mockResolvedValue(null);
      await expect(service.handleCallback("code", "state")).rejects.toThrow(NotFoundException);
    });
  });

  describe("disconnect", () => {
    it("clears the connection locally even if Razorpay's revoke call fails", async () => {
      const connected = { ...disconnectedBusiness, razorpayConnectionStatus: "CONNECTED", razorpayAccountId: "acc_123", razorpayAccessTokenEncrypted: "iv:tag:cipher" };
      prisma.business.findUnique.mockResolvedValue(connected);
      razorpayOAuth.revokeToken.mockRejectedValue(new Error("Razorpay unreachable"));
      prisma.business.update.mockImplementation(({ data }: any) => Promise.resolve({ ...connected, ...data }));

      const result = await service.disconnect("biz1");

      expect(result.status).toBe("DISCONNECTED");
      expect(result.accountId).toBeNull();
    });
  });
});
