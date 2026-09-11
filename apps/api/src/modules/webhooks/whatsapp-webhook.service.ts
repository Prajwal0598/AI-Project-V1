import { Injectable, Logger } from "@nestjs/common";
import { ActivityEventType, Channel, ConversationStatus, MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { QueueService } from "../../queue/queue.service";
import { AiService } from "../ai/ai.service";
import { ShoppingFlowService } from "../shopping-flow/shopping-flow.service";
import { recalculateLeadScore } from "../../common/lead-score.helper";
import { parseWhatsAppWebhook, ParsedWhatsAppMessage } from "./whatsapp-parser";

// simple greetings/explicit menu requests trigger the deterministic shopping menu instead of the AI —
// anything else (natural language questions, search, etc.) still goes to the existing AI assistant
const GREETING_RE = /^\s*(hi+|hello+|hey+|helo+|start|menu|shop|shopping)\s*[!.?]*\s*$/i;

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly ai: AiService,
    private readonly shoppingFlow: ShoppingFlowService,
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

    // upsert by providerMessageId to deduplicate Meta re-deliveries, and detect whether this was actually new
    const existing = await this.prisma.message.findUnique({ where: { providerMessageId: msg.waMessageId } });
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
    if (existing) {
      this.logger.warn(`Ignoring re-delivered WhatsApp message ${msg.waMessageId} — already processed.`);
      return;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: msg.timestamp, status: ConversationStatus.OPEN },
    });

    await this.prisma.activityEvent.create({
      data: { businessId: business.id, customerId: customer.id, type: ActivityEventType.MESSAGE_SENT, summary: `${msg.displayName ?? msg.from}: "${msg.text.slice(0, 80)}"` },
    });

    await recalculateLeadScore(this.prisma, customer.id, business.id);

    // interactive button/list taps are always routed to the deterministic shopping flow, never the AI
    if (msg.interactiveId) {
      try {
        await this.shoppingFlow.handleInteractive(conversation.id, business.id, msg.interactiveId);
      } catch (err) {
        this.logger.error(`Shopping flow failed to handle interactive reply for conversation ${conversation.id}`, err);
      }
      return;
    }

    // any state where the customer has already engaged the shopping flow handles its own free text
    // (quantity/address entry, checkout nudges, or a product search) rather than falling through to the AI
    if (conversation.shoppingState !== "IDLE") {
      try {
        const handled = await this.shoppingFlow.handleFreeText(conversation.id, business.id, conversation, msg.text);
        if (handled) return;
      } catch (err) {
        this.logger.error(`Shopping flow failed to handle free text for conversation ${conversation.id}`, err);
        return;
      }
    }

    // a plain greeting (or explicit "menu"/"shop") opens the deterministic menu instead of the AI catalogue dump
    if (conversation.shoppingState === "IDLE" && GREETING_RE.test(msg.text)) {
      try {
        await this.shoppingFlow.sendMainMenu(conversation.id, business.id);
      } catch (err) {
        this.logger.error(`Shopping flow failed to send the main menu for conversation ${conversation.id}`, err);
      }
      return;
    }

    // fully autonomous reply — no human approval step
    try {
      await this.ai.generateAndSendReply(conversation.id, business.id);
    } catch (err) {
      this.logger.error(`Automatic AI reply failed for conversation ${conversation.id}`, err);
    }
  }
}
