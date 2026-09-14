import { Injectable, NotFoundException } from "@nestjs/common";
import { PromotionTargetSegment } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { OpportunityService } from "../opportunities/opportunity.service";
import { CreatePromotionDto } from "./dto/create-promotion.dto";

const SEGMENT_LABEL: Record<PromotionTargetSegment, string> = {
  ALL_CUSTOMERS: "all customers",
  CATEGORY_BUYERS: "past buyers in this category",
  HIGH_VALUE_CUSTOMERS: "high-value customers",
};

@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly opportunities: OpportunityService,
  ) {}

  async list(businessId: string) {
    return this.prisma.promotion.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
  }

  async create(businessId: string, input: CreatePromotionDto) {
    if (input.targetSegment === PromotionTargetSegment.CATEGORY_BUYERS && !input.categoryId) {
      throw new NotFoundException("categoryId is required when targeting category buyers.");
    }
    return this.prisma.promotion.create({
      data: {
        businessId,
        title: input.title.trim(),
        message: input.message.trim(),
        discountDescription: input.discountDescription?.trim() || null,
        targetSegment: input.targetSegment,
        categoryId: input.targetSegment === PromotionTargetSegment.CATEGORY_BUYERS ? input.categoryId : null,
      },
    });
  }

  async remove(id: string, businessId: string) {
    const promotion = await this.prisma.promotion.findFirst({ where: { id, businessId } });
    if (!promotion) throw new NotFoundException("Promotion not found.");
    if (promotion.broadcastedAt) throw new NotFoundException("Already-broadcast promotions can't be deleted — they're part of the audit trail.");
    return this.prisma.promotion.delete({ where: { id } });
  }

  /** Resolves the target segment to a customer list and creates one PROMOTION opportunity per customer — the message is sent verbatim, never AI-drafted. */
  async broadcast(id: string, businessId: string) {
    const promotion = await this.prisma.promotion.findFirst({ where: { id, businessId } });
    if (!promotion) throw new NotFoundException("Promotion not found.");
    if (promotion.broadcastedAt) throw new NotFoundException("This promotion has already been broadcast.");

    const customerIds = await this.resolveSegment(businessId, promotion.targetSegment, promotion.categoryId);
    let created = 0;
    for (const customerId of customerIds) {
      const result = await this.opportunities.create({
        businessId, customerId, type: "PROMOTION",
        reason: `Promotion "${promotion.title}" targeted at ${SEGMENT_LABEL[promotion.targetSegment]}.`,
        confidence: 0.9,
        relatedPromotionId: promotion.id,
        message: promotion.message,
      });
      if (result) created += 1;
    }

    await this.prisma.promotion.update({ where: { id }, data: { broadcastedAt: new Date(), broadcastCount: created } });
    return { targeted: customerIds.length, created };
  }

  private async resolveSegment(businessId: string, segment: PromotionTargetSegment, categoryId: string | null): Promise<string[]> {
    if (segment === PromotionTargetSegment.CATEGORY_BUYERS) {
      const orders = await this.prisma.order.findMany({
        where: { businessId, status: { in: ["PAID", "FULFILLED"] }, items: { some: { product: { categoryId: categoryId ?? undefined } } } },
        select: { customerId: true },
        distinct: ["customerId"],
      });
      return orders.map((o) => o.customerId);
    }
    if (segment === PromotionTargetSegment.HIGH_VALUE_CUSTOMERS) {
      const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { highValueLeadScoreThreshold: true } });
      const customers = await this.prisma.customer.findMany({
        where: { businessId, leadScore: { score: { gte: business?.highValueLeadScoreThreshold ?? 70 } } },
        select: { id: true },
      });
      return customers.map((c) => c.id);
    }
    const customers = await this.prisma.customer.findMany({ where: { businessId }, select: { id: true } });
    return customers.map((c) => c.id);
  }
}
