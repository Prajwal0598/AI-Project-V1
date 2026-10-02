import { EntitlementService } from "./entitlement.service";
import type { PrismaService } from "../../database/prisma.service";

describe("EntitlementService.canUseRelay", () => {
  let prisma: any;
  let entitlements: EntitlementService;

  beforeEach(() => {
    prisma = { subscription: { findUnique: jest.fn() } };
    entitlements = new EntitlementService(prisma as unknown as PrismaService);
  });

  it("restricts a business that never started billing at all (no subscription row)", async () => {
    prisma.subscription.findUnique.mockResolvedValue(null);
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });

  it("allows TRIAL before trialEnd", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "TRIAL", trialEnd: new Date(Date.now() + 86400000), currentPeriodEnd: null });
    expect(await entitlements.canUseRelay("biz1")).toBe(true);
  });

  it("restricts TRIAL once trialEnd has passed (webhook never arrived)", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "TRIAL", trialEnd: new Date(Date.now() - 1000), currentPeriodEnd: null });
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });

  it("always allows ACTIVE", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "ACTIVE", trialEnd: null, currentPeriodEnd: new Date(Date.now() - 999999) });
    expect(await entitlements.canUseRelay("biz1")).toBe(true);
  });

  it("allows PAYMENT_FAILED — recovery is still in progress", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "PAYMENT_FAILED", trialEnd: null, currentPeriodEnd: new Date(Date.now() - 999999) });
    expect(await entitlements.canUseRelay("biz1")).toBe(true);
  });

  it("allows PAST_DUE within the configured grace window", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "PAST_DUE", trialEnd: null, currentPeriodEnd: new Date(Date.now() - 1000) }); // 1s ago, well within default 3-day grace
    expect(await entitlements.canUseRelay("biz1")).toBe(true);
  });

  it("restricts PAST_DUE once the grace window has elapsed", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "PAST_DUE", trialEnd: null, currentPeriodEnd: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) }); // 10 days ago
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });

  it("allows CANCELLED while the already-paid-for period is still live", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "CANCELLED", trialEnd: null, currentPeriodEnd: new Date(Date.now() + 86400000) });
    expect(await entitlements.canUseRelay("biz1")).toBe(true);
  });

  it("restricts CANCELLED once the period has actually ended", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "CANCELLED", trialEnd: null, currentPeriodEnd: new Date(Date.now() - 1000) });
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });

  it("restricts EXPIRED", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "EXPIRED", trialEnd: null, currentPeriodEnd: null });
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });

  it("restricts SUSPENDED", async () => {
    prisma.subscription.findUnique.mockResolvedValue({ status: "SUSPENDED", trialEnd: null, currentPeriodEnd: null });
    expect(await entitlements.canUseRelay("biz1")).toBe(false);
  });
});
