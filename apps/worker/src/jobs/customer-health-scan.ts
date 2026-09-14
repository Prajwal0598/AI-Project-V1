import type { Job } from "bullmq";
import OpenAI from "openai";
import { prisma } from "../prisma";
import { sendChannelMessage } from "../channel-send";
import type { CustomerHealthScanJobData } from "../queues";

const HIGH_VALUE_QUIET_DAYS = 14; // a high-value customer quiet for this long is worth a proactive check-in

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function isWithinBusinessHours(rule: { businessHoursStart: number | null; businessHoursEnd: number | null }): boolean {
  if (rule.businessHoursStart == null || rule.businessHoursEnd == null) return true;
  const hour = new Date().getHours();
  return rule.businessHoursStart <= rule.businessHoursEnd
    ? hour >= rule.businessHoursStart && hour < rule.businessHoursEnd
    : hour >= rule.businessHoursStart || hour < rule.businessHoursEnd;
}

async function draftMessage(type: "LOW_ENGAGEMENT" | "HIGH_VALUE_CUSTOMER", customerName: string, businessName: string): Promise<string> {
  const fallback = type === "LOW_ENGAGEMENT"
    ? `Hi ${customerName}! We haven't seen you in a while and wanted to check in — let us know if there's anything we can help with.`
    : `Hi ${customerName}! Just wanted to say thanks for being one of our best customers — let us know if there's ever anything we can help with.`;
  if (!openai) return fallback;
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      instructions: `You write one short, warm WhatsApp message on behalf of "${businessName}"'s AI sales assistant. No hard sell, no invented facts, no pressure. Write only the message body — no signature, sign-off, or placeholder name like "[Your Name]".`,
      input: type === "LOW_ENGAGEMENT"
        ? `Customer: ${customerName}\nThey were previously active but haven't been in touch in a long while. Write a warm "we miss you" win-back message.`
        : `Customer: ${customerName}\nThey are one of this business's most valuable customers but haven't heard from the business in a while. Write a short, genuine check-in/thank-you message — no sales pitch.`,
      store: false,
    });
    return response.output_text?.trim() || fallback;
  } catch (err) {
    console.error("[customer-health-scan] OpenAI error, using fallback message", err);
    return fallback;
  }
}

type HealthRule = Awaited<ReturnType<typeof prisma.automationRule.upsert>>;
type HealthBusiness = Awaited<ReturnType<typeof prisma.business.findMany>>[number];

/** Shared create path for both health-scan opportunity types: frequency cap, dedup, scoring, creation, and best-effort auto-send. Returns 1 if an opportunity was created, 0 if skipped. */
async function maybeCreate(business: HealthBusiness, rule: HealthRule, customerId: string, customerName: string, type: "LOW_ENGAGEMENT" | "HIGH_VALUE_CUSTOMER", leadScore: number, reason: string): Promise<number> {
  if (rule.frequencyCapPerCustomerPerDay != null) {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const createdToday = await prisma.opportunity.count({ where: { businessId: business.id, customerId, createdAt: { gte: startOfToday } } });
    if (createdToday >= rule.frequencyCapPerCustomerPerDay) return 0;
  }
  const existing = await prisma.opportunity.findFirst({ where: { businessId: business.id, customerId, type, status: { in: ["NEW", "SENT", "SNOOZED"] } } });
  if (existing) return 0;

  const confidence = type === "LOW_ENGAGEMENT" ? 0.5 : 0.6;
  const base = type === "LOW_ENGAGEMENT" ? 35 : 45;
  const scoreBase = base + Math.round(confidence * 20) + Math.round((leadScore / 100) * 10);
  const message = await draftMessage(type, customerName, business.name);

  const opportunity = await prisma.opportunity.create({
    data: {
      businessId: business.id, customerId, type,
      priority: scoreBase >= 75 ? "HIGH" : scoreBase >= 45 ? "MEDIUM" : "LOW",
      score: Math.min(100, scoreBase), confidence, reason,
      suggestion: { create: { message } },
    },
  });

  if (rule.autoSend && confidence >= rule.minConfidenceForAutoSend && isWithinBusinessHours(rule)) {
    try {
      const conversation = await prisma.conversation.findFirst({ where: { businessId: business.id, customerId }, orderBy: { lastMessageAt: "desc" }, include: { identity: true } });
      if (!conversation?.identity?.identifier) throw new Error("no conversation to send in");
      const providerMessageId = await sendChannelMessage(conversation.channel, business, conversation.identity.identifier, message, conversation.title);
      await prisma.$transaction(async (tx) => {
        await tx.message.create({ data: { conversationId: conversation.id, direction: "OUTBOUND", content: message, providerMessageId, sentAt: new Date() } });
        await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        await tx.opportunity.update({ where: { id: opportunity.id }, data: { status: "SENT" } });
        await tx.opportunityOutcome.create({ data: { opportunityId: opportunity.id, sentAt: new Date() } });
      });
    } catch (err) {
      console.error(`[customer-health-scan] auto-send failed for opportunity ${opportunity.id}`, err);
    }
  }
  return 1;
}

/** Scans every opted-in business's customers for two "customer health" signals: previously-active customers who've gone quiet
 * (LOW_ENGAGEMENT win-back) and high-value customers who haven't heard from the business proactively in a while (HIGH_VALUE_CUSTOMER). */
export async function processCustomerHealthScan(_job: Job<CustomerHealthScanJobData>) {
  const businesses = await prisma.business.findMany({ where: { proactiveSuggestionsEnabled: true } });
  let created = 0;
  const now = Date.now();

  for (const business of businesses) {
    const [lowEngagementRule, highValueRule] = await Promise.all([
      prisma.automationRule.upsert({
        where: { businessId_opportunityType: { businessId: business.id, opportunityType: "LOW_ENGAGEMENT" } },
        create: { businessId: business.id, opportunityType: "LOW_ENGAGEMENT" }, update: {},
      }),
      prisma.automationRule.upsert({
        where: { businessId_opportunityType: { businessId: business.id, opportunityType: "HIGH_VALUE_CUSTOMER" } },
        create: { businessId: business.id, opportunityType: "HIGH_VALUE_CUSTOMER" }, update: {},
      }),
    ]);
    if (!lowEngagementRule.enabled && !highValueRule.enabled) continue;

    const customers = await prisma.customer.findMany({
      where: { businessId: business.id, proactiveMessagingOptOut: false },
      select: {
        id: true, firstName: true, lastName: true,
        leadScore: { select: { score: true } },
        conversations: { select: { lastMessageAt: true }, orderBy: { lastMessageAt: "desc" }, take: 1 },
        orders: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { conversations: true, orders: true } },
      },
    });

    for (const customer of customers) {
      const lastConversationAt = customer.conversations[0]?.lastMessageAt ?? null;
      const lastOrderAt = customer.orders[0]?.createdAt ?? null;
      const lastActivity = [lastConversationAt, lastOrderAt].filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const daysQuiet = lastActivity ? (now - lastActivity.getTime()) / 86_400_000 : null;
      const wasPreviouslyActive = customer._count.orders > 0 || customer._count.conversations >= 2;
      const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "there";
      const leadScore = customer.leadScore?.score ?? 0;

      if (lowEngagementRule.enabled && wasPreviouslyActive && daysQuiet != null && daysQuiet >= business.defaultLowEngagementDays) {
        created += await maybeCreate(business, lowEngagementRule, customer.id, customerName, "LOW_ENGAGEMENT", leadScore,
          `Previously active customer, quiet for ${Math.round(daysQuiet)} days (win-back threshold: ${business.defaultLowEngagementDays}).`);
      }
      if (highValueRule.enabled && leadScore >= business.highValueLeadScoreThreshold && (daysQuiet == null || daysQuiet >= HIGH_VALUE_QUIET_DAYS)) {
        created += await maybeCreate(business, highValueRule, customer.id, customerName, "HIGH_VALUE_CUSTOMER", leadScore,
          `High-value customer (lead score ${leadScore}) with no proactive outreach in ${HIGH_VALUE_QUIET_DAYS}+ days.`);
      }
    }
  }

  return { businessesScanned: businesses.length, opportunitiesCreated: created };
}
