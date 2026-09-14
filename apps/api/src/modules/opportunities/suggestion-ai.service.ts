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
  /** for CROSS_SELL/UPSELL: the product the customer just bought, which this suggestion is based on */
  basedOnProductName?: string;
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

    const instructions = `You write one short, warm WhatsApp outreach message on behalf of a merchant's AI sales assistant for "${context.businessName}". Never invent product facts, discounts, or claims beyond what's given. Never sound pushy. End with a soft, easy next step. Write only the message body — no signature, sign-off, or placeholder name like "[Your Name]".`;
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
      case "HIGH_PURCHASE_INTENT":
        return `Customer name: ${context.customerName}\nThey've asked about or viewed ${context.productName}${context.price ? ` (${context.price})` : ""} multiple times recently — strong signs they're close to buying but haven't yet. Write a helpful nudge offering to answer any remaining questions or help them complete the purchase.`;
      case "BACK_IN_STOCK":
        return `Customer name: ${context.customerName}\nThey previously showed interest in: ${context.productName}, which was out of stock.\nIt's back in stock now${context.price ? ` at ${context.price}` : ""}. Let them know.`;
      case "REPEAT_PURCHASE":
        return `Customer name: ${context.customerName}\nThey previously bought ${context.productName}${context.price ? ` (${context.price})` : ""} and it's likely time to reorder based on their past purchase pattern. Write a friendly reorder reminder.`;
      case "CROSS_SELL":
        return `Customer name: ${context.customerName}\nThey just bought ${context.basedOnProductName}. ${context.productName}${context.price ? ` (${context.price})` : ""} pairs well with it. Write a short, helpful recommendation — not pushy.`;
      case "UPSELL":
        return `Customer name: ${context.customerName}\nThey just bought ${context.basedOnProductName}. ${context.productName}${context.price ? ` (${context.price})` : ""} is a premium/better-fit alternative they might prefer next time. Write a short, helpful mention — not pushy, framed as a heads-up for next time, not undoing their current purchase.`;
      case "NEW_PRODUCT_MATCH":
        return `Customer name: ${context.customerName}\nA new product just arrived that matches something they've shown interest in before: ${context.productName}${context.price ? ` (${context.price})` : ""}. Write a short, friendly "just landed, thought you'd want to know" message.`;
      case "UNANSWERED_CONVERSATION":
        return `Customer name: ${context.customerName}\nTheir last message hasn't been answered yet and it's been a while. Write a brief, sincere apology for the delay and reassure them someone will help shortly.`;
      case "LOW_ENGAGEMENT":
        return `Customer name: ${context.customerName}\nThey were previously an active customer but haven't been in touch in a long while. Write a warm "we miss you" win-back message, inviting them back without sounding needy.`;
      case "HIGH_VALUE_CUSTOMER":
        return `Customer name: ${context.customerName}\nThey are one of this business's most valuable customers but haven't heard from the business proactively in a while. Write a short, genuine check-in/thank-you message — no sales pitch, just appreciation and an offer to help with anything.`;
      case "ABANDONED_CART":
      default:
        return `Customer name: ${context.customerName}\nThey have items waiting in their cart and haven't checked out. Write a gentle reminder.`;
    }
  }

  private fallbackMessage(context: SuggestionContext): string {
    switch (context.type) {
      case "PRODUCT_ENQUIRY":
        return `Hi ${context.customerName}! Just checking in — are you still interested in ${context.productName}? Happy to help if you have any questions.`;
      case "HIGH_PURCHASE_INTENT":
        return `Hi ${context.customerName}! Noticed you've been checking out ${context.productName} — happy to answer any questions if you're close to deciding!`;
      case "BACK_IN_STOCK":
        return `Hi ${context.customerName}! Good news — ${context.productName} is back in stock${context.price ? ` at ${context.price}` : ""}. Let us know if you'd like to grab one.`;
      case "REPEAT_PURCHASE":
        return `Hi ${context.customerName}! Just a heads-up — it might be time to reorder ${context.productName}${context.price ? ` (${context.price})` : ""}. Let us know if you'd like one.`;
      case "CROSS_SELL":
        return `Hi ${context.customerName}! Since you got ${context.basedOnProductName}, you might also like ${context.productName}${context.price ? ` (${context.price})` : ""} — it pairs really well.`;
      case "UPSELL":
        return `Hi ${context.customerName}! For next time — ${context.productName}${context.price ? ` (${context.price})` : ""} is a great step up from ${context.basedOnProductName}, if you're ever looking to upgrade.`;
      case "NEW_PRODUCT_MATCH":
        return `Hi ${context.customerName}! Thought you'd want to know — ${context.productName}${context.price ? ` (${context.price})` : ""} just landed, and it looked right up your alley.`;
      case "UNANSWERED_CONVERSATION":
        return `Hi ${context.customerName}, sorry for the delay in getting back to you! Someone from our team will follow up shortly.`;
      case "LOW_ENGAGEMENT":
        return `Hi ${context.customerName}! We haven't seen you in a while and wanted to check in — let us know if there's anything we can help with.`;
      case "HIGH_VALUE_CUSTOMER":
        return `Hi ${context.customerName}! Just wanted to say thanks for being one of our best customers — let us know if there's ever anything we can help with.`;
      case "ABANDONED_CART":
      default:
        return `Hi ${context.customerName}! You still have items waiting in your cart. Reply "cart" to pick up where you left off.`;
    }
  }
}
