import type { Job } from "bullmq";
import { ActivityEventType, MessageDirection, OrderStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { OrderExpiryJobData } from "../queues";

// releases stock reserved on an order that was never paid/approved in time — the real-world equivalent of
// "Handle payment expiry/failure: reserved inventory is released safely after timeout"
export async function processOrderExpiry(job: Job<OrderExpiryJobData>) {
  const { orderId, businessId, expectedStatus } = job.data;
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId }, include: { items: true } });
  if (!order) return { skipped: "order not found" };
  if (order.status !== expectedStatus) return { skipped: `order is now ${order.status.toLowerCase()}, no longer ${expectedStatus.toLowerCase()}` };

  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      if (!item.productId) continue;
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (product?.inventory !== null && product !== null) {
        await tx.product.update({ where: { id: product.id }, data: { inventory: { increment: item.quantity } } });
      }
    }
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });
  });

  await prisma.activityEvent.create({
    data: {
      businessId,
      customerId: order.customerId,
      type: ActivityEventType.ORDER_UPDATED,
      summary: `Order automatically cancelled — ${expectedStatus === "AWAITING_APPROVAL" ? "not approved" : "payment not received"} in time`,
    },
  });

  if (order.conversationId) await notifyExpired(order.conversationId, businessId, expectedStatus);

  return { expired: orderId };
}

async function notifyExpired(conversationId: string, businessId: string, expectedStatus: OrderExpiryJobData["expectedStatus"]): Promise<void> {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { identity: true, business: true },
    });
    if (!conversation?.identity?.identifier) return;

    const content = expectedStatus === "AWAITING_APPROVAL"
      ? "Sorry for the delay — we weren't able to approve your order in time, so it's been cancelled. Reach out again if you'd still like to order."
      : "Your order was cancelled because payment wasn't completed in time. Let us know if you'd like to place it again.";
    const providerMessageId = await sendChannelMessage(conversation.channel, conversation.business, conversation.identity.identifier, content, conversation.title);

    await prisma.$transaction(async (tx) => {
      await tx.message.create({ data: { conversationId, direction: MessageDirection.OUTBOUND, content, providerMessageId, sentAt: new Date() } });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), activeOrderId: null } });
    });
  } catch (err) {
    console.error(`[order-expiry] failed to notify conversation ${conversationId} of cancellation`, err);
  }
}
