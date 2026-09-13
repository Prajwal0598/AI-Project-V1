import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import { OpportunityType } from "@prisma/client";

const MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "The exact WhatsApp message to send the customer. Warm, short (2-3 sentences max), no hard-sell pressure, no invented facts beyond what's given." },
  },
  required: ["message"],
  additionalProperties: false,
};

interface SuggestionContext {
  type: OpportunityType;
  customerName: string;
  businessName: string;
  productName?: string;
  price?: string;
}

@Injectable()
export class SuggestionAiService {
  private readonly logger = new Logger(SuggestionAiService.name);
  private client: OpenAI | null = null;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.client = new OpenAI({ apiKey });
    else this.logger.warn("OPENAI_API_KEY is not set — proactive suggestion messages will fall back to a plain template.");
  }

  /** Drafts the customer-facing nudge for an Opportunity. Falls back to a plain template if OpenAI isn't configured. */
  async draftMessage(context: SuggestionContext): Promise<string> {
    if (!this.client) return this.fallbackMessage(context);

    const instructions = `You write one short, warm WhatsApp outreach message on behalf of a merchant's AI sales assistant for "${context.businessName}". Never invent product facts, discounts, or claims beyond what's given. Never sound pushy. End with a soft, easy next step.`;
    const input = this.buildPrompt(context);

    try {
      const response = await this.client.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-4o",
        instructions, input, store: false,
        text: { format: { type: "json_schema", name: "suggestion_message", schema: MESSAGE_SCHEMA, strict: true } },
      });
      const raw = response.output_text?.trim();
      if (!raw) return this.fallbackMessage(context);
      const parsed = JSON.parse(raw) as { message: string };
      return parsed.message.trim() || this.fallbackMessage(context);
    } catch (err) {
      this.logger.warn(`Falling back to templated message after OpenAI error: ${err instanceof Error ? err.message : err}`);
      return this.fallbackMessage(context);
    }
  }

  private buildPrompt(context: SuggestionContext): string {
    switch (context.type) {
      case "PRODUCT_ENQUIRY":
        return `Customer name: ${context.customerName}\nThey asked about: ${context.productName}${context.price ? ` (${context.price})` : ""}\nThey haven't purchased yet. Write a friendly follow-up checking if they're still interested and offering help.`;
      case "BACK_IN_STOCK":
        return `Customer name: ${context.customerName}\nThey previously showed interest in: ${context.productName}, which was out of stock.\nIt's back in stock now${context.price ? ` at ${context.price}` : ""}. Let them know.`;
      case "ABANDONED_CART":
      default:
        return `Customer name: ${context.customerName}\nThey have items waiting in their cart and haven't checked out. Write a gentle reminder.`;
    }
  }

  private fallbackMessage(context: SuggestionContext): string {
    switch (context.type) {
      case "PRODUCT_ENQUIRY":
        return `Hi ${context.customerName}! Just checking in — are you still interested in ${context.productName}? Happy to help if you have any questions.`;
      case "BACK_IN_STOCK":
        return `Hi ${context.customerName}! Good news — ${context.productName} is back in stock${context.price ? ` at ${context.price}` : ""}. Let us know if you'd like to grab one.`;
      case "ABANDONED_CART":
      default:
        return `Hi ${context.customerName}! You still have items waiting in your cart. Reply "cart" to pick up where you left off.`;
    }
  }
}
