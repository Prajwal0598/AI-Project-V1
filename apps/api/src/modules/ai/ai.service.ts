import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import { MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured on the API server.");
    this.client = new OpenAI({ apiKey });
  }

  async createReplyDraft(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
        business: { include: { products: { where: { active: true }, take: 30, orderBy: { updatedAt: "desc" } } } }, // cap keeps AI prompt within safe token limits
        messages: { orderBy: { sentAt: "asc" }, take: 20 }
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found.");

    const transcript = conversation.messages.map((message) => {
      const speaker = message.direction === MessageDirection.INBOUND ? "Customer" : "Business";
      return `${speaker}: ${message.content}`;
    }).join("\n");
    const catalog = conversation.business.products.length
      ? conversation.business.products.map((product) => `${product.name} — ${product.currency} ${product.price}${product.inventory === null ? "" : ` (stock: ${product.inventory})`}`).join("\n")
      : "No product catalogue is connected.";

    const instructions = `You are the sales and support copilot for ${conversation.business.name}.
Write one helpful, concise reply draft for the current customer conversation. Use only the supplied business context and product catalogue; never invent pricing, stock, policies, delivery dates, discounts, or links. Ask a short clarifying question if information is missing. Do not request payment-card data, do not promise a payment or shipment, and respect any opt-out or request for a human. Do not mention that you are an AI. The response must be ready for a human to review and send.`;
    const input = `Customer: ${[conversation.customer.firstName, conversation.customer.lastName].filter(Boolean).join(" ") || "Unknown"}
Channel: ${conversation.channel}

Product catalogue:
${catalog}

Conversation:
${transcript || "No previous messages. Draft a concise greeting and ask how you can help."}`;

    const { content, responseId, responseModel } = await (async () => {
      try {
        const response = await this.client.responses.create({
          model: process.env.OPENAI_MODEL ?? "gpt-4o",
          instructions,
          input,
          store: false // prevents OpenAI from retaining conversation data on their infrastructure
        });
        const raw = response.output_text?.trim();
        if (!raw) throw new ServiceUnavailableException("The AI service returned an empty reply.");
        return { content: raw, responseId: response.id, responseModel: response.model };
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        this.logger.error("OpenAI request failed", error instanceof Error ? error.stack : String(error));
        throw new ServiceUnavailableException("The AI service could not create a reply draft. Check the server key, model access, and billing configuration.");
      }
    })();

    const message = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          content,
          metadata: { source: "openai", responseId, state: "DRAFT", model: responseModel }
        }
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: draft.sentAt } });
      return draft;
    });
    return { draft: message, sent: false };
  }
}
