import { Injectable, Logger } from "@nestjs/common";
import { ActivityEventType, Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { AiService } from "../ai/ai.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { parseWhatsAppWebhook, ParsedWhatsAppMessage } from "./whatsapp-parser";

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly ai: AiService,
  ) {}

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
    const isNewCustomer = !customer;
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { businessId: business.id, phone: msg.from, firstName: msg.displayName ?? null },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CUSTOMER_TAGGED, summary: `New WhatsApp contact: ${msg.displayName ?? msg.from}` },
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
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { businessId: business.id, customerId: customer.id, identityId: identity.id, channel: Channel.WHATSAPP },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CONVERSATION_CREATED, summary: `WhatsApp conversation started with ${msg.displayName ?? msg.from}` },
      });
      // schedule a follow-up draft if no agent reply within the configured window
      await this.queues.scheduleFollowUp(conversation.id, business.id, customer.id);
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

    await this.prisma.activityEvent.create({
      data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.MESSAGE_SENT, summary: `${msg.displayName ?? msg.from}: "${msg.text.slice(0, 80)}"` },
    });

    await recalculateLeadScore(this.prisma, customer.id, business.id);

    // fully autonomous reply — no human approval step
    try {
      await this.ai.generateAndSendReply(conversation.id);
    } catch (err) {
      this.logger.error(`Automatic AI reply failed for conversation ${conversation.id}`, err);
    }
  }
}
