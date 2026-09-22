import { NotFoundException } from "@nestjs/common";
import { PromotionService } from "./promotion.service";
import type { PrismaService } from "../../database/prisma.service";
import type { OpportunityService } from "../opportunities/opportunity.service";

describe("PromotionService.setImage", () => {
  let prisma: any;
  let service: PromotionService;

  beforeEach(() => {
    prisma = {
      promotion: { findFirst: jest.fn(), update: jest.fn() },
    };
    service = new PromotionService(prisma as unknown as PrismaService, {} as unknown as OpportunityService);
  });

  it("throws if the promotion doesn't exist (or isn't owned by this business)", async () => {
    prisma.promotion.findFirst.mockResolvedValue(null);
    await expect(service.setImage("missing", "biz1", "/uploads/promotions/new.jpg")).rejects.toThrow(NotFoundException);
  });

  it("throws once the promotion has already been broadcast", async () => {
    prisma.promotion.findFirst.mockResolvedValue({ id: "p1", broadcastedAt: new Date(), imageUrl: null });
    await expect(service.setImage("p1", "biz1", "/uploads/promotions/new.jpg")).rejects.toThrow(NotFoundException);
  });

  it("sets the image on a draft (not yet broadcast) promotion", async () => {
    prisma.promotion.findFirst.mockResolvedValue({ id: "p1", broadcastedAt: null, imageUrl: null });
    prisma.promotion.update.mockResolvedValue({ id: "p1", imageUrl: "/uploads/promotions/new.jpg" });

    const result = await service.setImage("p1", "biz1", "/uploads/promotions/new.jpg");

    expect(prisma.promotion.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { imageUrl: "/uploads/promotions/new.jpg" } });
    expect(result.imageUrl).toBe("/uploads/promotions/new.jpg");
  });
});
