import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEventType, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { CreateOrderDto, OrderItemInputDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";

// terminal statuses that cannot transition further
const TERMINAL_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);
// an order can still have its items/address changed by the customer up until it's marked paid
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT]);

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

    const shippingFee = input.shippingFee ?? 0;
    // orders created with a payment method already chosen (e.g. via the AI conversational flow) go
    // straight to PENDING_PAYMENT and start the simulated autonomous payment/shipment progression
    const initialStatus = input.paymentMethod ? OrderStatus.PENDING_PAYMENT : OrderStatus.DRAFT;

    const order = await this.prisma.$transaction(async (tx) => {
      await this.reserveStock(tx, businessId, input.items ?? []);
      const subtotal = input.items?.length ? input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) : input.subtotal;
      const total = subtotal + shippingFee;

      return tx.order.create({
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
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: input.customerId, type: ActivityEventType.ORDER_PLACED, summary: `Order placed — ${order.currency} ${order.total}` },
    });
    await recalculateLeadScore(this.prisma, input.customerId, businessId);

    if (input.paymentMethod) await this.queues.scheduleOrderProgress(order.id, businessId);

    return order;
  }

  /** Replaces an amendable order's items entirely (releasing old stock, reserving new stock) and recomputes totals. */
  async replaceItems(orderId: string, businessId: string, items: OrderItemInputDto[], shippingAddress?: Record<string, unknown>) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId }, include: { items: true } });
    if (!order) throw new NotFoundException("Order not found.");
    if (!AMENDABLE_STATUSES.has(order.status)) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and can no longer be changed.`);
    }
    if (!items.length) throw new BadRequestException("At least one item is required.");

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.releaseStock(tx, order.items);
      await this.reserveStock(tx, businessId, items);
      await tx.orderItem.deleteMany({ where: { orderId } });
      const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const total = subtotal + Number(order.shippingFee);
      return tx.order.update({
        where: { id: orderId },
        data: {
          subtotal,
          total,
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

