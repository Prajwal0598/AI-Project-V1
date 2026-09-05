import type { Job, Queue } from "bullmq";
import { ActivityEventType, OrderStatus } from "@prisma/client";
import { prisma } from "../prisma";
import type { OrderProgressJobData } from "../queues";

const TERMINAL = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);
// relative ordering used to avoid regressing or repeating a status transition
const STATUS_RANK: Record<OrderStatus, number> = {
  DRAFT: 0,
  PENDING_PAYMENT: 1,
  PAID: 2,
  FULFILLED: 3,
  CANCELLED: 99,
  REFUNDED: 99,
};

// simulated autonomous payment/shipment tracking — no real payment gateway or courier is connected yet.
// factory takes the order-progress queue so PAID can chain into scheduling the next FULFILLED step.
export function makeOrderProgressProcessor(orderProgressQueue: Queue<OrderProgressJobData>) {
  return async function processOrderProgress(job: Job<OrderProgressJobData>) {
    const { orderId, businessId, nextStatus } = job.data;
    const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
    if (!order) return { skipped: "order not found" };
    if (TERMINAL.has(order.status)) return { skipped: `order is ${order.status.toLowerCase()}` };
    if (STATUS_RANK[order.status] >= STATUS_RANK[nextStatus]) return { skipped: "already progressed past this status" };

    await prisma.order.update({ where: { id: orderId }, data: { status: nextStatus } });
    await prisma.activityEvent.create({
      data: {
        businessId,
        customerId: order.customerId,
        type: ActivityEventType.ORDER_UPDATED,
        summary: `Order automatically marked ${nextStatus.toLowerCase()} (simulated payment/shipment tracking)`,
      },
    });

    if (nextStatus === "PAID") {
      const delay = parseInt(process.env.ORDER_AUTO_FULFILLED_DELAY_MS ?? "86400000", 10); // default 24h
      await orderProgressQueue.add("advance", { orderId, businessId, nextStatus: "FULFILLED" }, {
        delay,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
      });
    }

    return { advanced: nextStatus };
  };
}
