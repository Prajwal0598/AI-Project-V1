import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEventType, OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";

// terminal statuses that cannot transition further
const TERMINAL_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);

@Injectable()
export class OrderService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    return this.prisma.order.findMany({
      where: { businessId },
      include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(businessId: string, input: CreateOrderDto) {
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");

    const shippingFee = input.shippingFee ?? 0;
    const total = input.subtotal + shippingFee;

    const order = await this.prisma.order.create({
      data: {
        businessId,
        customerId: input.customerId,
        subtotal: input.subtotal,
        shippingFee,
        total,
        currency: input.currency?.trim() || "INR",
        shippingAddress: (input.shippingAddress ?? undefined) as object | undefined,
        status: OrderStatus.DRAFT,
      },
    });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: input.customerId, type: ActivityEventType.ORDER_PLACED, summary: `Order placed — ${order.currency} ${order.total}` },
    });
    await recalculateLeadScore(this.prisma, input.customerId, businessId);

    return order;
  }

  async updateStatus(orderId: string, businessId: string, input: UpdateOrderStatusDto) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, businessId } });
    if (!order) throw new NotFoundException("Order not found.");
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new BadRequestException(`Order is ${order.status.toLowerCase()} and cannot be updated.`);
    }
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { status: input.status } });

    await this.prisma.activityEvent.create({
      data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order status changed to ${input.status.replace("_", " ").toLowerCase()}` },
    });
    // recalculate lead score since a paid/fulfilled status now contributes to the score
    await recalculateLeadScore(this.prisma, order.customerId, businessId);

    return updated;
  }
}
