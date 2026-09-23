import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ProductStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CategoryService } from "../categories/category.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { UpdateVariantDto } from "./dto/update-variant.dto";
import { BulkUpdateProductsDto } from "./dto/bulk-update-products.dto";
import { deleteProductImageFile } from "./image-storage";
import { InventoryService } from "../inventory/inventory.service";
import { OpportunityService } from "../opportunities/opportunity.service";

const DEFAULT_INCLUDE = {
  variants: { orderBy: { createdAt: "asc" as const } },
  category: { select: { id: true, name: true } },
};

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoryService,
    private readonly inventory: InventoryService,
    private readonly opportunities: OpportunityService,
  ) {}

  async findAll(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.product.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, include: DEFAULT_INCLUDE });
  }

  /**
   * Resolves the category to attach. Prefers an explicit `categoryId` (unambiguous — what the Products page
   * sends now) over a `category` name lookup (kept for CSV import / AI-suggested categories, which only have a
   * name to work with). Name-based resolution is ambiguous whenever two categories happen to share a name, which
   * silently misattributed products to the wrong (identically-named) category before this existed.
   * Returns `undefined` to mean "leave unchanged" (only relevant for update()); `null` means "clear the category".
   */
  private async resolveCategoryId(businessId: string, input: { categoryId?: string; category?: string }): Promise<string | null | undefined> {
    if (input.categoryId !== undefined) {
      if (!input.categoryId) return null;
      const owned = await this.prisma.category.findFirst({ where: { id: input.categoryId, businessId } });
      if (!owned) throw new NotFoundException("Category not found.");
      return owned.id;
    }
    if (input.category !== undefined) return this.categories.resolveIdByName(businessId, input.category);
    return undefined;
  }

  async create(businessId: string, input: CreateProductDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    const categoryId = (await this.resolveCategoryId(businessId, input)) ?? null;
    const product = await this.prisma.product.create({
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
    if (categoryId) this.notifyNewProductMatch(business, product, categoryId).catch(() => undefined);
    return product;
  }

  /** Best-effort, fire-and-forget: tells any customer who's previously viewed/enquired about this category (but hasn't been told about this exact product yet) that something new just arrived. */
  private async notifyNewProductMatch(business: { id: string; name: string }, product: { id: string; name: string }, categoryId: string) {
    const variant = await this.prisma.variant.findFirst({ where: { productId: product.id }, orderBy: { createdAt: "asc" } });
    const interested = await this.prisma.customerSignal.findMany({
      where: { businessId: business.id, type: { in: ["PRODUCT_VIEWED", "PRODUCT_ENQUIRY"] }, product: { categoryId } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    for (const { customerId } of interested) {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { firstName: true, lastName: true } });
      const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "there";
      await this.opportunities.createWithAiMessage({
        businessId: business.id, customerId, type: "NEW_PRODUCT_MATCH",
        reason: "New arrival in a category they've previously shown interest in.",
        confidence: 0.6, relatedProductId: product.id, estimatedValue: variant ? Number(variant.price) : undefined,
        customerName, businessName: business.name, productName: product.name, price: variant ? `${variant.currency} ${variant.price}` : undefined,
      });
    }
  }

  async update(productId: string, businessId: string, input: UpdateProductDto, userId?: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId }, include: DEFAULT_INCLUDE });
    if (!product) throw new NotFoundException("Product not found.");
    const defaultVariant = product.variants[0];
    const categoryId = input.categoryId !== undefined || input.category !== undefined
      ? await this.resolveCategoryId(businessId, input)
      : undefined;

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
      let restocked = false;
      await this.prisma.$transaction(async (tx) => {
        await tx.variant.update({
          where: { id: defaultVariant.id },
          data: {
            ...(input.price !== undefined && { price: input.price }),
            ...(input.currency !== undefined && { currency: input.currency.trim() }),
            ...(input.inventory !== undefined && { inventory: input.inventory }),
            ...(input.sku !== undefined && { sku: input.sku?.trim() || null }),
          },
        });
        if (input.inventory !== undefined && input.inventory !== defaultVariant.inventory) {
          const result = await this.inventory.recordAdjustment(tx, {
            businessId, productId, variantId: defaultVariant.id,
            previousInventory: defaultVariant.inventory, newInventory: input.inventory,
            reason: "MANUAL_EDIT", createdById: userId, threshold: defaultVariant.lowStockThreshold,
          });
          restocked = result.restocked;
        }
      });
      if (restocked) await this.inventory.notifyBackInStock(businessId, productId);
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
        if (!input.categoryId?.trim() && !input.category?.trim()) throw new BadRequestException("categoryId (or category) is required for the setCategory action.");
        const categoryId = await this.resolveCategoryId(businessId, input);
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
  async updateVariant(variantId: string, businessId: string, input: UpdateVariantDto, userId?: string) {
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId } });
    if (!variant) throw new NotFoundException("Variant not found.");
    let restocked = false;
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.variant.update({
        where: { id: variantId },
        data: {
          ...(input.sku !== undefined && { sku: input.sku?.trim() || null }),
          ...(input.price !== undefined && { price: input.price }),
          ...(input.currency !== undefined && { currency: input.currency.trim() }),
          ...(input.inventory !== undefined && { inventory: input.inventory }),
          ...(input.compareAtPrice !== undefined && { compareAtPrice: input.compareAtPrice }),
          ...(input.active !== undefined && { active: input.active }),
          ...(input.lowStockThreshold !== undefined && { lowStockThreshold: input.lowStockThreshold }),
        },
      });
      if (input.inventory !== undefined && input.inventory !== variant.inventory) {
        const result = await this.inventory.recordAdjustment(tx, {
          businessId, productId: variant.productId, variantId,
          previousInventory: variant.inventory, newInventory: input.inventory,
          reason: "MANUAL_EDIT", createdById: userId, threshold: saved.lowStockThreshold,
        });
        restocked = result.restocked;
      }
      return saved;
    });
    if (restocked) await this.inventory.notifyBackInStock(businessId, variant.productId);
    return updated;
  }

  /** Replaces a product's image, deleting the previous uploaded file (if any) from disk. */
  async setImage(productId: string, businessId: string, imageUrl: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Product not found.");
    deleteProductImageFile(product.imageUrl);
    return this.prisma.product.update({ where: { id: productId }, data: { imageUrl }, include: DEFAULT_INCLUDE });
  }
}

