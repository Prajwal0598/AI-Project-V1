import { Injectable, Logger } from "@nestjs/common";
import { Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { parseWhatsAppWebhook, ParsedWhatsAppMessage } from "./whatsapp-parser";

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(body: unknown): Promise<void> {
    const messages = parseWhatsAppWebhook(body);
    for (const msg of messages) {
      try {
        await this.processMessage(msg);
      } catch (err) {
        this.logger.error(`Failed to process WhatsApp message ${msg.waMessageId}`, err);
      }
    }
  }

  private async processMessage(msg: ParsedWhatsAppMessage): Promise<void> {
    const business = await this.prisma.business.findFirst({
      where: { whatsappPhoneNumberId: msg.phoneNumberId },
    });
    if (!business) {
      this.logger.warn(`No business mapped to WhatsApp phone number ID: ${msg.phoneNumberId}`);
      return;
    }

    let customer = await this.prisma.customer.findFirst({
      where: { businessId: business.id, phone: msg.from },
    });
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { businessId: business.id, phone: msg.from, firstName: msg.displayName ?? null },
      });
    }

    const identity = await this.prisma.identity.upsert({
      where: { businessId_channel_identifier: { businessId: business.id, channel: Channel.WHATSAPP, identifier: msg.from } },
      create: { businessId: business.id, customerId: customer.id, channel: Channel.WHATSAPP, identifier: msg.from, displayName: msg.displayName ?? null },
      update: {},
    });

    let conversation = await this.prisma.conversation.findFirst({
      where: { businessId: business.id, customerId: customer.id, channel: Channel.WHATSAPP, status: ConversationStatus.OPEN },
      orderBy: { createdAt: "desc" },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { businessId: business.id, customerId: customer.id, identityId: identity.id, channel: Channel.WHATSAPP },
      });
    }

    // upsert by providerMessageId deduplicate Meta re-deliveries
    await this.prisma.message.upsert({
      where: { providerMessageId: msg.waMessageId },
      create: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        content: msg.text,
        providerMessageId: msg.waMessageId,
        sentAt: msg.timestamp,
      },
      update: {},
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: msg.timestamp, status: ConversationStatus.OPEN },
    });
  }
}
