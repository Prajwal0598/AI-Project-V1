import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEventType, FulfillmentStatus, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { CreateOrderDto, OrderItemInputDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { InventoryService } from "../inventory/inventory.service";
import { OpportunityService } from "../opportunities/opportunity.service";
import { ProductRelationService } from "../product-relations/product-relation.service";
import { ConversationService } from "../conversations/conversation.service";

// terminal statuses that cannot transition further
const TERMINAL_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);
// an order can still have its items/address changed by the customer up until it's paid
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT]);

// customer-facing copy for a merchant manually setting an order to one of these lifecycle statuses —
// mirrors the wording the simulated/automatic order-progress worker job already sends for consistency
const ORDER_STATUS_MESSAGES: Partial<Record<OrderStatus, string>> = {
  PAID: "🎉 Payment received! Your order has been confirmed and will be shipped soon.",
  FULFILLED: "✅ Your order has been delivered. Thanks for shopping with us!",
  CANCELLED: "❌ Your order has been cancelled. If you have any questions, just reply here and we'll help you out.",
  REFUNDED: "💸 Your order has been refunded. The amount should reflect in your account shortly.",
};

// customer-facing copy for each shipment-tracking stage a merchant manually advances
const FULFILLMENT_STATUS_MESSAGES: Partial<Record<FulfillmentStatus, string>> = {
  PACKED: "📦 Your order has been packed and is ready for pickup by our courier.",
  SHIPPED: "🚚 Your order has shipped!",
  OUT_FOR_DELIVERY: "🛵 Your order is out for delivery today.",
  DELIVERED: "✅ Your order has been delivered. Thanks for shopping with us!",
  FAILED: "We were unable to deliver your order.",
  RETURNED: "Your order has been returned to us.",
};

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly inventory: InventoryService,
    private readonly opportunities: OpportunityService,
    private readonly productRelations: ProductRelationService,
    private readonly conversations: ConversationService,
  ) {}

  /** Best-effort customer notification for an order lifecycle change — never blocks/fails the actual update. */
  private async notifyOrderUpdate(conversationId: string | null, businessId: string, content: string | undefined): Promise<void> {
    if (!conversationId || !content) return;
    try {
      await this.conversations.sendMessage(conversationId, businessId, content);
    } catch (err) {
      console.error(`[orders] failed to notify conversation ${conversationId} of order update`, err);
    }
  }

  async findAll(businessId: string) {
    return this.prisma.order.findMany({
      where: { businessId },
      include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getRecentForCustomer(customerId: string, businessId: string, limit = 3) {
    return this.prisma.order.findMany({
      where: { customerId, businessId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async create(businessId: string, input: CreateOrderDto) {
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });

    const shippingFee = input.shippingFee ?? 0;

    const order = await this.prisma.$transaction(async (tx) => {
      await this.reserveStock(tx, businessId, input.items ?? []);
      const subtotal = input.items?.length ? input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) : input.subtotal;
      const total = subtotal + shippingFee;
      // orders with a payment method already chosen (e.g. via the AI conversational flow) are ready to proceed
      // straight to PENDING_PAYMENT and start the simulated autonomous payment/shipment progression — unless the
      // total exceeds the merchant's autonomy threshold, in which case it waits for a human to approve it first
      const exceedsAutonomyLimit = business?.autonomyMaxOrderValue != null && total > Number(business.autonomyMaxOrderValue);
      const initialStatus = !input.paymentMethod ? OrderStatus.DRAFT : exceedsAutonomyLimit ? OrderStatus.AWAITING_APPROVAL : OrderStatus.PENDING_PAYMENT;

      const created = await tx.order.create({
        data: {
          businessId,
          customerId: input.customerId,
          conversationId: input.conversationId ?? null,
          subtotal,
          shippingFee,
          total,
          currency: input.currency?.trim() || "INR",
          shippingAddress: (input.shippingAddress ?? undefined) as object | undefined,
          paymentMethod: input.paymentMethod?.trim() || null,
          status: initialStatus,
          items: input.items?.length
            ? { create: input.items.map((i) => ({ productId: i.productId ?? null, variantId: i.variantId ?? null, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) }
            : undefined,
        },
        include: { items: true },
      });
      return created;
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: input.customerId, type: ActivityEventType.ORDER_PLACED, summary: `Order placed — ${order.currency} ${order.total}` },
    });
    await recalculateLeadScore(this.prisma, input.customerId, businessId);
    await this.opportunities.attachOrderOutcome(businessId, input.customerId, order);
    await this.suggestCrossSellUpsell(businessId, input.customerId, order.items, customer, business?.name ?? "our store");

    // approval-pending orders don't start the payment/fulfillment simulation until a human approves them
    if (input.paymentMethod && order.status === OrderStatus.PENDING_PAYMENT) await this.queues.scheduleOrderProgress(order.id, businessId);
    // safety net: auto-cancel and release stock if the order is abandoned in either waiting state
    if (order.status === OrderStatus.PENDING_PAYMENT || order.status === OrderStatus.AWAITING_APPROVAL) {
      await this.queues.scheduleOrderExpiry(order.id, businessId, order.status);
    }

    return order;
  }

  /** Approves an order that exceeded the merchant's autonomy threshold, letting payment/fulfillment proceed. */
  async approve(orderId: string, businessId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId } });
    if (!order) throw new NotFoundException("Order not found.");
    if (order.status !== OrderStatus.AWAITING_APPROVAL) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and is not awaiting approval.`);
    }
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.PENDING_PAYMENT } });
    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order approved by merchant — ${updated.currency} ${updated.total}` },
    });
    await this.queues.scheduleOrderProgress(order.id, businessId);
    await this.queues.scheduleOrderExpiry(order.id, businessId, OrderStatus.PENDING_PAYMENT);
    await this.notifyOrderUpdate(order.conversationId, businessId, "✅ Good news — your order has been approved and is now being processed!");
    return updated;
  }

  /** Manually advances (or corrects) an order's shipment tracking — only once the order is actually paid. */
  async updateFulfillmentStatus(orderId: string, businessId: string, status: FulfillmentStatus) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId } });
    if (!order) throw new NotFoundException("Order not found.");
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.FULFILLED) {
      throw new BadRequestException("Fulfillment can only be tracked once the order is paid.");
    }
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        fulfillmentStatus: status,
        // DELIVERED completes the order lifecycle; FAILED/RETURNED are left for the merchant to resolve manually
        ...(status === FulfillmentStatus.DELIVERED ? { status: OrderStatus.FULFILLED } : {}),
      },
    });
    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Fulfillment updated — ${status.replace(/_/g, " ").toLowerCase()}` },
    });
    await this.notifyOrderUpdate(order.conversationId, businessId, FULFILLMENT_STATUS_MESSAGES[status]);
    return updated;
  }

  /** Replaces an amendable order's items entirely (releasing old stock, reserving new stock) and recomputes totals. */
  async replaceItems(orderId: string, businessId: string, items: OrderItemInputDto[], shippingAddress?: Record<string, unknown>) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId }, include: { items: true } });
    if (!order) throw new NotFoundException("Order not found.");
    if (!AMENDABLE_STATUSES.has(order.status)) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and can no longer be changed.`);
    }
    if (!items.length) throw new BadRequestException("At least one item is required.");
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });

    const updated = await this.prisma.$transaction(async (tx) => {
      const restocked = await this.releaseStock(tx, order.items);
      await this.reserveStock(tx, businessId, items);
      await tx.orderItem.deleteMany({ where: { orderId } });
      const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const total = subtotal + Number(order.shippingFee);
      // if the amended total now exceeds the autonomy threshold, it needs a fresh human approval even if it was already approved/pending payment
      const exceedsAutonomyLimit = business?.autonomyMaxOrderValue != null && total > Number(business.autonomyMaxOrderValue);
      const status = exceedsAutonomyLimit && order.status === OrderStatus.PENDING_PAYMENT ? OrderStatus.AWAITING_APPROVAL : order.status;
      const result = await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal,
          total,
          status,
          shippingAddress: (shippingAddress ?? order.shippingAddress ?? undefined) as object | undefined,
          items: { create: items.map((i) => ({ productId: i.productId ?? null, variantId: i.variantId ?? null, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) },
        },
        include: { items: true },
      });
      return { order: result, restocked };
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order items updated — new total ${updated.order.currency} ${updated.order.total}` },
    });
    await recalculateLeadScore(this.prisma, order.customerId, businessId);
    for (const productId of updated.restocked) await this.inventory.notifyBackInStock(businessId, productId);

    return updated.order;
  }

  async updateStatus(orderId: string, businessId: string, input: UpdateOrderStatusDto) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId }, include: { items: true } });
    if (!order) throw new NotFoundException("Order not found.");
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and cannot be updated.`);
    }

    const releasingStock = input.status === OrderStatus.CANCELLED || input.status === OrderStatus.REFUNDED;
    const { updated, restocked } = await this.prisma.$transaction(async (tx) => {
      const restockedIds = releasingStock ? await this.releaseStock(tx, order.items) : [];
      const result = await tx.order.update({ where: { id: orderId }, data: { status: input.status } });
      return { updated: result, restocked: restockedIds };
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order status changed to ${input.status.replace("_", " ").toLowerCase()}` },
    });
    // recalculate lead score since a paid/fulfilled status now contributes to the score
    await recalculateLeadScore(this.prisma, order.customerId, businessId);
    // label the conversation as a completed sale for CRM/revenue reporting
    if (order.conversationId && (input.status === OrderStatus.PAID || input.status === OrderStatus.FULFILLED)) {
      await this.prisma.conversation.update({ where: { id: order.conversationId }, data: { outcome: "SALE" } });
    }
    for (const productId of restocked) await this.inventory.notifyBackInStock(businessId, productId);
    await this.notifyOrderUpdate(order.conversationId, businessId, ORDER_STATUS_MESSAGES[input.status]);

    return updated;
  }

  /** After a purchase, suggests any merchant-configured cross-sell/upsell companions for the products just bought. */
  private async suggestCrossSellUpsell(businessId: string, customerId: string, items: { productId: string | null; name: string }[], customer: { firstName: string | null; lastName: string | null } | null, businessName: string) {
    const purchasedProductIds = new Set(items.map((i) => i.productId).filter((id): id is string => !!id));
    if (!purchasedProductIds.size) return;
    const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "there";

    for (const item of items) {
      if (!item.productId) continue;
      const relations = await this.productRelations.getRelationsFor(businessId, item.productId);
      for (const relation of relations) {
        if (purchasedProductIds.has(relation.relatedProductId)) continue; // don't suggest something already in this same order
        const variant = relation.relatedProduct.variants[0];
        if (!variant) continue;
        await this.opportunities.createWithAiMessage({
          businessId, customerId, type: relation.type,
          reason: relation.type === "CROSS_SELL"
            ? `Bought ${item.name}, which pairs with ${relation.relatedProduct.name}.`
            : `Bought ${item.name} — ${relation.relatedProduct.name} is a premium alternative worth mentioning next time.`,
          estimatedValue: Number(variant.price), confidence: 0.7, relatedProductId: relation.relatedProductId,
          customerName, businessName, productName: relation.relatedProduct.name, price: `${variant.currency} ${variant.price}`, basedOnProductName: item.name,
        });
      }
    }
  }

  /** Validates stock for items linked to a real variant and decrements it — throws if any item is out of stock. */
  private async reserveStock(tx: Prisma.TransactionClient, businessId: string, items: OrderItemInputDto[]) {
    for (const item of items) {
      if (!item.variantId) continue; // free-text items with no catalogue link have no stock to track
      const variant = await tx.variant.findFirst({ where: { id: item.variantId, businessId } });
      if (!variant) throw new BadRequestException(`Product not found: ${item.name}`);
      if (variant.inventory === null) continue; // untracked stock

      // conditional update: only decrements if stock is still sufficient at the moment the row is written,
      // so two concurrent orders for the last unit can't both pass a stale read and oversell
      const result = await tx.variant.updateMany({
        where: { id: variant.id, inventory: { gte: item.quantity } },
        data: { inventory: { decrement: item.quantity } },
      });
      if (result.count === 0) {
        throw new BadRequestException(`Not enough stock for "${item.name}" — only ${variant.inventory} left.`);
      }
      await this.inventory.recordAdjustment(tx, {
        businessId, productId: variant.productId, variantId: variant.id,
        previousInventory: variant.inventory, newInventory: variant.inventory - item.quantity,
        reason: "ORDER_RESERVED", threshold: variant.lowStockThreshold,
      });
    }
  }

  /** Restores stock for an order's items — used on cancellation/refund and before replacing an order's items.
   * Returns the productIds that came back into stock, so the caller can notify interested customers after its transaction commits. */
  private async releaseStock(tx: Prisma.TransactionClient, items: { variantId: string | null; quantity: number }[]): Promise<string[]> {
    const restockedProductIds: string[] = [];
    for (const item of items) {
      if (!item.variantId) continue;
      const variant = await tx.variant.findUnique({ where: { id: item.variantId } });
      if (variant?.inventory !== null && variant !== null) {
        await tx.variant.update({ where: { id: variant.id }, data: { inventory: { increment: item.quantity } } });
        const result = await this.inventory.recordAdjustment(tx, {
          businessId: variant.businessId, productId: variant.productId, variantId: variant.id,
          previousInventory: variant.inventory, newInventory: variant.inventory + item.quantity,
          reason: "ORDER_RELEASED", threshold: variant.lowStockThreshold,
        });
        if (result.restocked) restockedProductIds.push(variant.productId);
      }
    }
    return restockedProductIds;
  }
}

