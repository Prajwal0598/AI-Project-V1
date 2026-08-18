import { Injectable, NotFoundException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.business.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return business;
  }

  async stats(businessId: string) {
    const [leads, customers, conversations, openConversations, orders, revenueAgg] = await Promise.all([
      this.prisma.customer.count({ where: { businessId, type: "LEAD" } }),
      this.prisma.customer.count({ where: { businessId, type: "CUSTOMER" } }),
      this.prisma.conversation.count({ where: { businessId } }),
      this.prisma.conversation.count({ where: { businessId, status: "OPEN" } }),
      this.prisma.order.count({ where: { businessId } }),
      this.prisma.order.aggregate({
        where: { businessId, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLED] } },
        _sum: { total: true },
      }),
    ]);
    return { leads, customers, conversations, openConversations, orders, revenue: revenueAgg._sum.total ?? 0 };
  }

  async create(input: CreateBusinessDto) {
    return this.prisma.business.create({
      data: {
        name: input.name.trim(),
        industry: input.industry?.trim() || null,
        website: input.website?.trim() || null,
        timezone: input.timezone?.trim() || "Asia/Kolkata"
      }
    });
  }

  async update(businessId: string, input: UpdateBusinessDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
    return this.prisma.business.update({
      where: { id: businessId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.industry !== undefined && { industry: input.industry?.trim() || null }),
        ...(input.website !== undefined && { website: input.website?.trim() || null }),
        ...(input.timezone !== undefined && { timezone: input.timezone.trim() }),
        ...(input.whatsappPhoneNumberId !== undefined && { whatsappPhoneNumberId: input.whatsappPhoneNumberId?.trim() || null }),
      },
    });
  }
}
