import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
  }

  async create(businessId: string, input: CreateProductDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.create({
      data: {
        businessId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        price: input.price,
        currency: input.currency?.trim() || "INR",
        inventory: input.inventory ?? null,
        active: input.active ?? true,
      },
    });
  }

  async update(productId: string, businessId: string, input: UpdateProductDto) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Product not found.");
    return this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description?.trim() || null }),
        ...(input.price !== undefined && { price: input.price }),
        ...(input.currency !== undefined && { currency: input.currency.trim() }),
        ...(input.inventory !== undefined && { inventory: input.inventory }),
        ...(input.active !== undefined && { active: input.active }),
      },
    });
  }
}
