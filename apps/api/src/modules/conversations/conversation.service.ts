import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Channel, ConversationOutcome, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { decryptSecret } from "../../common/crypto.helper";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateMessageDto } from "./dto/create-message.dto";

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Prefers the merchant's own encrypted credential; falls back to the shared .env token (single-demo-business setup). */
  private resolveToken(encrypted: string | null, envVar: string): string | undefined {
    if (encrypted) {
      try { return decryptSecret(encrypted); } catch (error) { this.logger.error(`Failed to decrypt credential (falling back to .env): ${envVar}`, error instanceof Error ? error.stack : String(error)); }
    }
    return process.env[envVar];
  }

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

  async create(customerId: string, businessId: string, input: CreateConversationDto) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!customer) throw new NotFoundException("Customer not found.");
    if (input.identityId) {
      const identity = await this.prisma.identity.findFirst({ where: { id: input.identityId, customerId } });
      if (!identity) throw new BadRequestException("Identity does not belong to this customer.");
    }
    return this.prisma.conversation.create({
      data: { businessId: customer.businessId, customerId, identityId: input.identityId, channel: input.channel, title: input.title?.trim() || null, status: ConversationStatus.OPEN }
    });
  }

  async get(conversationId: string, businessId: string) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId }, include: { customer: true, identity: true, messages: { orderBy: { createdAt: "asc" } } } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    return conversation;
  }

  async addMessage(conversationId: string, businessId: string, input: CreateMessageDto) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({ data: { conversationId, direction: input.direction, content: input.content.trim(), providerMessageId: input.providerMessageId?.trim() || null, sentAt } });
      // any incoming message reopens the conversation per product policy
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: sentAt, status: ConversationStatus.OPEN } });
      return message;
    });
  }

  /** Hands an escalated conversation back to the AI agent. */
  async resume(conversationId: string, businessId: string) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { escalated: false, escalationReason: null, ...(conversation.outcome === "ESCALATED" ? { outcome: "OPEN" } : {}) },
    });
  }

  /** Lets the business owner manually label how a conversation resolved, for CRM reporting. */
  async setOutcome(conversationId: string, businessId: string, outcome: ConversationOutcome) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId } });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    return this.prisma.conversation.update({ where: { id: conversationId }, data: { outcome } });
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

  private async sendWhatsApp(business: { whatsappPhoneNumberId: string | null; whatsappAccessTokenEncrypted: string | null }, to: string, content: string): Promise<string | null> {
    if (!business.whatsappPhoneNumberId) {
      throw new BadRequestException("WhatsApp phone number ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = this.resolveToken(business.whatsappAccessTokenEncrypted, "WHATSAPP_ACCESS_TOKEN");
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

  private async sendInstagram(business: { instagramPageId: string | null; instagramAccessTokenEncrypted: string | null }, to: string, content: string): Promise<string | null> {
    if (!business.instagramPageId) {
      throw new BadRequestException("Instagram Page ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = this.resolveToken(business.instagramAccessTokenEncrypted, "INSTAGRAM_PAGE_ACCESS_TOKEN");
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

  private async sendEmail(business: { supportEmail: string | null; postmarkServerTokenEncrypted: string | null }, to: string, subject: string | null, content: string): Promise<string | null> {
    if (!business.supportEmail) {
      throw new BadRequestException("Support email not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const token = this.resolveToken(business.postmarkServerTokenEncrypted, "POSTMARK_SERVER_TOKEN");
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

  /** Sends a product photo as a standalone image message — WhatsApp/Instagram only (no inline image support for email here). */
  async sendImage(conversationId: string, businessId: string, imageUrl: string, caption?: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: { identity: true, business: true },
    });
    if (!conversation) throw new NotFoundException("Conversation not found.");
    if (!conversation.identity?.identifier) {
      throw new BadRequestException("No channel identity linked to this conversation.");
    }

    const providerMessageId = conversation.channel === Channel.WHATSAPP
      ? await this.sendWhatsAppImage(conversation.business, conversation.identity.identifier, imageUrl, caption)
      : conversation.channel === Channel.INSTAGRAM
        ? await this.sendInstagramImage(conversation.business, conversation.identity.identifier, imageUrl)
        : (() => { throw new BadRequestException("Image send is only supported for WhatsApp and Instagram currently."); })();

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: { conversationId, direction: MessageDirection.OUTBOUND, content: caption?.trim() || "[image]", providerMessageId, sentAt: now, metadata: { type: "image", imageUrl } },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } });
      return message;
    });
  }

  private async sendWhatsAppImage(business: { whatsappPhoneNumberId: string | null; whatsappAccessTokenEncrypted: string | null }, to: string, imageUrl: string, caption?: string): Promise<string | null> {
    if (!business.whatsappPhoneNumberId) {
      throw new BadRequestException("WhatsApp phone number ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = this.resolveToken(business.whatsappAccessTokenEncrypted, "WHATSAPP_ACCESS_TOKEN");
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
          type: "image",
          image: { link: imageUrl, ...(caption ? { caption } : {}) },
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

  private async sendInstagramImage(business: { instagramPageId: string | null; instagramAccessTokenEncrypted: string | null }, to: string, imageUrl: string): Promise<string | null> {
    if (!business.instagramPageId) {
      throw new BadRequestException("Instagram Page ID not configured for this business — set it via PATCH /api/businesses/:id.");
    }
    const accessToken = this.resolveToken(business.instagramAccessTokenEncrypted, "INSTAGRAM_PAGE_ACCESS_TOKEN");
    if (!accessToken) throw new ServiceUnavailableException("INSTAGRAM_PAGE_ACCESS_TOKEN is not configured.");

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${business.instagramPageId}/messages?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: to },
          message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } },
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
}
