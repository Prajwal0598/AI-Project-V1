import { BusinessService } from "./business.service";
import type { PrismaService } from "../../database/prisma.service";

// Embedded Signup records which Facebook user authorised a business's WhatsApp connection (MetaUserLink). Credentials the
// merchant types in by hand replace that connection, so those links must stop being active — but only for a real change.
describe("BusinessService.update — Meta authoriser links", () => {
  const ORIGINAL_ENV = { ...process.env };
  const existing = { id: "biz1", name: "Shop", whatsappPhoneNumberId: "phone-1" };
  let prisma: any;
  let service: BusinessService;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) };
    prisma = {
      business: { findUnique: jest.fn().mockResolvedValue(existing), update: jest.fn().mockResolvedValue({ ...existing }) },
      metaUserLink: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    service = new BusinessService(prisma as unknown as PrismaService);
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it("supersedes the active links of that business only when a WhatsApp access token is pasted in", async () => {
    await service.update("biz1", { whatsappAccessToken: "EAAG_pasted" });

    expect(prisma.metaUserLink.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.metaUserLink.updateMany).toHaveBeenCalledWith({ where: { businessId: "biz1", revokedAt: null }, data: { revokedAt: expect.any(Date), revokedReason: "SUPERSEDED" } });
  });

  it("supersedes them when the phone number id actually changes", async () => {
    await service.update("biz1", { whatsappPhoneNumberId: "phone-2" });
    expect(prisma.metaUserLink.updateMany).toHaveBeenCalledTimes(1);
  });

  it("supersedes them when the phone number id is cleared", async () => {
    await service.update("biz1", { whatsappPhoneNumberId: "" });
    expect(prisma.metaUserLink.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not touch them when the phone number id is resent unchanged (every Settings save does this)", async () => {
    await service.update("biz1", { whatsappPhoneNumberId: " phone-1 ", name: "Renamed" });
    expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
  });

  it("does not touch them for unrelated settings", async () => {
    await service.update("biz1", { name: "Renamed", timezone: "Asia/Kolkata" });
    expect(prisma.metaUserLink.updateMany).not.toHaveBeenCalled();
  });
});
