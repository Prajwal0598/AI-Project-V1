import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { OpportunityPriority, OpportunityStatus, OpportunityType, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { SuggestionAiService } from "./suggestion-ai.service";

// how far back to look for a SENT suggestion when attributing a new order to it — a simple, explainable
// heuristic (not causal modelling); refining attribution is explicitly a later "Learning" phase, not P0
const ATTRIBUTION_WINDOW_DAYS = 7;
// don't create a second live opportunity of the same kind for the same target while one is still unresolved
const DEDUP_STATUSES: OpportunityStatus[] = [OpportunityStatus.NEW, OpportunityStatus.SENT, OpportunityStatus.SNOOZED];

interface CreateOpportunityInput {
  businessId: string;
  customerId: string;
  type: OpportunityType;
  reason: string;
  estimatedValue?: number;
  confidence: number; // 0-1
  relatedProductId?: string;
  relatedCartId?: string;
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
  ) {}

  /** Deterministic 0-100 score from concrete signals — never AI-derived, so every ranking is auditable. */
  private score(type: OpportunityType, estimatedValue: number | undefined, confidence: number): { score: number; priority: OpportunityPriority } {
    const base: Record<OpportunityType, number> = { ABANDONED_CART: 60, BACK_IN_STOCK: 55, PRODUCT_ENQUIRY: 45 };
    const valueBonus = Math.min(20, Math.round((estimatedValue ?? 0) / 100));
    const confidenceBonus = Math.round(confidence * 20);
    const score = Math.min(100, base[type] + valueBonus + confidenceBonus);
    const priority: OpportunityPriority = score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW";
    return { score, priority };
  }

  /** Creates an Opportunity + AI-drafted Suggestion, unless a live (non-terminal) one already exists for the same target. */
  async create(input: CreateOpportunityInput) {
    const business = await this.prisma.business.findUnique({ where: { id: input.businessId }, select: { proactiveSuggestionsEnabled: true } });
    if (!business?.proactiveSuggestionsEnabled) return null;

    const existing = await this.prisma.opportunity.findFirst({
      where: {
        businessId: input.businessId,
        customerId: input.customerId,
        type: input.type,
        status: { in: DEDUP_STATUSES },
        ...(input.relatedProductId ? { relatedProductId: input.relatedProductId } : {}),
        ...(input.relatedCartId ? { relatedCartId: input.relatedCartId } : {}),
      },
    });
    if (existing) return existing;

    const { score, priority } = this.score(input.type, input.estimatedValue, input.confidence);
    return this.prisma.opportunity.create({
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
        suggestion: { create: { message: input.message } },
      },
      include: INCLUDE,
    });
  }

  /** Convenience wrapper for API-side callers (shopping-flow, ai.service, inventory) — drafts the message via AI, then creates. */
  async createWithAiMessage(input: Omit<CreateOpportunityInput, "message"> & { customerName: string; businessName: string; productName?: string; price?: string }) {
    const message = await this.suggestionAi.draftMessage({ type: input.type, customerName: input.customerName, businessName: input.businessName, productName: input.productName, price: input.price });
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
    const opportunity = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, businessId }, include: { suggestion: true } });
    if (!opportunity) throw new NotFoundException("Opportunity not found.");
    if (!opportunity.suggestion) throw new BadRequestException("This opportunity has no suggestion to send.");
    if (opportunity.status === "SENT" || opportunity.status === "CONVERTED") throw new BadRequestException("This suggestion has already been sent.");

    const conversationId = await this.resolveConversationId(businessId, opportunity.customerId, opportunity.relatedCartId);
    const finalMessage = editedMessage?.trim() || opportunity.suggestion.editedMessage || opportunity.suggestion.message;
    await this.conversations.sendMessage(conversationId, businessId, finalMessage);

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
