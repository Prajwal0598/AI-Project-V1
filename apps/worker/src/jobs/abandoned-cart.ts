import type { Job } from "bullmq";
import { ActivityEventType, CartStatus, MessageDirection } from "@prisma/client";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { AbandonedCartJobData } from "../queues";

// nudges a customer who added items to their cart via the WhatsApp shopping flow and then went quiet —
// rescheduled (debounced) on every cart change in CartService, so this only ever fires after real inactivity
export async function processAbandonedCart(job: Job<AbandonedCartJobData>) {
  const { cartId, businessId } = job.data;

  const cart = await prisma.cart.findFirst({
    where: { id: cartId, businessId },
    include: {
      items: { include: { variant: { include: { product: true } } } },
      conversation: { include: { identity: true, business: true } },
    },
  });
  if (!cart) return { skipped: "cart not found" };
  if (cart.status !== CartStatus.ACTIVE) return { skipped: `cart is ${cart.status.toLowerCase()}, no longer abandoned` };
  if (!cart.items.length) return { skipped: "cart is empty" };
  if (!cart.conversation) return { skipped: "conversation not found" };
  if (cart.conversation.escalated) return { skipped: "conversation is escalated to a human" };
  if (cart.conversation.status === "CLOSED") return { skipped: "conversation closed" };
  if (!cart.conversation.identity?.identifier) return { skipped: "no channel identity to message" };

  const lines = cart.items.map((item) => `${item.quantity} × ${item.variant.product.name} — ${item.variant.currency} ${Number(item.variant.price) * item.quantity}`);
  const total = cart.items.reduce((sum, item) => sum + Number(item.variant.price) * item.quantity, 0);
  const currency = cart.items[0]?.variant.currency ?? "INR";
  const content = `You still have items waiting in your cart:\n${lines.join("\n")}\n\nTotal: ${currency} ${total}\n\nReply "cart" to pick up where you left off and complete your order!`;

  // when the merchant has opted into Proactive AI Suggestions, this becomes an approval-first suggestion in
  // their inbox instead of an auto-send — the worker can't reach the API's OpportunityService (separate
  // process/DI container), so it creates the Opportunity+Suggestion rows directly via its own Prisma client,
  // matching this codebase's established pattern of duplicating minimal logic across the two processes
  if (cart.conversation.business.proactiveSuggestionsEnabled) {
    const existing = await prisma.opportunity.findFirst({
      where: { businessId, customerId: cart.customerId, type: "ABANDONED_CART", relatedCartId: cart.id, status: { in: ["NEW", "SENT", "SNOOZED"] } },
    });
    if (existing) return { skipped: "opportunity already exists for this cart" };

    const score = Math.min(100, 60 + Math.min(20, Math.round(total / 100)) + 20); // ABANDONED_CART base 60 + value bonus + full confidence bonus (this signal is unambiguous)
    await prisma.opportunity.create({
      data: {
        businessId, customerId: cart.customerId, type: "ABANDONED_CART",
        priority: score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW",
        score, confidence: 1,
        reason: `Cart with ${cart.items.length} item(s) worth ${currency} ${total} left untouched.`,
        estimatedValue: total, relatedCartId: cart.id,
        suggestion: { create: { message: content } },
      },
    });
    return { suggested: cartId };
  }

  const providerMessageId = await sendChannelMessage(cart.conversation.channel, cart.conversation.business, cart.conversation.identity.identifier, content, cart.conversation.title);

  await prisma.$transaction(async (tx) => {
    await tx.message.create({ data: { conversationId: cart.conversationId, direction: MessageDirection.OUTBOUND, content, providerMessageId, sentAt: new Date() } });
    await tx.conversation.update({ where: { id: cart.conversationId }, data: { lastMessageAt: new Date() } });
    await tx.activityEvent.create({ data: { businessId, customerId: cart.customerId, type: ActivityEventType.MESSAGE_SENT, summary: `Abandoned-cart nudge sent — ${currency} ${total} across ${cart.items.length} item(s)` } });
  });

  return { nudged: cartId };
}
