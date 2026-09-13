import { Injectable } from "@nestjs/common";
import { InventoryAlertType, Prisma, StockAdjustmentReason } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CustomerSignalService } from "../customer-signals/customer-signal.service";
import { OpportunityService } from "../opportunities/opportunity.service";

interface RecordAdjustmentInput {
  businessId: string;
  productId: string;
  variantId: string;
  previousInventory: number | null;
  newInventory: number | null;
  reason: StockAdjustmentReason;
  note?: string;
  createdById?: string;
  /** per-variant override, falls back to the business default when omitted */
  threshold?: number | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signals: CustomerSignalService,
    private readonly opportunities: OpportunityService,
  ) {}

  /**
   * Logs a StockAdjustment row and re-evaluates the variant's alert state — call this from within the SAME
   * transaction as the inventory change itself (order reservation/release, manual edit, import) so the audit
   * trail and alert state can never drift out of sync with the actual stock value. Returns whether this specific
   * change just brought a previously OUT_OF_STOCK variant back into stock, so the caller can trigger customer
   * back-in-stock notifications AFTER its own transaction commits (never from inside one — that call hits OpenAI).
   */
  async recordAdjustment(tx: Prisma.TransactionClient, input: RecordAdjustmentInput): Promise<{ restocked: boolean }> {
    const delta = (input.newInventory ?? 0) - (input.previousInventory ?? 0);
    await tx.stockAdjustment.create({
      data: {
        businessId: input.businessId,
        productId: input.productId,
        variantId: input.variantId,
        delta,
        previousInventory: input.previousInventory,
        newInventory: input.newInventory,
        reason: input.reason,
        note: input.note,
        createdById: input.createdById,
      },
    });
    return this.evaluateAlert(tx, input);
  }

  private async evaluateAlert(tx: Prisma.TransactionClient, input: RecordAdjustmentInput): Promise<{ restocked: boolean }> {
    if (input.newInventory === null) return { restocked: false }; // untracked stock never alerts

    // input.threshold is the variant's OWN override; null means "no override" (not "unspecified"), so both
    // null and undefined fall through to the business default here
    let threshold = input.threshold;
    if (threshold == null) {
      const business = await tx.business.findUnique({ where: { id: input.businessId }, select: { defaultLowStockThreshold: true } });
      threshold = business?.defaultLowStockThreshold ?? 5;
    }

    const desiredType: InventoryAlertType | null =
      input.newInventory === 0 ? InventoryAlertType.OUT_OF_STOCK
      : input.newInventory > 0 && input.newInventory <= threshold ? InventoryAlertType.LOW_STOCK
      : null;

    const existing = await tx.inventoryAlert.findFirst({ where: { variantId: input.variantId, status: "ACTIVE" } });
    // "restocked" is customer-facing availability coming back (0 -> any positive quantity) — independent of
    // whether the merchant's own low-stock threshold still applies; that's a separate, merchant-only concern
    const restocked = existing?.type === InventoryAlertType.OUT_OF_STOCK && input.newInventory > 0;

    if (!desiredType) {
      if (existing) await tx.inventoryAlert.update({ where: { id: existing.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
      return { restocked };
    }

    if (existing) {
      if (existing.type !== desiredType || existing.inventoryAtTrigger !== input.newInventory) {
        await tx.inventoryAlert.update({ where: { id: existing.id }, data: { type: desiredType, inventoryAtTrigger: input.newInventory, threshold } });
      }
      return { restocked };
    }

    await tx.inventoryAlert.create({
      data: {
        businessId: input.businessId,
        productId: input.productId,
        variantId: input.variantId,
        type: desiredType,
        inventoryAtTrigger: input.newInventory,
        threshold,
      },
    });
    return { restocked };
  }

  /** Notifies (via a proactive suggestion) every customer who recently showed interest in this product while it was unavailable. Call this AFTER the transaction that restocked it commits. */
  async notifyBackInStock(businessId: string, productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId }, include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } });
    if (!product) return;
    const variant = product.variants[0];
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) return;

    const customerIds = await this.signals.recentlyInterestedCustomers(businessId, productId);
    for (const customerId of customerIds) {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
      const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "there";
      await this.opportunities.createWithAiMessage({
        businessId, customerId, type: "BACK_IN_STOCK",
        reason: `Previously showed interest in ${product.name} while it was out of stock — now back in stock.`,
        estimatedValue: variant ? Number(variant.price) : undefined, confidence: 0.8, relatedProductId: productId,
        customerName, businessName: business.name, productName: product.name, price: variant ? `${variant.currency} ${variant.price}` : undefined,
      });
    }
  }

  async listActiveAlerts(businessId: string) {
    return this.prisma.inventoryAlert.findMany({
      where: { businessId, status: "ACTIVE" },
      include: { product: { select: { id: true, name: true, imageUrl: true } }, variant: { select: { id: true, sku: true, attributes: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async listAdjustments(businessId: string, variantId?: string, limit = 50) {
    return this.prisma.stockAdjustment.findMany({
      where: { businessId, ...(variantId ? { variantId } : {}) },
      include: { product: { select: { id: true, name: true } }, variant: { select: { id: true, sku: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
