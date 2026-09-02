import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateMessageDto } from "./dto/create-message.dto";

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string) {
    return this.prisma.conversation.findMany({
      where: { businessId },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        identity: { select: { identifier: true, displayName: true } },
        messages: { orderBy: { sentAt: "desc" }, take: 1 },
      },
      orderBy: { lastMessageAt: "desc" },
    });
  }

  async create(customerId: string, input: CreateConversationDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException("Customer not found.");
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

  async addMessage(conversationId: string, input: CreateMessageDto) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({ data: { conversationId, direction: input.direction, content: input.content.trim(), providerMessageId: input.providerMessageId?.trim() || null, sentAt } });
      // any incoming message reopens the conversation per product policy
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: sentAt, status: ConversationStatus.OPEN } });
      return message;
    });
  }

  async sendMessage(conversationId: string, businessId: string, content: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { identity: true, business: true },
    });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    if (!conversation.identity?.identifier) {
      throw new BadRequestException("No channel identity linked to this conversation.");
    }

    const providerMessageId = conversation.channel === Channel.INSTAGRAM
      ? await this.sendInstagram(conversation.business, conversation.identity.identifier, content)
      : conversation.channel === Channel.WHATSAPP
        ? await this.sendWhatsApp(conversation.business, conversation.identity.identifier, content)
        : conversation.channel === Channel.EMAIL
          ? await this.sendEmail(conversation.business, conversation.identity.identifier, conversation.title, content)
          : (() => { throw new BadRequestException("Send is only supported for WhatsApp, Instagram, and Email conversations currently."); })();

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: { conversationId, direction: MessageDirection.OUTBOUND, content: content.trim(), providerMessageId, sentAt: now },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } });
      return message;
    });
  }

  private async sendWhatsApp(business: { whatsappPhoneNumberId: string | null }, to: string, content: string): Promise<string | null> {
    if (!business.whatsappPhoneNumberId) {
      throw new BadRequestException("WhatsApp phone number ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) throw new ServiceUnavailableException("WHATSAPP_ACCESS_TOKEN is not configured.");

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${business.whatsappPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: content.trim() },
        }),
      },
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ServiceUnavailableException(`WhatsApp API error: ${JSON.stringify(errBody)}`);
    }
    const data = await res.json() as { messages?: { id: string }[] };
    return data.messages?.[0]?.id ?? null;
  }

  private async sendInstagram(business: { instagramPageId: string | null }, to: string, content: string): Promise<string | null> {
    if (!business.instagramPageId) {
      throw new BadRequestException("Instagram Page ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    if (!accessToken) throw new ServiceUnavailableException("INSTAGRAM_PAGE_ACCESS_TOKEN is not configured.");

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${business.instagramPageId}/messages?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: to },
          message: { text: content.trim() },
        }),
      },
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ServiceUnavailableException(`Instagram API error: ${JSON.stringify(errBody)}`);
    }
    const data = await res.json() as { message_id?: string };
    return data.message_id ?? null;
  }

  private async sendEmail(business: { supportEmail: string | null }, to: string, subject: string | null, content: string): Promise<string | null> {
    if (!business.supportEmail) {
      throw new BadRequestException("Support email not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const token = process.env.POSTMARK_SERVER_TOKEN;
    const from = process.env.EMAIL_FROM;
    if (!token || !from) throw new ServiceUnavailableException("POSTMARK_SERVER_TOKEN or EMAIL_FROM is not configured.");

    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": token },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject ? `Re: ${subject}` : "Re: your message",
        TextBody: content.trim(),
        MessageStream: "outbound",
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ServiceUnavailableException(`Postmark API error: ${JSON.stringify(errBody)}`);
    }
    const data = await res.json() as { MessageID?: string };
    return data.MessageID ?? null;
  }
}
