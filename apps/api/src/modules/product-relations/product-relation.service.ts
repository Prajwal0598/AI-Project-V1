import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ProductRelationType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

const INCLUDE = { relatedProduct: { select: { id: true, name: true, imageUrl: true, variants: { take: 1, orderBy: { createdAt: "asc" as const } } } } };

@Injectable()
export class ProductRelationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string, productId: string) {
    return this.prisma.productRelation.findMany({ where: { businessId, productId }, include: INCLUDE, orderBy: { createdAt: "desc" } });
  }

  async create(businessId: string, input: { productId: string; relatedProductId: string; type: ProductRelationType }) {
    if (input.productId === input.relatedProductId) throw new BadRequestException("A product can't be related to itself.");
    const [product, related] = await Promise.all([
      this.prisma.product.findFirst({ where: { id: input.productId, businessId } }),
      this.prisma.product.findFirst({ where: { id: input.relatedProductId, businessId } }),
    ]);
    if (!product || !related) throw new NotFoundException("Product not found.");
    try {
      return await this.prisma.productRelation.create({
        data: { businessId, productId: input.productId, relatedProductId: input.relatedProductId, type: input.type },
        include: INCLUDE,
      });
    } catch {
      throw new ConflictException("This relation already exists.");
    }
  }

  async remove(id: string, businessId: string) {
    const relation = await this.prisma.productRelation.findFirst({ where: { id, businessId } });
    if (!relation) throw new NotFoundException("Relation not found.");
    await this.prisma.productRelation.delete({ where: { id } });
    return { id };
  }

  /** Used by OrderService after a purchase completes — the products to suggest, keyed by relation type. */
  async getRelationsFor(businessId: string, productId: string) {
    return this.prisma.productRelation.findMany({
      where: { businessId, productId },
      include: { relatedProduct: { include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
  }
}
