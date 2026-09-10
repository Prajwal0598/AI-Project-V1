import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEventType, FulfillmentStatus, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { CreateOrderDto, OrderItemInputDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";

// terminal statuses that cannot transition further
const TERMINAL_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);
// an order can still have its items/address changed by the customer up until it's marked paid
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT]);

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

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
            ? { create: input.items.map((i) => ({ productId: i.productId ?? null, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) }
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
      await this.releaseStock(tx, order.items);
      await this.reserveStock(tx, businessId, items);
      await tx.orderItem.deleteMany({ where: { orderId } });
      const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const total = subtotal + Number(order.shippingFee);
      // if the amended total now exceeds the autonomy threshold, it needs a fresh human approval even if it was already approved/pending payment
      const exceedsAutonomyLimit = business?.autonomyMaxOrderValue != null && total > Number(business.autonomyMaxOrderValue);
      const status = exceedsAutonomyLimit && order.status === OrderStatus.PENDING_PAYMENT ? OrderStatus.AWAITING_APPROVAL : order.status;
      return tx.order.update({
        where: { id: orderId },
        data: {
          subtotal,
          total,
          status,
          shippingAddress: (shippingAddress ?? order.shippingAddress ?? undefined) as object | undefined,
          items: { create: items.map((i) => ({ productId: i.productId ?? null, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) },
        },
        include: { items: true },
      });
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order items updated — new total ${updated.currency} ${updated.total}` },
    });
    await recalculateLeadScore(this.prisma, order.customerId, businessId);

    return updated;
  }

  async updateStatus(orderId: string, businessId: string, input: UpdateOrderStatusDto) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId }, include: { items: true } });
    if (!order) throw new NotFoundException("Order not found.");
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and cannot be updated.`);
    }

    const releasingStock = input.status === OrderStatus.CANCELLED || input.status === OrderStatus.REFUNDED;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (releasingStock) await this.releaseStock(tx, order.items);
      return tx.order.update({ where: { id: orderId }, data: { status: input.status } });
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

    return updated;
  }

  /** Validates stock for items linked to a real product and decrements it — throws if any item is out of stock. */
  private async reserveStock(tx: Prisma.TransactionClient, businessId: string, items: OrderItemInputDto[]) {
    for (const item of items) {
      if (!item.productId) continue; // free-text items with no catalogue link have no stock to track
      const product = await tx.product.findFirst({ where: { id: item.productId, businessId } });
      if (!product) throw new BadRequestException(`Product not found: ${item.name}`);
      if (product.inventory === null) continue; // untracked stock

      // conditional update: only decrements if stock is still sufficient at the moment the row is written,
      // so two concurrent orders for the last unit can't both pass a stale read and oversell
      const result = await tx.product.updateMany({
        where: { id: product.id, inventory: { gte: item.quantity } },
        data: { inventory: { decrement: item.quantity } },
      });
      if (result.count === 0) {
        throw new BadRequestException(`Not enough stock for "${product.name}" — only ${product.inventory} left.`);
      }
    }
  }

  /** Restores stock for an order's items — used on cancellation/refund and before replacing an order's items. */
  private async releaseStock(tx: Prisma.TransactionClient, items: { productId: string | null; quantity: number }[]) {
    for (const item of items) {
      if (!item.productId) continue;
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (product?.inventory !== null && product !== null) {
        await tx.product.update({ where: { id: product.id }, data: { inventory: { increment: item.quantity } } });
      }
    }
  }
}

