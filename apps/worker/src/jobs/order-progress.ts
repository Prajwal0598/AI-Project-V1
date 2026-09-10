import type { Job, Queue } from "bullmq";
import { ActivityEventType, FulfillmentStatus, MessageDirection, OrderStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { OrderProgressQueueJob, FulfillmentProgressJobData } from "../queues";

const TERMINAL = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED]);
// relative ordering used to avoid regressing or repeating a status transition
const STATUS_RANK: Record<OrderStatus, number> = {
  DRAFT: 0,
  AWAITING_APPROVAL: 0,
  PENDING_PAYMENT: 1,
  PAID: 2,
  FULFILLED: 3,
  CANCELLED: 99,
  REFUNDED: 99,
};

// the shipment tracking pipeline, in order — each stage schedules the next one after a slice of the total delay
const FULFILLMENT_STAGES: FulfillmentProgressJobData["nextStage"][] = [FulfillmentStatus.PACKED, FulfillmentStatus.SHIPPED, FulfillmentStatus.OUT_FOR_DELIVERY, FulfillmentStatus.DELIVERED];
const FULFILLMENT_RANK: Record<FulfillmentStatus, number> = {
  NOT_STARTED: 0, PACKED: 1, SHIPPED: 2, OUT_FOR_DELIVERY: 3, DELIVERED: 4, FAILED: 5, RETURNED: 5,
};
const FULFILLMENT_MESSAGES: Record<FulfillmentStatus, string> = {
  NOT_STARTED: "",
  PACKED: "📦 Your order has been packed and is ready for pickup by our courier.",
  SHIPPED: "🚚 Your order has shipped!",
  OUT_FOR_DELIVERY: "🛵 Your order is out for delivery today.",
  DELIVERED: "✅ Your order has been delivered. Thanks for shopping with us!",
  FAILED: "We were unable to deliver your order.",
  RETURNED: "Your order has been returned to us.",
};

// simulated autonomous payment/shipment tracking — no real payment gateway or courier is connected yet.
// factory takes the order-progress queue so PAID can chain into scheduling the fulfillment stage progression.
export function makeOrderProgressProcessor(orderProgressQueue: Queue<OrderProgressQueueJob>) {
  return async function processOrderProgress(job: Job<OrderProgressQueueJob>) {
    if ("nextStage" in job.data) return processFulfillmentStage(job.data, orderProgressQueue);
    return processPayment(job.data, orderProgressQueue);
  };
}

async function processPayment(data: { orderId: string; businessId: string; nextStatus: "PAID" }, orderProgressQueue: Queue<OrderProgressQueueJob>) {
  const { orderId, businessId, nextStatus } = data;
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
      summary: `Order automatically marked ${nextStatus.toLowerCase()} (simulated payment tracking)`,
    },
  });

  // for UPI orders, the customer was told their order is only confirmed once payment clears — now that the
  // simulated payment has cleared, tell them so (COD orders were already told "placed" at confirmation time)
  if (order.paymentMethod === "UPI" && order.conversationId) {
    await notifyPaymentReceived(order.conversationId, businessId);
  }

  // label the conversation as a completed sale for CRM/revenue reporting
  if (order.conversationId) {
    await prisma.conversation.update({ where: { id: order.conversationId }, data: { outcome: "SALE" } });
  }

  // kick off the shipment tracking pipeline — first stage after a quarter of the total configured delay
  const totalDelay = parseInt(process.env.ORDER_AUTO_FULFILLED_DELAY_MS ?? "86400000", 10); // default 24h to fully delivered
  await orderProgressQueue.add("advance", { orderId, businessId, nextStage: FULFILLMENT_STAGES[0] }, {
    delay: Math.round(totalDelay / FULFILLMENT_STAGES.length),
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  });

  return { advanced: nextStatus };
}

async function processFulfillmentStage(data: FulfillmentProgressJobData, orderProgressQueue: Queue<OrderProgressQueueJob>) {
  const { orderId, businessId, nextStage } = data;
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) return { skipped: "order not found" };
  if (TERMINAL.has(order.status)) return { skipped: `order is ${order.status.toLowerCase()}` };
  if (FULFILLMENT_RANK[order.fulfillmentStatus] >= FULFILLMENT_RANK[nextStage]) return { skipped: "already progressed past this fulfillment stage" };

  await prisma.order.update({
    where: { id: orderId },
    data: { fulfillmentStatus: nextStage, ...(nextStage === FulfillmentStatus.DELIVERED ? { status: OrderStatus.FULFILLED } : {}) },
  });
  await prisma.activityEvent.create({
    data: { businessId, customerId: order.customerId, type: ActivityEventType.ORDER_UPDATED, summary: `Order automatically marked ${nextStage.toLowerCase().replace(/_/g, " ")} (simulated shipment tracking)` },
  });

  if (order.conversationId) await notifyFulfillmentStage(order.conversationId, businessId, nextStage);

  const nextIndex = FULFILLMENT_STAGES.indexOf(nextStage) + 1;
  if (nextIndex < FULFILLMENT_STAGES.length) {
    const totalDelay = parseInt(process.env.ORDER_AUTO_FULFILLED_DELAY_MS ?? "86400000", 10);
    await orderProgressQueue.add("advance", { orderId, businessId, nextStage: FULFILLMENT_STAGES[nextIndex] }, {
      delay: Math.round(totalDelay / FULFILLMENT_STAGES.length),
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
  }

  return { advanced: nextStage };
}

async function notifyFulfillmentStage(conversationId: string, businessId: string, stage: FulfillmentStatus): Promise<void> {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { identity: true, business: true },
    });
    if (!conversation?.identity?.identifier) return;

    const content = FULFILLMENT_MESSAGES[stage];
    const providerMessageId = await sendChannelMessage(conversation.channel, conversation.business, conversation.identity.identifier, content, conversation.title);
    await prisma.$transaction(async (tx) => {
      await tx.message.create({ data: { conversationId, direction: MessageDirection.OUTBOUND, content, providerMessageId, sentAt: new Date() } });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    });
  } catch (err) {
    console.error(`[order-progress] failed to notify conversation ${conversationId} of fulfillment stage ${stage}`, err);
  }
}

async function notifyPaymentReceived(conversationId: string, businessId: string): Promise<void> {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { identity: true, business: true },
    });
    if (!conversation?.identity?.identifier) return;

    const content = "🎉 Payment received! Your order has been confirmed and will be shipped soon.";
    const providerMessageId = await sendChannelMessage(
      conversation.channel,
      conversation.business,
      conversation.identity.identifier,
      content,
      conversation.title
    );

    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: { conversationId, direction: MessageDirection.OUTBOUND, content, providerMessageId, sentAt: new Date() },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    });
  } catch (err) {
    console.error(`[order-progress] failed to notify conversation ${conversationId} of payment`, err);
  }
}
