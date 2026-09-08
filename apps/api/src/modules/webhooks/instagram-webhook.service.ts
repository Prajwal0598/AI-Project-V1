import { Injectable, Logger } from "@nestjs/common";
import { ActivityEventType, Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { AiService } from "../ai/ai.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { parseInstagramWebhook, ParsedInstagramMessage } from "./instagram-parser";

@Injectable()
export class InstagramWebhookService {
  private readonly logger = new Logger(InstagramWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly ai: AiService,
  ) {}

  async ingest(body: unknown): Promise<void> {
    const messages = parseInstagramWebhook(body);
    for (const msg of messages) {
      try {
        await this.processMessage(msg);
      } catch (err) {
        this.logger.error(`Failed to process Instagram message ${msg.igMessageId}`, err);
      }
    }
  }

  private async processMessage(msg: ParsedInstagramMessage): Promise<void> {
    const business = await this.prisma.business.findFirst({
      where: { instagramPageId: msg.pageId },
    });
    if (!business) {
      this.logger.warn(`No business mapped to Instagram page ID: ${msg.pageId}`);
      return;
    }

    let customer = await this.prisma.customer.findFirst({
      where: { businessId: business.id, identities: { some: { businessId: business.id, channel: Channel.INSTAGRAM, identifier: msg.from } } },
    });
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { businessId: business.id },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CUSTOMER_TAGGED, summary: `New Instagram contact: ${msg.from}` },
      });
    }

    const identity = await this.prisma.identity.upsert({
      where: { businessId_channel_identifier: { businessId: business.id, channel: Channel.INSTAGRAM, identifier: msg.from } },
      create: { businessId: business.id, customerId: customer.id, channel: Channel.INSTAGRAM, identifier: msg.from },
      update: {},
    });

    let conversation = await this.prisma.conversation.findFirst({
      where: { businessId: business.id, customerId: customer.id, channel: Channel.INSTAGRAM, status: ConversationStatus.OPEN },
      orderBy: { createdAt: "desc" },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { businessId: business.id, customerId: customer.id, identityId: identity.id, channel: Channel.INSTAGRAM },
      });
      await this.prisma.activityEvent.create({
        data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.CONVERSATION_CREATED, summary: `Instagram conversation started with ${msg.from}` },
      });
      await this.queues.scheduleFollowUp(conversation.id, business.id, customer.id);
    }

    // upsert by providerMessageId to deduplicate Meta re-deliveries, and detect whether this was actually new
    const existing = await this.prisma.message.findUnique({ where: { providerMessageId: msg.igMessageId } });
    await this.prisma.message.upsert({
      where: { providerMessageId: msg.igMessageId },
      create: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        content: msg.text,
        providerMessageId: msg.igMessageId,
        sentAt: msg.timestamp,
      },
      update: {},
    });
    if (existing) {
      this.logger.warn(`Ignoring re-delivered Instagram message ${msg.igMessageId} — already processed.`);
      return;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: msg.timestamp, status: ConversationStatus.OPEN },
    });

    await this.prisma.activityEvent.create({
      data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.MESSAGE_SENT, summary: `${msg.from}: "${msg.text.slice(0, 80)}"` },
    });

    await recalculateLeadScore(this.prisma, customer.id, business.id);

    // fully autonomous reply — no human approval step
    try {
      await this.ai.generateAndSendReply(conversation.id, business.id);
    } catch (err) {
      this.logger.error(`Automatic AI reply failed for conversation ${conversation.id}`, err);
    }
  }
}
