import { Injectable, Logger } from "@nestjs/common";
import { ActivityEventType, Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { parseEmailWebhook } from "./email-parser";

@Injectable()
export class EmailWebhookService {
  private readonly logger = new Logger(EmailWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  async ingest(body: unknown): Promise<void> {
    const msg = parseEmailWebhook(body);
    if (!msg) {
      this.logger.warn("Received an email webhook payload that could not be parsed.");
      return;
    }

    const business = await this.prisma.business.findFirst({
      where: { supportEmail: msg.toAddress },
    });
    if (!business) {
      this.logger.warn(`No business mapped to support email: ${msg.toAddress}`);
      return;
    }

    let customer = await this.prisma.customer.findFirst({
      where: { businessId: business.id, email: msg.from },
    });
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { businessId: business.id, email: msg.from, firstName: msg.fromName ?? null },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CUSTOMER_TAGGED, summary: `New email contact: ${msg.fromName ?? msg.from}` },
      });
    }

    const identity = await this.prisma.identity.upsert({
      where: { businessId_channel_identifier: { businessId: business.id, channel: Channel.EMAIL, identifier: msg.from } },
      create: { businessId: business.id, customerId: customer.id, channel: Channel.EMAIL, identifier: msg.from, displayName: msg.fromName ?? null },
      update: {},
    });

    let conversation = await this.prisma.conversation.findFirst({
      where: { businessId: business.id, customerId: customer.id, channel: Channel.EMAIL, status: ConversationStatus.OPEN },
      orderBy: { createdAt: "desc" },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { businessId: business.id, customerId: customer.id, identityId: identity.id, channel: Channel.EMAIL, title: msg.subject || null },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CONVERSATION_CREATED, summary: `Email conversation started with ${msg.fromName ?? msg.from}` },
      });
      await this.queues.scheduleFollowUp(conversation.id, business.id, customer.id);
    }

    // upsert by providerMessageId to deduplicate provider re-deliveries
    await this.prisma.message.upsert({
      where: { providerMessageId: msg.messageId },
      create: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        content: msg.text,
        providerMessageId: msg.messageId,
      },
      update: {},
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), status: ConversationStatus.OPEN },
    });

    await this.prisma.activityEvent.create({
      data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.MESSAGE_SENT, summary: `${msg.fromName ?? msg.from}: "${msg.text.slice(0, 80)}"` },
    });

    await recalculateLeadScore(this.prisma, customer.id, business.id);
  }
}
