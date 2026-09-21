import { PlatformAdminService } from "./platform-admin.service";
import type { PrismaService } from "../../database/prisma.service";

describe("PlatformAdminService", () => {
  let prisma: any;
  let service: PlatformAdminService;

  beforeEach(() => {
    prisma = {
      business: { count: jest.fn(), findMany: jest.fn() },
      order: { count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
      customer: { count: jest.fn() },
    };
    service = new PlatformAdminService(prisma as unknown as PrismaService);
  });

  describe("overview", () => {
    it("aggregates totals across every business (no businessId filter)", async () => {
      prisma.business.count.mockResolvedValue(3);
      prisma.order.count.mockResolvedValue(42);
      prisma.order.aggregate.mockResolvedValue({ _sum: { total: 150000 } });
      prisma.customer.count.mockResolvedValue(120);

      const result = await service.overview();

      expect(result).toEqual({ merchants: 3, orders: 42, revenue: 150000, customers: 120 });
      expect(prisma.order.aggregate).toHaveBeenCalledWith({ where: { status: { in: ["PAID", "FULFILLED"] } }, _sum: { total: true } });
    });

    it("defaults revenue to 0 when there are no qualifying orders yet", async () => {
      prisma.business.count.mockResolvedValue(0);
      prisma.order.count.mockResolvedValue(0);
      prisma.order.aggregate.mockResolvedValue({ _sum: { total: null } });
      prisma.customer.count.mockResolvedValue(0);

      const result = await service.overview();
      expect(result.revenue).toBe(0);
    });
  });

  describe("businesses", () => {
    it("merges per-business order count and revenue onto each business, defaulting to 0 for merchants with no orders", async () => {
      prisma.business.findMany.mockResolvedValue([
        { id: "b1", name: "Merchant One", industry: "Retail", createdAt: new Date("2026-01-01"), whatsappPhoneNumberId: "WA1", instagramPageId: null },
        { id: "b2", name: "Merchant Two", industry: null, createdAt: new Date("2026-02-01"), whatsappPhoneNumberId: null, instagramPageId: null },
      ]);
      prisma.order.groupBy
        .mockResolvedValueOnce([{ businessId: "b1", _count: { _all: 10 } }]) // orders (all statuses)
        .mockResolvedValueOnce([{ businessId: "b1", _sum: { total: 5000 } }]); // revenue (paid/fulfilled only)

      const result = await service.businesses();

      expect(result).toEqual([
        { id: "b1", name: "Merchant One", industry: "Retail", createdAt: new Date("2026-01-01"), whatsappConnected: true, instagramConnected: false, orders: 10, revenue: 5000 },
        { id: "b2", name: "Merchant Two", industry: null, createdAt: new Date("2026-02-01"), whatsappConnected: false, instagramConnected: false, orders: 0, revenue: 0 },
      ]);
    });
  });
});
