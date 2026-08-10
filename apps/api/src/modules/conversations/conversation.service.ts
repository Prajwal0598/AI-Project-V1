import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

export interface CreateConversationInput {
  channel: Channel;
  identityId?: string;
  title?: string;
}

export interface CreateMessageInput {
  direction: MessageDirection;
  content: string;
  providerMessageId?: string;
  sentAt?: string;
}

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(customerId: string, input: CreateConversationInput) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    if (!Object.values(Channel).includes(input.channel)) throw new BadRequestException("A supported channel is required.");
    if (input.identityId) {
      const identity = await this.prisma.identity.findFirst({ where: { id: input.identityId, customerId } });
      if (!identity) throw new BadRequestException("Identity does not belong to this customer.");
    }
    return this.prisma.conversation.create({
      data: { businessId: customer.businessId, customerId, identityId: input.identityId, channel: input.channel, title: input.title?.trim() || null, status: ConversationStatus.OPEN }
    });
  }

  async get(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: true, identity: true, messages: { orderBy: { createdAt: "asc" } } } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    return conversation;
  }

  async addMessage(conversationId: string, input: CreateMessageInput) {
    if (!Object.values(MessageDirection).includes(input.direction) || !input.content?.trim()) {
      throw new BadRequestException("A valid direction and message content are required.");
    }
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
    if (Number.isNaN(sentAt.getTime())) throw new BadRequestException("sentAt must be a valid ISO date.");
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({ data: { conversationId, direction: input.direction, content: input.content.trim(), providerMessageId: input.providerMessageId?.trim() || null, sentAt } });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: sentAt, status: ConversationStatus.OPEN } });
      return message;
    });
  }
}
