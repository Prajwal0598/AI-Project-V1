import { Injectable, NotFoundException } from "@nestjs/common";
import { OpportunityType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

const ALL_TYPES: OpportunityType[] = [
  OpportunityType.ABANDONED_CART, OpportunityType.PRODUCT_ENQUIRY, OpportunityType.BACK_IN_STOCK,
  OpportunityType.HIGH_PURCHASE_INTENT, OpportunityType.REPEAT_PURCHASE, OpportunityType.CROSS_SELL, OpportunityType.UPSELL,
  OpportunityType.NEW_PRODUCT_MATCH, OpportunityType.PROMOTION, OpportunityType.UNANSWERED_CONVERSATION,
  OpportunityType.LOW_ENGAGEMENT, OpportunityType.HIGH_VALUE_CUSTOMER,
];

interface UpdateRuleInput {
  enabled?: boolean;
  autoSend?: boolean;
  businessHoursStart?: number | null;
  businessHoursEnd?: number | null;
  frequencyCapPerCustomerPerDay?: number | null;
  minConfidenceForAutoSend?: number;
  personalizedTiming?: boolean;
}

@Injectable()
export class AutomationRuleService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns every opportunity type's rule for this business, creating the (approval-first) default row for any type that doesn't have one yet. */
  async list(businessId: string) {
    const existing = await this.prisma.automationRule.findMany({ where: { businessId } });
    const missing = ALL_TYPES.filter((t) => !existing.some((r) => r.opportunityType === t));
    if (missing.length) {
      // skipDuplicates guards against a race: two concurrent calls can both see the same types as missing and both try to insert them
      await this.prisma.automationRule.createMany({ data: missing.map((opportunityType) => ({ businessId, opportunityType })), skipDuplicates: true });
      return this.prisma.automationRule.findMany({ where: { businessId }, orderBy: { opportunityType: "asc" } });
    }
    return existing.sort((a, b) => a.opportunityType.localeCompare(b.opportunityType));
  }

  /** Fetches (or lazily creates the default for) a single type's rule — used internally by the opportunity engine on every create. */
  async getFor(businessId: string, opportunityType: OpportunityType) {
    // upsert (not findUnique-then-create) — race-safe against two concurrent creates for the same business+type
    return this.prisma.automationRule.upsert({
      where: { businessId_opportunityType: { businessId, opportunityType } },
      create: { businessId, opportunityType },
      update: {},
    });
  }

  async update(businessId: string, opportunityType: OpportunityType, input: UpdateRuleInput) {
    const existing = await this.getFor(businessId, opportunityType);
    if (!existing) throw new NotFoundException("Automation rule not found.");
    return this.prisma.automationRule.update({
      where: { businessId_opportunityType: { businessId, opportunityType } },
      data: {
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.autoSend !== undefined && { autoSend: input.autoSend }),
        ...(input.businessHoursStart !== undefined && { businessHoursStart: input.businessHoursStart }),
        ...(input.businessHoursEnd !== undefined && { businessHoursEnd: input.businessHoursEnd }),
        ...(input.frequencyCapPerCustomerPerDay !== undefined && { frequencyCapPerCustomerPerDay: input.frequencyCapPerCustomerPerDay }),
        ...(input.minConfidenceForAutoSend !== undefined && { minConfidenceForAutoSend: input.minConfidenceForAutoSend }),
        ...(input.personalizedTiming !== undefined && { personalizedTiming: input.personalizedTiming }),
      },
    });
  }

  /** True if the current moment falls within the rule's business-hours window (or the rule has no restriction). */
  isWithinBusinessHours(rule: { businessHoursStart: number | null; businessHoursEnd: number | null }): boolean {
    if (rule.businessHoursStart == null || rule.businessHoursEnd == null) return true;
    const hour = new Date().getHours();
    return rule.businessHoursStart <= rule.businessHoursEnd
      ? hour >= rule.businessHoursStart && hour < rule.businessHoursEnd
      : hour >= rule.businessHoursStart || hour < rule.businessHoursEnd; // wraps past midnight, e.g. 22-6
  }

  /** How many opportunities (any type) have already been created for this customer today — the frequency-cap check. */
  async countCreatedTodayForCustomer(businessId: string, customerId: string): Promise<number> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return this.prisma.opportunity.count({ where: { businessId, customerId, createdAt: { gte: startOfToday } } });
  }
}
