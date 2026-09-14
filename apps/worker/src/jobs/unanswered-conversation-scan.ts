import type { Job } from "bullmq";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { UnansweredConversationScanJobData } from "../queues";

// how long an escalated conversation can sit with the customer's message unanswered before we nudge them
const STALE_HOURS = Number(process.env.UNANSWERED_CONVERSATION_STALE_HOURS ?? 2);

function isWithinBusinessHours(rule: { businessHoursStart: number | null; businessHoursEnd: number | null }): boolean {
  if (rule.businessHoursStart == null || rule.businessHoursEnd == null) return true;
  const hour = new Date().getHours();
  return rule.businessHoursStart <= rule.businessHoursEnd
    ? hour >= rule.businessHoursStart && hour < rule.businessHoursEnd
    : hour >= rule.businessHoursStart || hour < rule.businessHoursEnd;
}

const FALLBACK = (customerName: string) => `Hi ${customerName}, sorry for the delay in getting back to you! Someone from our team will follow up shortly.`;

/** Scans escalated conversations whose customer hasn't had any reply (human or AI) in a while — a holding message so they're not left hanging. */
export async function processUnansweredConversationScan(_job: Job<UnansweredConversationScanJobData>) {
  const businesses = await prisma.business.findMany({ where: { proactiveSuggestionsEnabled: true } });
  let created = 0;
  const staleBefore = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);

  for (const business of businesses) {
    const rule = await prisma.automationRule.upsert({
      where: { businessId_opportunityType: { businessId: business.id, opportunityType: "UNANSWERED_CONVERSATION" } },
      create: { businessId: business.id, opportunityType: "UNANSWERED_CONVERSATION" },
      update: {},
    });
    if (!rule.enabled) continue;

    const conversations = await prisma.conversation.findMany({
      where: { businessId: business.id, escalated: true, status: "OPEN", lastMessageAt: { lte: staleBefore } },
      include: { messages: { orderBy: { sentAt: "desc" }, take: 1 }, identity: true, customer: { select: { id: true, firstName: true, lastName: true, proactiveMessagingOptOut: true } } },
    });

    for (const conversation of conversations) {
      const lastMessage = conversation.messages[0];
      if (!lastMessage || lastMessage.direction !== "INBOUND") continue; // already replied since escalation
      if (conversation.customer.proactiveMessagingOptOut) continue;

      if (rule.frequencyCapPerCustomerPerDay != null) {
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const createdToday = await prisma.opportunity.count({ where: { businessId: business.id, customerId: conversation.customerId, createdAt: { gte: startOfToday } } });
        if (createdToday >= rule.frequencyCapPerCustomerPerDay) continue;
      }

      const existing = await prisma.opportunity.findFirst({
        where: { businessId: business.id, customerId: conversation.customerId, type: "UNANSWERED_CONVERSATION", status: { in: ["NEW", "SENT", "SNOOZED"] } },
      });
      if (existing) continue;

      const customerName = [conversation.customer.firstName, conversation.customer.lastName].filter(Boolean).join(" ") || "there";
      const message = FALLBACK(customerName);
      const confidence = 0.7;
      const scoreBase = 70 + Math.round(confidence * 20);

      const opportunity = await prisma.opportunity.create({
        data: {
          businessId: business.id, customerId: conversation.customerId, type: "UNANSWERED_CONVERSATION",
          priority: scoreBase >= 75 ? "HIGH" : scoreBase >= 45 ? "MEDIUM" : "LOW",
          score: Math.min(100, scoreBase), confidence,
          reason: `Escalated conversation has been waiting on a reply for over ${STALE_HOURS}h.`,
          suggestion: { create: { message } },
        },
      });
      created++;

      if (rule.autoSend && confidence >= rule.minConfidenceForAutoSend && isWithinBusinessHours(rule) && conversation.identity?.identifier) {
        try {
          const providerMessageId = await sendChannelMessage(conversation.channel, business, conversation.identity.identifier, message, conversation.title);
          await prisma.$transaction(async (tx) => {
            await tx.message.create({ data: { conversationId: conversation.id, direction: "OUTBOUND", content: message, providerMessageId, sentAt: new Date() } });
            await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
            await tx.opportunity.update({ where: { id: opportunity.id }, data: { status: "SENT" } });
            await tx.opportunityOutcome.create({ data: { opportunityId: opportunity.id, sentAt: new Date() } });
          });
        } catch (err) {
          console.error(`[unanswered-conversation-scan] auto-send failed for opportunity ${opportunity.id}`, err);
        }
      }
    }
  }

  return { businessesScanned: businesses.length, opportunitiesCreated: created };
}
