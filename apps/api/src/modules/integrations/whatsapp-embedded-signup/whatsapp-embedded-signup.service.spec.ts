import { WhatsAppEmbeddedSignupService } from "./whatsapp-embedded-signup.service";
import type { PrismaService } from "../../../database/prisma.service";
import type { MetaGraphApiService } from "./meta-graph-api.service";
import { decryptSecret } from "../../../common/crypto.helper";

describe("WhatsAppEmbeddedSignupService", () => {
  let prisma: any;
  let meta: Record<string, jest.Mock>;
  let service: WhatsAppEmbeddedSignupService;
  const ORIGINAL_ENV = { ...process.env };

  const disconnectedBusiness = {
    id: "biz1", name: "ABC Fashion", whatsappConnectionStatus: "DISCONNECTED",
    whatsappPhoneNumberId: null, whatsappBusinessAccountId: null, whatsappDisplayPhoneNumber: null,
    metaBusinessId: null, whatsappAccessTokenEncrypted: null, whatsappConnectedAt: null,
    whatsappLastValidatedAt: null, whatsappLastErrorMessage: null,
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) };
    prisma = { business: { findUnique: jest.fn(), update: jest.fn() } };
    meta = {
      exchangeCodeForToken: jest.fn(), registerPhoneNumber: jest.fn(), subscribeAppToWaba: jest.fn(),
      getPhoneNumberDetails: jest.fn(), deauthorize: jest.fn(),
    };
    service = new WhatsAppEmbeddedSignupService(prisma as unknown as PrismaService, meta as unknown as MetaGraphApiService);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("completeOnboarding", () => {
    const input = { code: "auth-code", wabaId: "waba1", phoneNumberId: "phone1" };

    it("only reaches CONNECTED after every step succeeds, and encrypts the token before persisting it", async () => {
      prisma.business.findUnique
        .mockResolvedValueOnce(disconnectedBusiness) // initial lookup
        .mockResolvedValueOnce(null); // whatsappPhoneNumberId uniqueness check — no other business owns it
      meta.exchangeCodeForToken.mockResolvedValue("EAAG_real_system_user_token");
      meta.registerPhoneNumber.mockResolvedValue(undefined);
      meta.subscribeAppToWaba.mockResolvedValue(undefined);
      meta.getPhoneNumberDetails.mockResolvedValue({ displayPhoneNumber: "+91 98765 43210", verifiedName: "ABC Fashion" });
      prisma.business.update.mockImplementation(({ data }: any) => Promise.resolve({ ...disconnectedBusiness, ...data }));

      const result = await service.completeOnboarding("biz1", input);

      expect(result.status).toBe("CONNECTED");
      expect(result.phoneNumberId).toBe("phone1");
      expect(result.displayPhoneNumber).toBe("+91 98765 43210");
      // never returns the raw or encrypted token to the caller
      expect(JSON.stringify(result)).not.toContain("EAAG_real_system_user_token");

      const finalUpdateData = prisma.business.update.mock.calls.at(-1)![0].data;
      expect(finalUpdateData.whatsappAccessTokenEncrypted).not.toBe("EAAG_real_system_user_token");
      expect(decryptSecret(finalUpdateData.whatsappAccessTokenEncrypted)).toBe("EAAG_real_system_user_token");

      // status transitions happened in order, never jumping straight to CONNECTED
      const statuses = prisma.business.update.mock.calls.map((c: any) => c[0].data.whatsappConnectionStatus).filter(Boolean);
      expect(statuses).toEqual(["ONBOARDING", "AUTHORIZED", "CONFIGURING", "WEBHOOK_CONNECTED", "CONNECTED"]);
    });

    it("sets RETRY_REQUIRED (not SETUP_REQUIRED) when the code exchange itself fails", async () => {
      prisma.business.findUnique.mockResolvedValueOnce(disconnectedBusiness);
      meta.exchangeCodeForToken.mockRejectedValue(new Error("Meta rejected the WhatsApp onboarding authorization."));
      prisma.business.update.mockResolvedValue(disconnectedBusiness);

      await expect(service.completeOnboarding("biz1", input)).rejects.toThrow();
      const failureUpdate = prisma.business.update.mock.calls.at(-1)![0];
      expect(failureUpdate.data.whatsappConnectionStatus).toBe("RETRY_REQUIRED");
      expect(failureUpdate.where.id).toBe("biz1");
    });

    it("sets SETUP_REQUIRED (not CONNECTED) when phone registration succeeds but webhook subscription fails", async () => {
      prisma.business.findUnique.mockResolvedValueOnce(disconnectedBusiness);
      meta.exchangeCodeForToken.mockResolvedValue("token");
      meta.registerPhoneNumber.mockResolvedValue(undefined);
      meta.subscribeAppToWaba.mockRejectedValue(new Error("Meta rejected the WhatsApp webhook subscription request."));
      prisma.business.update.mockResolvedValue(disconnectedBusiness);

      await expect(service.completeOnboarding("biz1", input)).rejects.toThrow();
      const failureUpdate = prisma.business.update.mock.calls.at(-1)![0];
      expect(failureUpdate.data.whatsappConnectionStatus).toBe("SETUP_REQUIRED");
      // never reports CONNECTED when webhook subscription didn't succeed
      expect(prisma.business.update.mock.calls.some((c: any) => c[0].data.whatsappConnectionStatus === "CONNECTED")).toBe(false);
    });

    it("rejects (RETRY_REQUIRED) rather than silently stealing a phone number already connected to a different business", async () => {
      const otherBusiness = { ...disconnectedBusiness, id: "biz2" };
      prisma.business.findUnique
        .mockResolvedValueOnce(disconnectedBusiness) // biz1's own lookup
        .mockResolvedValueOnce(otherBusiness); // whatsappPhoneNumberId already belongs to biz2
      meta.exchangeCodeForToken.mockResolvedValue("token");
      meta.registerPhoneNumber.mockResolvedValue(undefined);
      meta.subscribeAppToWaba.mockResolvedValue(undefined);
      meta.getPhoneNumberDetails.mockResolvedValue({ displayPhoneNumber: "+91 98765 43210", verifiedName: null });
      prisma.business.update.mockResolvedValue(disconnectedBusiness);

      await expect(service.completeOnboarding("biz1", input)).rejects.toThrow();
      const failureUpdate = prisma.business.update.mock.calls.at(-1)![0];
      expect(failureUpdate.data.whatsappConnectionStatus).toBe("RETRY_REQUIRED");
    });

    it("is idempotent — reconnecting the exact same already-CONNECTED account just re-validates, without re-running the Meta handshake", async () => {
      const connected = {
        ...disconnectedBusiness, whatsappConnectionStatus: "CONNECTED",
        whatsappPhoneNumberId: "phone1", whatsappBusinessAccountId: "waba1",
      };
      prisma.business.findUnique.mockResolvedValueOnce(connected);
      prisma.business.update.mockResolvedValueOnce({ ...connected, whatsappLastValidatedAt: new Date() });
      prisma.business.findUnique.mockResolvedValueOnce({ ...connected, name: "ABC Fashion" });

      const result = await service.completeOnboarding("biz1", input);

      expect(result.status).toBe("CONNECTED");
      expect(meta.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it("scopes every update to the authenticated business only — never touches another tenant's row", async () => {
      prisma.business.findUnique.mockResolvedValueOnce(disconnectedBusiness).mockResolvedValueOnce(null);
      meta.exchangeCodeForToken.mockResolvedValue("token");
      meta.registerPhoneNumber.mockResolvedValue(undefined);
      meta.subscribeAppToWaba.mockResolvedValue(undefined);
      meta.getPhoneNumberDetails.mockResolvedValue({ displayPhoneNumber: "+91 98765 43210", verifiedName: null });
      prisma.business.update.mockImplementation(({ data }: any) => Promise.resolve({ ...disconnectedBusiness, ...data }));

      await service.completeOnboarding("biz1", input);

      for (const call of prisma.business.update.mock.calls) {
        expect(call[0].where).toEqual({ id: "biz1" });
      }
    });
  });

  describe("disconnect", () => {
    it("clears the connection locally even if Meta's deauthorize call fails", async () => {
      const connected = {
        ...disconnectedBusiness, whatsappConnectionStatus: "CONNECTED",
        whatsappPhoneNumberId: "phone1", whatsappBusinessAccountId: "waba1", whatsappAccessTokenEncrypted: "iv:tag:cipher",
      };
      prisma.business.findUnique.mockResolvedValue(connected);
      meta.deauthorize.mockRejectedValue(new Error("Meta unreachable"));
      prisma.business.update.mockImplementation(({ data }: any) => Promise.resolve({ ...connected, ...data }));

      const result = await service.disconnect("biz1");
      expect(result.status).toBe("DISCONNECTED");
      expect(result.phoneNumberId).toBeNull();
    });
  });
});
