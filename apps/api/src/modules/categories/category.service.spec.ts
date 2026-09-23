import { BadRequestException } from "@nestjs/common";
import { CategoryService } from "./category.service";
import type { PrismaService } from "../../database/prisma.service";

describe("CategoryService", () => {
  let prisma: any;
  let service: CategoryService;

  beforeEach(() => {
    prisma = {
      category: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      product: { updateMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new CategoryService(prisma as unknown as PrismaService);
  });

  describe("create", () => {
    it("rejects a name that already exists (case-insensitive) for the same parent — this is what let products end up under an unrelated duplicate", async () => {
      prisma.category.findFirst.mockResolvedValue({ id: "cat-existing", name: "Bags" });
      await expect(service.create("biz1", { name: "bags" } as any)).rejects.toThrow(BadRequestException);
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it("creates the category when the name is unique", async () => {
      prisma.category.findFirst.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue({ id: "cat1", name: "Bags" });
      const result = await service.create("biz1", { name: "Bags" } as any);
      expect(result).toEqual({ id: "cat1", name: "Bags" });
    });
  });

  describe("mergeDuplicates", () => {
    it("keeps the duplicate with the most products, reassigns everything from the rest onto it, and deletes the duplicates", async () => {
      prisma.category.findMany.mockResolvedValue([
        { id: "cat-old", name: "Bags", parentId: null, createdAt: new Date("2026-01-01"), _count: { products: 1 } },
        { id: "cat-new", name: "bags", parentId: null, createdAt: new Date("2026-02-01"), _count: { products: 5 } },
      ]);

      const result = await service.mergeDuplicates("biz1");

      expect(result).toEqual({ duplicatesMerged: 1 });
      expect(prisma.product.updateMany).toHaveBeenCalledWith({ where: { categoryId: { in: ["cat-old"] } }, data: { categoryId: "cat-new" } });
      expect(prisma.category.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-old"] } } });
    });

    it("does nothing when there are no duplicates", async () => {
      prisma.category.findMany.mockResolvedValue([
        { id: "cat1", name: "Bags", parentId: null, createdAt: new Date(), _count: { products: 2 } },
        { id: "cat2", name: "Shirts", parentId: null, createdAt: new Date(), _count: { products: 3 } },
      ]);

      const result = await service.mergeDuplicates("biz1");

      expect(result).toEqual({ duplicatesMerged: 0 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
