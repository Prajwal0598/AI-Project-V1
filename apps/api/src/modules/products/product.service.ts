import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { UpdateVariantDto } from "./dto/update-variant.dto";
import { deleteProductImageFile } from "./image-storage";

const DEFAULT_VARIANT_ORDER = { variants: { orderBy: { createdAt: "asc" as const } } };

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, include: DEFAULT_VARIANT_ORDER });
  }

  async create(businessId: string, input: CreateProductDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.create({
      data: {
        businessId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        category: input.category?.trim() || null,
        brand: input.brand?.trim() || null,
        active: input.active ?? true,
        variants: {
          create: {
            businessId,
            sku: input.sku?.trim() || null,
            price: input.price,
            currency: input.currency?.trim() || "INR",
            inventory: input.inventory ?? null,
            active: input.active ?? true,
          },
        },
      },
      include: DEFAULT_VARIANT_ORDER,
    });
  }

  async update(productId: string, businessId: string, input: UpdateProductDto) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId }, include: DEFAULT_VARIANT_ORDER });
    if (!product) throw new NotFoundException("Product not found.");
    const defaultVariant = product.variants[0];

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description?.trim() || null }),
        ...(input.category !== undefined && { category: input.category?.trim() || null }),
        ...(input.brand !== undefined && { brand: input.brand?.trim() || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
      include: DEFAULT_VARIANT_ORDER,
    });

    // price/currency/inventory/sku live on the default variant — update it in place when provided
    if (defaultVariant && (input.price !== undefined || input.currency !== undefined || input.inventory !== undefined || input.sku !== undefined || input.active !== undefined)) {
      await this.prisma.variant.update({
        where: { id: defaultVariant.id },
        data: {
          ...(input.price !== undefined && { price: input.price }),
          ...(input.currency !== undefined && { currency: input.currency.trim() }),
          ...(input.inventory !== undefined && { inventory: input.inventory }),
          ...(input.sku !== undefined && { sku: input.sku?.trim() || null }),
          ...(input.active !== undefined && { active: input.active }),
        },
      });
      return this.prisma.product.findUnique({ where: { id: productId }, include: DEFAULT_VARIANT_ORDER });
    }

    return updated;
  }

  /** Updates one specific variant of a product (price/sku/inventory/etc.) — used by the product edit UI for multi-variant products. */
  async updateVariant(variantId: string, businessId: string, input: UpdateVariantDto) {
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId } });
    if (!variant) throw new NotFoundException("Variant not found.");
    return this.prisma.variant.update({
      where: { id: variantId },
      data: {
        ...(input.sku !== undefined && { sku: input.sku?.trim() || null }),
        ...(input.price !== undefined && { price: input.price }),
        ...(input.currency !== undefined && { currency: input.currency.trim() }),
        ...(input.inventory !== undefined && { inventory: input.inventory }),
        ...(input.compareAtPrice !== undefined && { compareAtPrice: input.compareAtPrice }),
        ...(input.active !== undefined && { active: input.active }),
      },
    });
  }

  /** Replaces a product's image, deleting the previous uploaded file (if any) from disk. */
  async setImage(productId: string, businessId: string, imageUrl: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Product not found.");
    deleteProductImageFile(product.imageUrl);
    return this.prisma.product.update({ where: { id: productId }, data: { imageUrl }, include: DEFAULT_VARIANT_ORDER });
  }
}

