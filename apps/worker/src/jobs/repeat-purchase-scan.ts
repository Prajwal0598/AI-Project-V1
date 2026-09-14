import type { Job } from "bullmq";
import OpenAI from "openai";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { RepeatPurchaseScanJobData } from "../queues";

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const MIN_INTERVAL_DAYS = 3; // floor to avoid nagging on noisy/very-frequent purchase data
const COMPLETED_STATUSES = ["PAID", "FULFILLED"] as const;

// mirrors AutomationRuleService.isWithinBusinessHours in the API — duplicated, worker can't reach that DI service
function isWithinBusinessHours(rule: { businessHoursStart: number | null; businessHoursEnd: number | null }): boolean {
  if (rule.businessHoursStart == null || rule.businessHoursEnd == null) return true;
  const hour = new Date().getHours();
  return rule.businessHoursStart <= rule.businessHoursEnd
    ? hour >= rule.businessHoursStart && hour < rule.businessHoursEnd
    : hour >= rule.businessHoursStart || hour < rule.businessHoursEnd;
}

async function draftMessage(customerName: string, businessName: string, productName: string, price: string): Promise<string> {
  const fallback = `Hi ${customerName}! Just a heads-up — it might be time to reorder ${productName} (${price}). Let us know if you'd like one.`;
  if (!openai) return fallback;
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      instructions: `You write one short, warm WhatsApp message on behalf of "${businessName}"'s AI sales assistant, reminding a customer it may be time to reorder something they bought before. No hard sell, no invented facts. Write only the message body — no signature, sign-off, or placeholder name like "[Your Name]".`,
      input: `Customer: ${customerName}\nPreviously bought: ${productName} (${price})\nBased on their past purchase pattern, it's likely time to reorder.`,
      store: false,
    });
    return response.output_text?.trim() || fallback;
  } catch (err) {
    console.error("[repeat-purchase-scan] OpenAI error, using fallback message", err);
    return fallback;
  }
}

/** Scans every opted-in business for customers who are statistically "due" to reorder a product they've bought before. */
export async function processRepeatPurchaseScan(_job: Job<RepeatPurchaseScanJobData>) {
  const businesses = await prisma.business.findMany({ where: { proactiveSuggestionsEnabled: true } });
  let created = 0;

  for (const business of businesses) {
    const rule = await prisma.automationRule.upsert({
      where: { businessId_opportunityType: { businessId: business.id, opportunityType: "REPEAT_PURCHASE" } },
      create: { businessId: business.id, opportunityType: "REPEAT_PURCHASE" },
      update: {},
    });
    if (!rule.enabled) continue;

    const items = await prisma.orderItem.findMany({
      where: { productId: { not: null }, order: { businessId: business.id, status: { in: [...COMPLETED_STATUSES] } } },
      select: { productId: true, name: true, unitPrice: true, order: { select: { customerId: true, createdAt: true } } },
      orderBy: { order: { createdAt: "asc" } },
    });

    const groups = new Map<string, { productId: string; name: string; unitPrice: number; customerId: string; dates: Date[] }>();
    for (const item of items) {
      if (!item.productId) continue;
      const key = `${item.order.customerId}:${item.productId}`;
      const existing = groups.get(key);
      if (existing) existing.dates.push(item.order.createdAt);
      else groups.set(key, { productId: item.productId, name: item.name, unitPrice: Number(item.unitPrice), customerId: item.order.customerId, dates: [item.order.createdAt] });
    }

    for (const group of groups.values()) {
      const sorted = [...group.dates].sort((a, b) => a.getTime() - b.getTime());
      const lastPurchase = sorted[sorted.length - 1];
      let intervalDays: number;
      let confidence: number;
      if (sorted.length >= 2) {
        const gaps = sorted.slice(1).map((d, i) => (d.getTime() - sorted[i].getTime()) / 86_400_000);
        intervalDays = Math.max(MIN_INTERVAL_DAYS, gaps.reduce((a, b) => a + b, 0) / gaps.length);
        confidence = 0.75;
      } else {
        intervalDays = Math.max(MIN_INTERVAL_DAYS, business.defaultRepeatPurchaseDays);
        confidence = 0.5;
      }
      const dueDate = new Date(lastPurchase.getTime() + intervalDays * 86_400_000);
      if (dueDate > new Date()) continue; // not due yet

      const customer = await prisma.customer.findUnique({ where: { id: group.customerId }, select: { firstName: true, lastName: true, proactiveMessagingOptOut: true } });
      if (customer?.proactiveMessagingOptOut) continue;

      if (rule.frequencyCapPerCustomerPerDay != null) {
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const createdToday = await prisma.opportunity.count({ where: { businessId: business.id, customerId: group.customerId, createdAt: { gte: startOfToday } } });
        if (createdToday >= rule.frequencyCapPerCustomerPerDay) continue;
      }

      const existingOpportunity = await prisma.opportunity.findFirst({
        where: { businessId: business.id, customerId: group.customerId, type: "REPEAT_PURCHASE", relatedProductId: group.productId, status: { in: ["NEW", "SENT", "SNOOZED"] } },
      });
      if (existingOpportunity) continue;

      const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "there";
      const priceLabel = `INR ${group.unitPrice}`;
      const message = await draftMessage(customerName, business.name, group.name, priceLabel);

      const scoreBase = 50 + Math.min(20, Math.round(group.unitPrice / 100)) + Math.round(confidence * 20);
      const opportunity = await prisma.opportunity.create({
        data: {
          businessId: business.id, customerId: group.customerId, type: "REPEAT_PURCHASE",
          priority: scoreBase >= 75 ? "HIGH" : scoreBase >= 45 ? "MEDIUM" : "LOW",
          score: Math.min(100, scoreBase), confidence,
          reason: `Bought ${group.name} ${sorted.length} time(s) before, last on ${lastPurchase.toISOString().slice(0, 10)} — statistically due to reorder.`,
          estimatedValue: group.unitPrice, relatedProductId: group.productId,
          suggestion: { create: { message } },
        },
      });
      created++;

      if (rule.autoSend && confidence >= rule.minConfidenceForAutoSend && isWithinBusinessHours(rule)) {
        try {
          const conversation = await prisma.conversation.findFirst({ where: { businessId: business.id, customerId: group.customerId }, orderBy: { lastMessageAt: "desc" }, include: { identity: true } });
          if (!conversation?.identity?.identifier) throw new Error("no conversation to send in");
          const providerMessageId = await sendChannelMessage(conversation.channel, business, conversation.identity.identifier, message, conversation.title);
          await prisma.$transaction(async (tx) => {
            await tx.message.create({ data: { conversationId: conversation.id, direction: "OUTBOUND", content: message, providerMessageId, sentAt: new Date() } });
            await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
            await tx.opportunity.update({ where: { id: opportunity.id }, data: { status: "SENT" } });
            await tx.opportunityOutcome.create({ data: { opportunityId: opportunity.id, sentAt: new Date() } });
          });
        } catch (err) {
          console.error(`[repeat-purchase-scan] auto-send failed for opportunity ${opportunity.id}`, err);
        }
      }
    }
  }

  return { businessesScanned: businesses.length, opportunitiesCreated: created };
}
