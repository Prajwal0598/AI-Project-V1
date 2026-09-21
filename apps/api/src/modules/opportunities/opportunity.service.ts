import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { toPublicImageUrl } from "../products/image-storage";
import { OpportunityPriority, OpportunityStatus, OpportunityType, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { SuggestionAiService } from "./suggestion-ai.service";
import { AutomationRuleService } from "./automation-rule.service";
import { logAiAction } from "../../common/ai-action-log.helper";

// how far back to look for a SENT suggestion when attributing a new order to it — a simple, explainable
// heuristic (not causal modelling); refining attribution is explicitly a later "Learning" phase, not P0
const ATTRIBUTION_WINDOW_DAYS = 7;
// don't create a second live opportunity of the same kind for the same target while one is still unresolved
const DEDUP_STATUSES: OpportunityStatus[] = [OpportunityStatus.NEW, OpportunityStatus.SENT, OpportunityStatus.SNOOZED];
// need at least this many historical inbound messages before trusting an inferred "best hour to reach them"
const MIN_SAMPLE_FOR_TIMING = 5;
// how many of the customer's most recent inbound messages to sample when inferring their best hour
const TIMING_SAMPLE_SIZE = 200;

interface CreateOpportunityInput {
  businessId: string;
  customerId: string;
  type: OpportunityType;
  reason: string;
  estimatedValue?: number;
  confidence: number; // 0-1
  relatedProductId?: string;
  relatedCartId?: string;
  relatedPromotionId?: string;
  message: string;
}

const INCLUDE = {
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
  relatedProduct: { select: { id: true, name: true, imageUrl: true } },
  suggestion: true,
  outcome: true,
};

@Injectable()
export class OpportunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly suggestionAi: SuggestionAiService,
    private readonly automationRules: AutomationRuleService,
  ) {}

  /** Deterministic 0-100 score from concrete signals — never AI-derived, so every ranking is auditable.
   * leadScore (0-100, from the existing LeadScore model) adds up to +10 — a proven-valuable customer's
   * opportunities float to the top of the inbox ahead of an equivalent one for an unknown/low-value lead. */
  private score(type: OpportunityType, estimatedValue: number | undefined, confidence: number, leadScore: number | undefined): { score: number; priority: OpportunityPriority } {
    const base: Record<OpportunityType, number> = {
      ABANDONED_CART: 60, BACK_IN_STOCK: 55, PRODUCT_ENQUIRY: 45,
      HIGH_PURCHASE_INTENT: 65, REPEAT_PURCHASE: 50, CROSS_SELL: 40, UPSELL: 40,
      NEW_PRODUCT_MATCH: 50, PROMOTION: 55, UNANSWERED_CONVERSATION: 70, LOW_ENGAGEMENT: 35, HIGH_VALUE_CUSTOMER: 45,
    };
    const valueBonus = Math.min(20, Math.round((estimatedValue ?? 0) / 100));
    const confidenceBonus = Math.round(confidence * 20);
    const customerValueBonus = Math.round(((leadScore ?? 0) / 100) * 10);
    const score = Math.min(100, base[type] + valueBonus + confidenceBonus + customerValueBonus);
    const priority: OpportunityPriority = score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW";
    return { score, priority };
  }

  /** Creates an Opportunity + AI-drafted Suggestion, unless a live (non-terminal) one already exists for the same target.
   * Respects the customer's opt-out, the type's AutomationRule (enabled + frequency cap), and immediately auto-sends
   * when the rule allows it and the current time is within its business-hours window. */
  async create(input: CreateOpportunityInput) {
    const business = await this.prisma.business.findUnique({ where: { id: input.businessId }, select: { proactiveSuggestionsEnabled: true } });
    if (!business?.proactiveSuggestionsEnabled) return null;

    const customer = await this.prisma.customer.findUnique({ where: { id: input.customerId }, select: { proactiveMessagingOptOut: true, leadScore: { select: { score: true } } } });
    if (customer?.proactiveMessagingOptOut) {
      await logAiAction(this.prisma, { businessId: input.businessId, customerId: input.customerId, action: "OPPORTUNITY_SKIPPED", result: "skipped", reason: "customer opted out of proactive messaging" });
      return null;
    }

    const rule = await this.automationRules.getFor(input.businessId, input.type);
    if (!rule.enabled) {
      await logAiAction(this.prisma, { businessId: input.businessId, customerId: input.customerId, action: "OPPORTUNITY_SKIPPED", result: "skipped", reason: `${input.type} opportunities are disabled for this business` });
      return null;
    }
    if (rule.frequencyCapPerCustomerPerDay != null) {
      const createdToday = await this.automationRules.countCreatedTodayForCustomer(input.businessId, input.customerId);
      if (createdToday >= rule.frequencyCapPerCustomerPerDay) {
        await logAiAction(this.prisma, { businessId: input.businessId, customerId: input.customerId, action: "OPPORTUNITY_SKIPPED", result: "skipped", reason: `daily frequency cap (${rule.frequencyCapPerCustomerPerDay}) reached for this customer` });
        return null;
      }
    }

    const existing = await this.prisma.opportunity.findFirst({
      where: {
        businessId: input.businessId,
        customerId: input.customerId,
        type: input.type,
        status: { in: DEDUP_STATUSES },
        ...(input.relatedProductId ? { relatedProductId: input.relatedProductId } : {}),
        ...(input.relatedCartId ? { relatedCartId: input.relatedCartId } : {}),
        ...(input.relatedPromotionId ? { relatedPromotionId: input.relatedPromotionId } : {}),
      },
    });
    if (existing) return existing;

    const { score, priority } = this.score(input.type, input.estimatedValue, input.confidence, customer?.leadScore?.score);
    const created = await this.prisma.opportunity.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        type: input.type,
        priority,
        score,
        confidence: input.confidence,
        reason: input.reason,
        estimatedValue: input.estimatedValue,
        relatedProductId: input.relatedProductId,
        relatedCartId: input.relatedCartId,
        relatedPromotionId: input.relatedPromotionId,
        suggestion: { create: { message: input.message } },
      },
      include: INCLUDE,
    });

    if (rule.autoSend && input.confidence >= rule.minConfidenceForAutoSend && (await this.isWithinSendWindow(rule, input.businessId, input.customerId))) {
      try {
        await this.send(created.id, input.businessId);
        await logAiAction(this.prisma, { businessId: input.businessId, customerId: input.customerId, action: "OPPORTUNITY_AUTO_SENT", result: "sent", reason: `${input.type} auto-send rule enabled` });
        return this.prisma.opportunity.findUnique({ where: { id: created.id }, include: INCLUDE });
      } catch (err) {
        // auto-send failing (e.g. no channel configured) shouldn't stop the opportunity from existing for manual review
        await logAiAction(this.prisma, { businessId: input.businessId, customerId: input.customerId, action: "OPPORTUNITY_AUTO_SEND_FAILED", result: "failed", reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return created;
  }

  /** True if now is a good moment to auto-send: the customer's own inferred best-reply hour when the rule opts in and enough history exists, otherwise the business-hours window. */
  private async isWithinSendWindow(rule: { personalizedTiming: boolean; businessHoursStart: number | null; businessHoursEnd: number | null }, businessId: string, customerId: string): Promise<boolean> {
    if (rule.personalizedTiming) {
      const inferred = await this.inferBestSendHour(businessId, customerId);
      if (inferred) {
        const hour = new Date().getHours();
        const diff = Math.min(Math.abs(hour - inferred.hour), 24 - Math.abs(hour - inferred.hour));
        return diff <= 1; // within an hour either side of their usual reply time
      }
    }
    return this.automationRules.isWithinBusinessHours(rule);
  }

  /** Infers the hour-of-day (0-23, local server time) this customer most often replies at, from their recent inbound message history.
   * Returns null when there isn't enough history yet to trust a pattern (falls back to plain business hours in that case). */
  async inferBestSendHour(businessId: string, customerId: string): Promise<{ hour: number; sampleSize: number } | null> {
    const messages = await this.prisma.message.findMany({
      where: { direction: "INBOUND", conversation: { businessId, customerId } },
      select: { sentAt: true },
      orderBy: { sentAt: "desc" },
      take: TIMING_SAMPLE_SIZE,
    });
    if (messages.length < MIN_SAMPLE_FOR_TIMING) return null;

    const countByHour = new Map<number, number>();
    for (const m of messages) {
      const hour = m.sentAt.getHours();
      countByHour.set(hour, (countByHour.get(hour) ?? 0) + 1);
    }
    const [bestHour] = [...countByHour.entries()].sort((a, b) => b[1] - a[1])[0];
    return { hour: bestHour, sampleSize: messages.length };
  }

  /** Per-type funnel: how many opportunities were created, sent, converted, or dismissed, plus the resulting conversion rate and attributed revenue — the P2 "which opportunity types actually work" view. */
  async typeAnalytics(businessId: string) {
    const grouped = await this.prisma.opportunity.groupBy({
      by: ["type", "status"],
      where: { businessId },
      _count: { _all: true },
    });
    const outcomes = await this.prisma.opportunityOutcome.findMany({
      where: { opportunity: { businessId }, orderId: { not: null } },
      select: { attributedRevenue: true, opportunity: { select: { type: true } } },
    });
    const revenueByType = new Map<string, number>();
    for (const o of outcomes) {
      revenueByType.set(o.opportunity.type, (revenueByType.get(o.opportunity.type) ?? 0) + Number(o.attributedRevenue ?? 0));
    }

    const byType = new Map<string, { created: number; sent: number; converted: number; dismissed: number }>();
    for (const g of grouped) {
      const b = byType.get(g.type) ?? { created: 0, sent: 0, converted: 0, dismissed: 0 };
      b.created += g._count._all;
      if (g.status === "SENT" || g.status === "CONVERTED") b.sent += g._count._all; // CONVERTED implies it was sent first
      if (g.status === "CONVERTED") b.converted += g._count._all;
      if (g.status === "DISMISSED") b.dismissed += g._count._all;
      byType.set(g.type, b);
    }

    return [...byType.entries()].map(([type, v]) => ({
      type,
      ...v,
      conversionRate: v.sent ? Math.round((v.converted / v.sent) * 1000) / 10 : 0,
      revenueAttributed: revenueByType.get(type) ?? 0,
    }));
  }

  /** Compares conversion rate for suggestions sent as-drafted vs. suggestions the merchant edited before sending, per type — surfaces whether editing actually helps. */
  async messagePerformance(businessId: string) {
    const sent = await this.prisma.opportunity.findMany({
      where: { businessId, status: { in: ["SENT", "CONVERTED"] } },
      select: { type: true, status: true, suggestion: { select: { editedMessage: true } } },
    });

    const buckets = new Map<string, { type: string; variant: "original" | "edited"; sent: number; converted: number }>();
    for (const o of sent) {
      const variant: "original" | "edited" = o.suggestion?.editedMessage ? "edited" : "original";
      const key = `${o.type}:${variant}`;
      const b = buckets.get(key) ?? { type: o.type, variant, sent: 0, converted: 0 };
      b.sent += 1;
      if (o.status === "CONVERTED") b.converted += 1;
      buckets.set(key, b);
    }

    return [...buckets.values()].map((b) => ({ ...b, conversionRate: b.sent ? Math.round((b.converted / b.sent) * 1000) / 10 : 0 }));
  }

  /** Daily created/sent/revenue counts over the trailing window — feeds the Analytics page's opportunity trend chart.
   * Bucketing is done entirely in UTC (both the JS-side day keys and Postgres's date_trunc, which operates in the session's UTC timezone)
   * to avoid an off-by-one day shift when the API process itself runs in a non-UTC local timezone. */
  async trends(businessId: string, days = 30) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(todayUtc - (days - 1) * 24 * 60 * 60 * 1000);

    const [created, sent, revenue] = await Promise.all([
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "Opportunity"
        WHERE "businessId" = ${businessId} AND "createdAt" >= ${since}
        GROUP BY day ORDER BY day ASC
      `,
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', o."sentAt") AS day, COUNT(*)::bigint AS count
        FROM "OpportunityOutcome" o
        JOIN "Opportunity" opp ON opp.id = o."opportunityId"
        WHERE opp."businessId" = ${businessId} AND o."sentAt" >= ${since}
        GROUP BY day ORDER BY day ASC
      `,
      this.prisma.$queryRaw<{ day: Date; total: string }[]>`
        SELECT date_trunc('day', o."updatedAt") AS day, COALESCE(SUM(o."attributedRevenue"), 0)::text AS total
        FROM "OpportunityOutcome" o
        JOIN "Opportunity" opp ON opp.id = o."opportunityId"
        WHERE opp."businessId" = ${businessId} AND o."orderId" IS NOT NULL AND o."updatedAt" >= ${since}
        GROUP BY day ORDER BY day ASC
      `,
    ]);

    const byDay = new Map<string, { date: string; created: number; sent: number; revenue: number }>();
    for (let i = 0; i < days; i++) {
      const key = new Date(since.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      byDay.set(key, { date: key, created: 0, sent: 0, revenue: 0 });
    }
    for (const row of created) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = byDay.get(key);
      if (entry) entry.created = Number(row.count);
    }
    for (const row of sent) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = byDay.get(key);
      if (entry) entry.sent = Number(row.count);
    }
    for (const row of revenue) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = byDay.get(key);
      if (entry) entry.revenue = Number(row.total);
    }
    return [...byDay.values()];
  }

  /** Convenience wrapper for API-side callers (shopping-flow, ai.service, inventory, orders) — drafts the message via AI, then creates. */
  async createWithAiMessage(input: Omit<CreateOpportunityInput, "message"> & { customerName: string; businessName: string; productName?: string; price?: string; basedOnProductName?: string }) {
    const message = await this.suggestionAi.draftMessage({ type: input.type, customerName: input.customerName, businessName: input.businessName, productName: input.productName, price: input.price, basedOnProductName: input.basedOnProductName });
    return this.create({ ...input, message });
  }

  async listInbox(businessId: string, status?: OpportunityStatus) {
    return this.prisma.opportunity.findMany({
      where: { businessId, ...(status ? { status } : { status: { in: DEDUP_STATUSES } }) },
      include: INCLUDE,
      orderBy: [{ priority: "desc" }, { score: "desc" }, { createdAt: "desc" }],
    });
  }

  async summary(businessId: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [active, highPriority, awaitingAction, sentToday, converted] = await Promise.all([
      this.prisma.opportunity.findMany({ where: { businessId, status: { in: DEDUP_STATUSES } }, select: { estimatedValue: true } }),
      this.prisma.opportunity.count({ where: { businessId, status: { in: DEDUP_STATUSES }, priority: "HIGH" } }),
      this.prisma.opportunity.count({ where: { businessId, status: "NEW" } }),
      this.prisma.opportunityOutcome.count({ where: { opportunity: { businessId }, sentAt: { gte: startOfToday } } }),
      this.prisma.opportunityOutcome.findMany({ where: { opportunity: { businessId }, orderId: { not: null } }, select: { attributedRevenue: true } }),
    ]);

    return {
      opportunitiesDetected: active.length,
      highPriority,
      potentialRevenue: active.reduce((sum, o) => sum + Number(o.estimatedValue ?? 0), 0),
      awaitingAction,
      messagesSentToday: sentToday,
      ordersInfluenced: converted.length,
      revenueInfluenced: converted.reduce((sum, o) => sum + Number(o.attributedRevenue ?? 0), 0),
    };
  }

  private async resolveConversationId(businessId: string, customerId: string, relatedCartId: string | null): Promise<string> {
    if (relatedCartId) {
      const cart = await this.prisma.cart.findFirst({ where: { id: relatedCartId, businessId } });
      if (cart) return cart.conversationId;
    }
    const latest = await this.prisma.conversation.findFirst({ where: { businessId, customerId }, orderBy: { lastMessageAt: "desc" } });
    if (!latest) throw new BadRequestException("This customer has no conversation to send a message in.");
    return latest.id;
  }

  async send(opportunityId: string, businessId: string, editedMessage?: string) {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, businessId },
      include: { suggestion: true, relatedProduct: { include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
    if (!opportunity) throw new NotFoundException("Opportunity not found.");
    if (!opportunity.suggestion) throw new BadRequestException("This opportunity has no suggestion to send.");
    if (opportunity.status === "SENT" || opportunity.status === "CONVERTED") throw new BadRequestException("This suggestion has already been sent.");

    const conversationId = await this.resolveConversationId(businessId, opportunity.customerId, opportunity.relatedCartId);
    const finalMessage = editedMessage?.trim() || opportunity.suggestion.editedMessage || opportunity.suggestion.message;

    // BACK_IN_STOCK gets the product photo + tap-to-choose buttons instead of plain text, so the customer can
    // add it to cart right from the notification rather than having to type anything
    const restockedVariant = opportunity.type === "BACK_IN_STOCK" ? opportunity.relatedProduct?.variants[0] : undefined;
    if (restockedVariant) {
      await this.conversations.sendButtons(conversationId, businessId, finalMessage, [
        { id: `variant_${restockedVariant.id}`, title: "🛒 Add to Cart" },
        { id: "bis_dismiss", title: "Maybe Later" },
      ], opportunity.relatedProduct?.imageUrl ? toPublicImageUrl(opportunity.relatedProduct.imageUrl) : undefined);
    } else {
      await this.conversations.sendMessage(conversationId, businessId, finalMessage);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.suggestion.update({ where: { opportunityId }, data: { editedMessage: editedMessage?.trim() || opportunity.suggestion!.editedMessage } });
      await tx.opportunity.update({ where: { id: opportunityId }, data: { status: "SENT" } });
      await tx.opportunityOutcome.upsert({
        where: { opportunityId },
        create: { opportunityId, sentAt: new Date() },
        update: { sentAt: new Date() },
      });
    });

    return this.prisma.opportunity.findUnique({ where: { id: opportunityId }, include: INCLUDE });
  }

  /** Dismisses any live (non-terminal) opportunity of the given type/target — used when a stronger signal supersedes a weaker one (e.g. HIGH_PURCHASE_INTENT replacing a plain PRODUCT_ENQUIRY for the same product). */
  async supersede(businessId: string, customerId: string, type: OpportunityType, relatedProductId: string): Promise<void> {
    await this.prisma.opportunity.updateMany({
      where: { businessId, customerId, type, relatedProductId, status: { in: DEDUP_STATUSES } },
      data: { status: "DISMISSED" },
    });
  }

  async updateMessage(opportunityId: string, businessId: string, message: string) {
    const opportunity = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, businessId } });
    if (!opportunity) throw new NotFoundException("Opportunity not found.");
    await this.prisma.suggestion.update({ where: { opportunityId }, data: { editedMessage: message.trim() } });
    return this.prisma.opportunity.findUnique({ where: { id: opportunityId }, include: INCLUDE });
  }

  async dismiss(opportunityId: string, businessId: string) {
    const opportunity = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, businessId } });
    if (!opportunity) throw new NotFoundException("Opportunity not found.");
    return this.prisma.opportunity.update({ where: { id: opportunityId }, data: { status: "DISMISSED" }, include: INCLUDE });
  }

  async snooze(opportunityId: string, businessId: string, hours = 24) {
    const opportunity = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, businessId } });
    if (!opportunity) throw new NotFoundException("Opportunity not found.");
    const snoozedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    return this.prisma.opportunity.update({ where: { id: opportunityId }, data: { status: "SNOOZED", snoozedUntil }, include: INCLUDE });
  }

  /** Wakes up snoozed opportunities whose timer has elapsed — called opportunistically before listing the inbox. */
  async wakeSnoozed(businessId: string) {
    await this.prisma.opportunity.updateMany({
      where: { businessId, status: "SNOOZED", snoozedUntil: { lte: new Date() } },
      data: { status: "NEW", snoozedUntil: null },
    });
  }

  /** Best-effort attribution: if this customer has a recently-SENT, not-yet-converted opportunity, credit this order to it. */
  async attachOrderOutcome(businessId: string, customerId: string, order: { id: string; total: Prisma.Decimal | number | string }) {
    const since = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const candidate = await this.prisma.opportunity.findFirst({
      where: { businessId, customerId, status: "SENT", updatedAt: { gte: since }, outcome: { orderId: null } },
      orderBy: { updatedAt: "desc" },
      include: { outcome: true },
    });
    if (!candidate) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.opportunityOutcome.update({ where: { opportunityId: candidate.id }, data: { orderId: order.id, attributedRevenue: Number(order.total) } });
      await tx.opportunity.update({ where: { id: candidate.id }, data: { status: "CONVERTED" } });
    });
  }
}
