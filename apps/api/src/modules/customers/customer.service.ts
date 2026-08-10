import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Channel, CustomerType, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

export interface CreateCustomerInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  type?: CustomerType;
  tags?: string[];
}

export interface CreateIdentityInput {
  channel: Channel;
  identifier: string;
  displayName?: string;
  isPrimary?: boolean;
}

@Injectable()
export class CustomerService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertBusiness(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");
  }

  async list(businessId: string, search?: string) {
    await this.assertBusiness(businessId);
    const term = search?.trim();
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(term ? { OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { identities: { some: { identifier: { contains: term, mode: "insensitive" } } } }
      ] } : {})
    };
    return this.prisma.customer.findMany({
      where,
      include: { identities: true, leadScore: true, _count: { select: { conversations: true, orders: true } } },
      orderBy: [{ updatedAt: "desc" }]
    });
  }

  async create(businessId: string, input: CreateCustomerInput) {
    await this.assertBusiness(businessId);
    if (!input.firstName?.trim() && !input.email?.trim() && !input.phone?.trim()) {
      throw new BadRequestException("Provide at least a name, email, or phone number.");
    }
    return this.prisma.customer.create({
      data: {
        businessId,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        email: input.email?.trim().toLowerCase() || null,
        phone: input.phone?.trim() || null,
        type: input.type ?? CustomerType.LEAD,
        tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? []
      }
    });
  }

  async get(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        identities: true,
        leadScore: true,
        conversations: { include: { messages: { orderBy: { createdAt: "asc" } } }, orderBy: { lastMessageAt: "desc" } },
        orders: { orderBy: { createdAt: "desc" } }
      }
    });
    if (!customer) throw new NotFoundException("Customer not found.");
    return customer;
  }

  async addIdentity(customerId: string, input: CreateIdentityInput) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    if (!Object.values(Channel).includes(input.channel) || !input.identifier?.trim()) {
      throw new BadRequestException("A supported channel and identifier are required.");
    }
    try {
      return await this.prisma.identity.create({
        data: { customerId, businessId: customer.businessId, channel: input.channel, identifier: input.identifier.trim(), displayName: input.displayName?.trim() || null, isPrimary: Boolean(input.isPrimary) }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("This channel identity already belongs to a customer.");
      throw error;
    }
  }
}
