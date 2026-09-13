import { Injectable } from "@nestjs/common";
import { CustomerSignalType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

const INTEREST_TYPES: CustomerSignalType[] = [CustomerSignalType.PRODUCT_VIEWED, CustomerSignalType.PRODUCT_ENQUIRY];

@Injectable()
export class CustomerSignalService {
  constructor(private readonly prisma: PrismaService) {}

  async record(businessId: string, customerId: string, type: CustomerSignalType, opts: { productId?: string; variantId?: string; metadata?: Record<string, unknown> } = {}) {
    return this.prisma.customerSignal.create({
      data: { businessId, customerId, type, productId: opts.productId, variantId: opts.variantId, metadata: opts.metadata as object | undefined },
    });
  }

  /** Distinct customers who showed interest (viewed/enquired) in a product within the lookback window — used to notify on restock. */
  async recentlyInterestedCustomers(businessId: string, productId: string, sinceDays = 30): Promise<string[]> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const signals = await this.prisma.customerSignal.findMany({
      where: { businessId, productId, type: { in: INTEREST_TYPES }, createdAt: { gte: since } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    return signals.map((s) => s.customerId);
  }
}
