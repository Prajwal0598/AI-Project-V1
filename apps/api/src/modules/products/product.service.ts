import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ProductStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CategoryService } from "../categories/category.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { UpdateVariantDto } from "./dto/update-variant.dto";
import { BulkUpdateProductsDto } from "./dto/bulk-update-products.dto";
import { deleteProductImageFile } from "./image-storage";

const DEFAULT_INCLUDE = {
  variants: { orderBy: { createdAt: "asc" as const } },
  category: { select: { id: true, name: true } },
};

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoryService,
  ) {}

  async findAll(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, include: DEFAULT_INCLUDE });
  }

  async create(businessId: string, input: CreateProductDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    const categoryId = await this.categories.resolveIdByName(businessId, input.category);
    return this.prisma.product.create({
      data: {
        businessId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        categoryId,
        brand: input.brand?.trim() || null,
        status: input.status ?? ProductStatus.PUBLISHED,
        variants: {
          create: {
            businessId,
            sku: input.sku?.trim() || null,
            price: input.price,
            currency: input.currency?.trim() || "INR",
            inventory: input.inventory ?? null,
          },
        },
      },
      include: DEFAULT_INCLUDE,
    });
  }

  async update(productId: string, businessId: string, input: UpdateProductDto) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId }, include: DEFAULT_INCLUDE });
    if (!product) throw new NotFoundException("Product not found.");
    const defaultVariant = product.variants[0];
    const categoryId = input.category !== undefined ? await this.categories.resolveIdByName(businessId, input.category) : undefined;

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description?.trim() || null }),
        ...(categoryId !== undefined && { categoryId }),
        ...(input.brand !== undefined && { brand: input.brand?.trim() || null }),
        ...(input.status !== undefined && { status: input.status }),
      },
      include: DEFAULT_INCLUDE,
    });

    // price/currency/inventory/sku live on the default variant — update it in place when provided
    if (defaultVariant && (input.price !== undefined || input.currency !== undefined || input.inventory !== undefined || input.sku !== undefined)) {
      await this.prisma.variant.update({
        where: { id: defaultVariant.id },
        data: {
          ...(input.price !== undefined && { price: input.price }),
          ...(input.currency !== undefined && { currency: input.currency.trim() }),
          ...(input.inventory !== undefined && { inventory: input.inventory }),
          ...(input.sku !== undefined && { sku: input.sku?.trim() || null }),
        },
      });
      return this.prisma.product.findUnique({ where: { id: productId }, include: DEFAULT_INCLUDE });
    }

    return updated;
  }

  /** Permanently removes a product and its variants (order history is preserved — OrderItem snapshots name/price and just loses the productId/variantId link). */
  async remove(productId: string, businessId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Product not found.");
    deleteProductImageFile(product.imageUrl);
    await this.prisma.product.delete({ where: { id: productId } });
    return { id: productId };
  }

  /** Applies one action to many products at once — used by the Products page's multi-select toolbar. */
  async bulkUpdate(businessId: string, input: BulkUpdateProductsDto) {
    const owned = await this.prisma.product.findMany({ where: { id: { in: input.productIds }, businessId }, select: { id: true, imageUrl: true } });
    if (!owned.length) throw new NotFoundException("No matching products found.");
    const ids = owned.map((p) => p.id);

    switch (input.action) {
      case "publish":
        await this.prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: ProductStatus.PUBLISHED } });
        break;
      case "hide":
        await this.prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: ProductStatus.HIDDEN } });
        break;
      case "draft":
        await this.prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: ProductStatus.DRAFT } });
        break;
      case "setCategory": {
        if (!input.category?.trim()) throw new BadRequestException("category is required for the setCategory action.");
        const categoryId = await this.categories.resolveIdByName(businessId, input.category);
        await this.prisma.product.updateMany({ where: { id: { in: ids } }, data: { categoryId } });
        break;
      }
      case "delete":
        for (const p of owned) deleteProductImageFile(p.imageUrl);
        await this.prisma.product.deleteMany({ where: { id: { in: ids } } });
        break;
    }
    return { affected: ids.length };
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
    return this.prisma.product.update({ where: { id: productId }, data: { imageUrl }, include: DEFAULT_INCLUDE });
  }
}

