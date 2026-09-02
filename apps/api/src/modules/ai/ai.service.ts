import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import type { Tool, ResponseInputItem } from "openai/resources/responses/responses";
import { MessageDirection } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { OrderService } from "../orders/order.service";

const CREATE_ORDER_TOOL: Tool = {
  type: "function",
  name: "create_order",
  description: "Places a real order immediately once the customer has stated which products and how many of each they want. Call this as soon as product names and quantities are both known — do not wait for further confirmation.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productName: { type: "string", description: "The exact product name as it appears in the product catalogue." },
            quantity: { type: "integer", description: "How many units of this product, always 1 or more." }
          },
          required: ["productName", "quantity"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  },
  strict: true
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  // client is initialised lazily so the API starts without OPENAI_API_KEY configured
  private client: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.client = new OpenAI({ apiKey });
    else this.logger.warn("OPENAI_API_KEY is not set — AI draft endpoint will be unavailable.");
  }

  private getClient(): OpenAI {
    if (!this.client) throw new ServiceUnavailableException("OPENAI_API_KEY is not configured on the API server.");
    return this.client;
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

    // exclude never-approved drafts so the model isn't confused by its own unsent past replies
    const sentMessages = conversation.messages.filter((m) => {
      const state = (m.metadata as { state?: string } | null)?.state;
      return (state ?? "").toLowerCase() !== "draft";
    });
    const transcript = sentMessages.map((message) => {
      const speaker = message.direction === MessageDirection.INBOUND ? "Customer" : "Business";
      return `${speaker}: ${message.content}`;
    }).join("\n");
    const catalog = conversation.business.products.length
      ? conversation.business.products.map((product) => `${product.name} — ${product.currency} ${product.price}${product.inventory === null ? "" : ` (stock: ${product.inventory})`}`).join("\n")
      : "No product catalogue is connected.";

    const instructions = `You are the sales and support copilot for ${conversation.business.name}.

ORDER PLACEMENT (highest priority): Scan the whole conversation for any point where the customer stated both which product(s) and how many of each they want — even if that was a few messages ago. The moment that information exists anywhere in the conversation, call the create_order tool immediately with those items. Do not ask for confirmation again, do not just describe the catalogue, and do not wait for the customer to repeat themselves. Match each product to the closest name in the catalogue below.
Example: if the conversation shows the customer wrote "2 t-shirts and 3 pants" and the catalogue has "Red T-shirt" and "Black Pant", call create_order with items [{"productName":"Red T-shirt","quantity":2},{"productName":"Black Pant","quantity":3}] right away.

If products or quantities are still missing or ambiguous, ask one short clarifying question instead.

Otherwise, write one helpful, concise reply. Use only the supplied business context and product catalogue; never invent pricing, stock, policies, delivery dates, discounts, or links. Do not request payment-card data, do not promise a payment or shipment, and respect any opt-out or request for a human. Do not mention that you are an AI. The response must be ready for a human to review and send.`;
    const input = `Customer: ${[conversation.customer.firstName, conversation.customer.lastName].filter(Boolean).join(" ") || "Unknown"}
Channel: ${conversation.channel}

Product catalogue:
${catalog}

Conversation:
${transcript || "No previous messages. Draft a concise greeting and ask how you can help."}`;

    let orderCreated: { id: string; total: string; currency: string } | null = null;

    const { content, responseId, responseModel } = await (async () => {
      try {
        const client = this.getClient();
        const model = process.env.OPENAI_MODEL ?? "gpt-4o";
        const first = await client.responses.create({
          model, instructions, input, tools: [CREATE_ORDER_TOOL], store: false
        });

        const toolCall = first.output.find((item) => item.type === "function_call");
        if (!toolCall) {
          this.logger.log(`No create_order tool call for conversation ${conversationId} — model replied with plain text.`);
          const raw = first.output_text?.trim();
          if (!raw) throw new ServiceUnavailableException("The AI service returned an empty reply.");
          return { content: raw, responseId: first.id, responseModel: first.model };
        }

        this.logger.log(`create_order tool called for conversation ${conversationId} with args: ${toolCall.arguments}`);
        // execute the tool call against real business logic, then ask the model for a final confirmation message
        const toolResult = await this.executeCreateOrder(conversation, toolCall.arguments);
        this.logger.log(`create_order tool result: ${JSON.stringify(toolResult)}`);
        if (toolResult.success) orderCreated = { id: toolResult.orderId!, total: toolResult.total!, currency: toolResult.currency! };

        const followUp = await client.responses.create({
          model,
          previous_response_id: first.id,
          input: [{ type: "function_call_output", call_id: toolCall.call_id, output: JSON.stringify(toolResult) } satisfies ResponseInputItem.FunctionCallOutput],
          tools: [CREATE_ORDER_TOOL],
          store: false
        });
        const raw = followUp.output_text?.trim();
        if (!raw) throw new ServiceUnavailableException("The AI service returned an empty reply.");
        return { content: raw, responseId: followUp.id, responseModel: followUp.model };
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
          metadata: { source: "openai", responseId, state: "draft", model: responseModel, ...(orderCreated ? { orderId: orderCreated.id } : {}) }
        }
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: draft.sentAt } });
      return draft;
    });
    return { draft: message, sent: false, orderCreated };
  }

  private async executeCreateOrder(
    conversation: { businessId: string; customerId: string; business: { products: { name: string; price: unknown; currency: string }[] } },
    argsJson: string
  ): Promise<{ success: boolean; error?: string; orderId?: string; total?: string; currency?: string; items?: string[]; unmatched?: string[] }> {
    let args: { items: { productName: string; quantity: number }[] };
    try {
      args = JSON.parse(argsJson);
    } catch {
      return { success: false, error: "Could not parse order items." };
    }
    if (!args.items?.length) return { success: false, error: "No items specified." };

    const catalogue = conversation.business.products;
    // strips trailing plural "s" so "T-shirts"/"pants" match catalogue singulars like "Red T-shirt"/"Black Pant"
    const normalize = (s: string) => s.trim().toLowerCase().replace(/s$/, "");
    const matched: { name: string; price: number; currency: string; quantity: number }[] = [];
    const unmatched: string[] = [];
    for (const item of args.items) {
      const target = normalize(item.productName);
      const product = catalogue.find((p) => normalize(p.name) === target)
        ?? catalogue.find((p) => normalize(p.name).includes(target) || target.includes(normalize(p.name)));
      if (product) matched.push({ name: product.name, price: Number(product.price), currency: product.currency, quantity: Math.max(1, item.quantity) });
      else unmatched.push(item.productName);
    }
    if (matched.length === 0) {
      return { success: false, error: `No matching products found in the catalogue for: ${args.items.map((i) => i.productName).join(", ")}`, unmatched };
    }

    const subtotal = matched.reduce((sum, i) => sum + i.price * i.quantity, 0);
    try {
      const order = await this.orders.create(conversation.businessId, {
        customerId: conversation.customerId,
        subtotal,
        shippingFee: 0,
        currency: matched[0].currency,
      });
      return {
        success: true,
        orderId: order.id,
        total: order.total.toString(),
        currency: order.currency,
        items: matched.map((i) => `${i.quantity}x ${i.name}`),
        ...(unmatched.length ? { unmatched } : {}),
      };
    } catch (error) {
      this.logger.error("Order creation from AI tool call failed", error instanceof Error ? error.stack : String(error));
      return { success: false, error: "Order could not be created due to a server error." };
    }
  }
}
