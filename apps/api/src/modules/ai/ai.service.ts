import { Injectable, Logger, NotFoundException, ServiceUnavailableException, BadRequestException } from "@nestjs/common";
import OpenAI from "openai";
import { MessageDirection, OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { OrderService } from "../orders/order.service";
import { OrderItemInputDto } from "../orders/dto/create-order.dto";
import { ConversationService } from "../conversations/conversation.service";
import { logAiAction } from "../../common/ai-action-log.helper";
import { toPublicImageUrl } from "../products/image-storage";

// an order can still be cancelled/amended by the customer up until it's marked paid
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT]);

// structured-output schema forces the model to always fill these fields rather than
// deciding whether to invoke a tool — models are far more reliable at schema-fill than tool-choice
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "The reply message to send the customer." },
    items: {
      type: "array",
      description: "Every product the customer wants to buy, carried forward from anywhere earlier in the conversation. Empty if nothing has been chosen yet.",
      items: {
        type: "object",
        properties: {
          productName: { type: "string", description: "The exact product name as it appears in the product catalogue." },
          quantity: { type: "integer", description: "How many units of this product, always 1 or more." }
        },
        required: ["productName", "quantity"],
        additionalProperties: false
      }
    },
    shippingAddress: { type: ["string", "null"], description: "The customer's shipping address, carried forward once they have given it. Null until then." },
    paymentMethod: { type: ["string", "null"], description: "Either \"UPI\" or \"COD\" once the customer has chosen, carried forward. Null until then." },
    orderConfirmed: { type: "boolean", description: "True only when the customer has given final explicit confirmation (e.g. \"yes\", \"confirm\", \"place the order\") after already being shown the full order summary (items, address, payment method, total)." },
    cancelOrder: { type: "boolean", description: "True only when the customer explicitly asks to cancel their existing order (e.g. \"cancel my order\", \"I don't want it anymore\"). Never true in the same turn as orderConfirmed." },
    needsHumanReview: { type: "boolean", description: "True when the request is ambiguous, conflicts with earlier information, involves a complaint/legal threat/suspicious payment claim, or anything else you are not confident handling autonomously. Never true in the same turn as orderConfirmed or cancelOrder." },
    needsHumanReviewReason: { type: ["string", "null"], description: "A short reason for needsHumanReview, or null if false." },
    showProductImages: {
      type: "array",
      description: "Exact catalogue product names (from the list below) to present to the customer this turn, each sent automatically as its own message (photo+name+price, or name+price as text if no photo) right after your reply. Use this to share the full catalogue (list every product name here) or to answer 'show me X' for specific products. Do not repeat these names/prices in your own reply text. Empty if nothing should be shown this turn.",
      items: { type: "string" }
    }
  },
  required: ["reply", "items", "shippingAddress", "paymentMethod", "orderConfirmed", "cancelOrder", "needsHumanReview", "needsHumanReviewReason", "showProductImages"],
  additionalProperties: false
};

// safety net for when the model copies a link pattern it saw earlier in the conversation history despite instructions not to
function stripHallucinatedLinks(reply: string): string {
  return reply.replace(/[^.!?\n]*https?:\/\/\S+[^.!?\n]*[.!?]?/gi, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// fingerprints an order's items+address+payment so a repeat/duplicate AI trigger (retried webhook, re-run,
// or an unrelated follow-up question that still reads as "confirmed" from the transcript) can't place it twice
function buildOrderKey(items: { productName: string; quantity: number }[], shippingAddress: string, paymentMethod: string): string {
  const itemsKey = [...items]
    .map((i) => `${i.productName.trim().toLowerCase()}x${i.quantity}`)
    .sort()
    .join(",");
  return `${itemsKey}|${shippingAddress.trim().toLowerCase()}|${paymentMethod.trim().toLowerCase()}`;
}

function formatOrderLine(order: { id: string; status: OrderStatus; fulfillmentStatus: string; total: unknown; currency: string; createdAt: Date; items: { name: string; quantity: number }[] }): string {
  const itemsText = order.items.length ? order.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") : "(items not recorded)";
  const shipping = order.status === "PAID" || order.status === "FULFILLED" ? ` — Shipment: ${order.fulfillmentStatus.replace(/_/g, " ")}` : "";
  return `- Order ref ${order.id.slice(-8)}: ${itemsText} — Total ${order.currency} ${order.total} — Status: ${order.status.replace(/_/g, " ")}${shipping} — placed ${order.createdAt.toISOString().slice(0, 10)}`;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  // client is initialised lazily so the API starts without OPENAI_API_KEY configured
  private client: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly conversations: ConversationService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.client = new OpenAI({ apiKey });
    else this.logger.warn("OPENAI_API_KEY is not set — AI draft endpoint will be unavailable.");
  }

  private getClient(): OpenAI {
    if (!this.client) throw new ServiceUnavailableException("OPENAI_API_KEY is not configured on the API server.");
    return this.client;
  }

  /** Generates a reply with the AI and sends it immediately via the conversation's channel — fully autonomous, no human approval step. */
  async generateAndSendReply(conversationId: string, businessId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, businessId },
      include: {
        customer: true,
        business: { include: { products: { where: { active: true }, take: 30, orderBy: { updatedAt: "desc" }, include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } } } }, // cap keeps AI prompt within safe token limits
        messages: { orderBy: { sentAt: "desc" }, take: 20 } // most recent 20; reversed below into chronological order
      }
    });
    if (!conversation) throw new NotFoundException("Conversation not found.");

    // once escalated, the AI stays silent so it can't talk over a human who's now expected to handle this conversation directly
    if (conversation.escalated) {
      await logAiAction(this.prisma, { businessId, customerId: conversation.customerId, conversationId, action: "REPLY_SKIPPED", result: "skipped", reason: "conversation is escalated to a human" });
      return { message: null, orderCreated: null };
    }

    // exclude never-approved drafts so the model isn't confused by its own unsent past replies
    const sentMessages = [...conversation.messages].reverse().filter((m) => {
      const state = (m.metadata as { state?: string } | null)?.state;
      return (state ?? "").toLowerCase() !== "draft";
    });
    const transcript = sentMessages.map((message) => {
      const speaker = message.direction === MessageDirection.INBOUND ? "Customer" : "Business";
      return `${speaker}: ${message.content}`;
    }).join("\n");
    const catalog = conversation.business.products.length
      ? conversation.business.products
          .filter((product) => product.variants[0])
          .map((product) => {
            const variant = product.variants[0];
            return `${product.name} — ${variant.currency} ${variant.price}${variant.inventory === null ? "" : ` (stock: ${variant.inventory})`}`;
          }).join("\n")
      : "No product catalogue is connected.";

    // grounds status/cancellation questions in real data instead of letting the model guess — it has no tool-calling access to this
    const recentOrders = await this.orders.getRecentForCustomer(conversation.customerId, conversation.businessId, 3);
    const ordersContext = recentOrders.length
      ? recentOrders.map(formatOrderLine).join("\n")
      : "No previous orders.";

    const instructions = `You are the autonomous sales copilot for ${conversation.business.name}. Follow this order-taking flow strictly, one step per turn — never skip or combine steps:

1. GREETING: if the customer just said hi/hey or the conversation is just starting, greet them warmly in one short sentence, then list every product name from the catalogue below in "showProductImages" so each is sent to the customer as its own card right after your reply. Do not list product names or prices in your own reply text.
2. ITEMS: once you know which products and quantities they want (from anywhere in the conversation), carry those forward in "items" every turn from now on.
3. ADDRESS: if items are known but no shipping address has been given yet, ask for their shipping address. Do not ask again once given — carry it forward in "shippingAddress".
4. PAYMENT METHOD: if items and address are known but no payment method chosen, ask "Would you like to pay via UPI or Pay on Delivery (COD)?". Carry the chosen method forward in "paymentMethod" exactly as "UPI" or "COD".
5. SUMMARY: once items, address, and payment method are all known and you have NOT yet shown a summary (check the conversation history — if your own most recent message already contains an order summary, do not repeat this step), present a clear summary: items with quantities, computed total using catalogue prices, shipping address, and payment method. Ask them to confirm ("Shall I go ahead and place this order?"). Do not set orderConfirmed true yet at this step.
6. CONFIRMATION: only after a summary has already been shown to the customer AND they now clearly confirm (e.g. "yes", "confirm", "place it"), set orderConfirmed to true, keeping items/shippingAddress/paymentMethod as already established.
   - If payment method is COD: tell them their order is placed and will be delivered, payment collected on delivery.
   - If payment method is UPI: a payment link is sent automatically in a separate follow-up message right after yours. Tell them to complete the payment using that link and that their order will be confirmed once payment is received — do NOT say the order is already placed. Never write a URL, link, or the phrase "payment link" in your own reply, even if earlier messages in the conversation contain one.
7. ORDER STATUS: if the customer asks about an existing order (status, tracking, "where is my order"), answer using the "Recent orders" data below — never invent a status. Do not set orderConfirmed for a status question.
8. AMENDING AN ORDER: if the customer wants to add/change items and the "Recent orders" data shows a recent order that is still PENDING PAYMENT, treat this as updating that same order — repeat the SUMMARY/CONFIRMATION steps with the full combined item list (old + new items).
9. CANCELLATION: if the customer clearly asks to cancel their order, set cancelOrder to true and leave orderConfirmed false. Only do this if the "Recent orders" data shows an order that is still PENDING PAYMENT (not already shipped/cancelled) — otherwise tell them it can no longer be cancelled.
10. ESCALATION: if the request is ambiguous, conflicts with earlier information, is a complaint or legal threat, involves a suspicious or unverifiable payment claim, or is anything else you are not confident handling on your own, set needsHumanReview to true with a short needsHumanReviewReason, and leave orderConfirmed/cancelOrder false. A team member will take over from here — your reply for this turn should just briefly acknowledge you're looping someone in.
11. PRODUCT CARDS: whenever you want to present one or more products to the customer — sharing the full catalogue (step 1) or answering "show me X"/"what do you have in Y" — list the exact catalogue name(s) in "showProductImages". Each is sent automatically as its own message (photo+name+price, or name+price as text if no photo) right after your reply, so never repeat those names or prices yourself in the "reply" text. Never list a product that isn't in the catalogue below.

Never invent pricing, stock, policies, discounts, or links — use only the catalogue below. Never include a URL or the word "http" in your reply under any circumstance. Do not request payment-card numbers. Do not mention that you are an AI.

Product catalogue:
${catalog}

Recent orders for this customer:
${ordersContext}`;
    const input = `Customer: ${[conversation.customer.firstName, conversation.customer.lastName].filter(Boolean).join(" ") || "Unknown"}
Channel: ${conversation.channel}

Conversation:
${transcript || "No previous messages. Greet the customer and share the product catalogue."}`;

    let orderCreated: { id: string; total: string; currency: string } | null = null;
    let paymentLink: string | null = null;
    let imagesToSend: string[] = [];

    const content = await (async () => {
      try {
        const client = this.getClient();
        const model = process.env.OPENAI_MODEL ?? "gpt-4o";
        const response = await client.responses.create({
          model, instructions, input, store: false,
          text: { format: { type: "json_schema", name: "sales_reply", schema: REPLY_SCHEMA, strict: true } }
        });

        const raw = response.output_text?.trim();
        if (!raw) throw new ServiceUnavailableException("The AI service returned an empty reply.");
        const parsed = JSON.parse(raw) as {
          reply: string; items: { productName: string; quantity: number }[];
          shippingAddress: string | null; paymentMethod: string | null; orderConfirmed: boolean; cancelOrder: boolean;
          needsHumanReview: boolean; needsHumanReviewReason: string | null; showProductImages: string[];
        };
        imagesToSend = parsed.showProductImages ?? [];
        this.logger.log(`Structured reply for conversation ${conversationId}: orderConfirmed=${parsed.orderConfirmed} cancelOrder=${parsed.cancelOrder} needsHumanReview=${parsed.needsHumanReview} items=${JSON.stringify(parsed.items)} address=${parsed.shippingAddress ? "set" : "null"} payment=${parsed.paymentMethod}`);

        if (parsed.needsHumanReview) {
          await this.prisma.conversation.update({ where: { id: conversationId }, data: { escalated: true, escalationReason: parsed.needsHumanReviewReason, outcome: "ESCALATED" } });
          await logAiAction(this.prisma, { businessId, customerId: conversation.customerId, conversationId, action: "ESCALATED", result: "paused_for_human", reason: parsed.needsHumanReviewReason ?? undefined });
          return "Thanks for letting us know — I'm looping in a member of our team who will get back to you shortly.";
        }

        if (parsed.cancelOrder) {
          return await this.handleCancelOrder(conversation, conversationId);
        }

        if (!parsed.orderConfirmed || !parsed.items?.length || !parsed.shippingAddress || !parsed.paymentMethod) {
          return stripHallucinatedLinks(parsed.reply);
        }

        const orderKey = buildOrderKey(parsed.items, parsed.shippingAddress, parsed.paymentMethod);
        if (orderKey === conversation.lastOrderKey) {
          // this exact order was already placed — a retried webhook, a re-run, or an unrelated follow-up (e.g. a
          // status question) still reads as "confirmed" from the transcript, but nothing new is actually being ordered
          const active = conversation.activeOrderId
            ? await this.prisma.order.findUnique({ where: { id: conversation.activeOrderId } })
            : null;
          return active
            ? `Your order (${active.currency} ${active.total}) is currently ${active.status.replace(/_/g, " ").toLowerCase()}. Let me know if there's anything else I can help with!`
            : "You've already placed this order — no need to confirm again! Let me know if there's anything else I can help with.";
        }

        const result = await this.executeCreateOrder(conversation, conversationId, parsed.items, parsed.shippingAddress, parsed.paymentMethod);
        this.logger.log(`create_order result for conversation ${conversationId}: ${JSON.stringify(result)}`);
        if (result.success) {
          orderCreated = { id: result.orderId!, total: result.total!, currency: result.currency! };
          await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastOrderKey: orderKey, activeOrderId: result.orderId } });
          await logAiAction(this.prisma, { businessId, customerId: conversation.customerId, conversationId, orderId: result.orderId, action: result.isAmendment ? "ORDER_AMENDED" : "ORDER_CREATED", result: result.status === "AWAITING_APPROVAL" ? "awaiting_approval" : "success" });
          if (result.status === "AWAITING_APPROVAL") {
            // held for merchant approval — no payment link yet, and don't let the model claim it's placed/confirmed
            return `Thanks! Your order total is ${result.currency} ${result.total}, which needs a quick review from our team before we can proceed — we'll confirm shortly.`;
          }
          paymentLink = result.paymentLink ?? null;
          return stripHallucinatedLinks(parsed.reply);
        }
        // order creation failed (e.g. no matching product, out of stock) — fall back to a plain clarifying reply instead of a false confirmation
        return `We couldn't confirm that order — ${result.error ?? "please clarify which products you'd like."}`.trim();
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        this.logger.error("OpenAI request failed", error instanceof Error ? error.stack : String(error));
        throw new ServiceUnavailableException("The AI service could not create a reply draft. Check the server key, model access, and billing configuration.");
      }
    })();

    const message = await this.conversations.sendMessage(conversationId, conversation.businessId, content);

    // sent as a separate follow-up message after the order summary/confirmation, not bundled into it
    if (paymentLink) {
      await this.conversations.sendMessage(conversationId, conversation.businessId, `Complete your UPI payment here: ${paymentLink}\n\nYour order will be confirmed as soon as we receive your payment.`);
    }

    // present each flagged catalogue product as its own message — photo+name+price when a photo is on file,
    // otherwise name+price as plain text — instead of one big text block; capped to avoid spamming
    if (imagesToSend.length) {
      const normalize = (s: string) => s.trim().toLowerCase();
      const catalogueProducts = conversation.business.products.filter((p) => p.variants[0]);
      const toSend = imagesToSend
        .map((name) => catalogueProducts.find((p) => normalize(p.name) === normalize(name)))
        .filter((p): p is typeof catalogueProducts[number] => !!p)
        .slice(0, 20);
      for (const product of toSend) {
        const variant = product.variants[0];
        const caption = `${product.name}\n${variant.currency} ${variant.price}`;
        try {
          if (product.imageUrl) {
            await this.conversations.sendImage(conversationId, conversation.businessId, toPublicImageUrl(product.imageUrl), caption);
          } else {
            await this.conversations.sendMessage(conversationId, conversation.businessId, caption);
          }
        } catch (error) {
          this.logger.error(`Failed to send product card for "${product.name}"`, error instanceof Error ? error.stack : String(error));
        }
      }
    }

    return { message, orderCreated };
  }

  private async handleCancelOrder(conversation: { businessId: string; customerId: string; activeOrderId: string | null }, conversationId: string): Promise<string> {
    if (!conversation.activeOrderId) {
      return "I don't see an active order for you to cancel.";
    }
    try {
      const cancelled = await this.orders.updateStatus(conversation.activeOrderId, conversation.businessId, { status: OrderStatus.CANCELLED });
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { activeOrderId: null } });
      await logAiAction(this.prisma, { businessId: conversation.businessId, customerId: conversation.customerId, conversationId, orderId: cancelled.id, action: "ORDER_CANCELLED", result: "success" });
      return `Your order (${cancelled.currency} ${cancelled.total}) has been cancelled. Let me know if there's anything else I can help with!`;
    } catch (error) {
      if (error instanceof BadRequestException) return error.message;
      this.logger.error("Order cancellation failed", error instanceof Error ? error.stack : String(error));
      return "I couldn't cancel that order due to a server error — please try again shortly.";
    }
  }

  /** Matches free-text item names against the business's catalogue, tolerating simple plural/singular differences. */
  private matchCatalogueItems(
    catalogue: { id: string; name: string; variants: { id: string; price: unknown; currency: string }[] }[],
    items: { productName: string; quantity: number }[]
  ): { matched: { productId: string; variantId: string; name: string; price: number; currency: string; quantity: number }[]; unmatched: string[] } {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/s$/, "");
    const matched: { productId: string; variantId: string; name: string; price: number; currency: string; quantity: number }[] = [];
    const unmatched: string[] = [];
    for (const item of items) {
      const target = normalize(item.productName);
      const product = catalogue.find((p) => normalize(p.name) === target)
        ?? catalogue.find((p) => normalize(p.name).includes(target) || target.includes(normalize(p.name)));
      const variant = product?.variants[0];
      if (product && variant) matched.push({ productId: product.id, variantId: variant.id, name: product.name, price: Number(variant.price), currency: variant.currency, quantity: Math.max(1, item.quantity) });
      else unmatched.push(item.productName);
    }
    return { matched, unmatched };
  }

  private async executeCreateOrder(
    conversation: { businessId: string; customerId: string; activeOrderId: string | null; business: { products: { id: string; name: string; variants: { id: string; price: unknown; currency: string }[] }[] } },
    conversationId: string,
    items: { productName: string; quantity: number }[],
    shippingAddress: string,
    paymentMethod: string
  ): Promise<{ success: boolean; error?: string; orderId?: string; total?: string; currency?: string; items?: string[]; unmatched?: string[]; paymentLink?: string; status?: string; isAmendment?: boolean }> {
    if (!items?.length) return { success: false, error: "No items specified." };

    const { matched, unmatched } = this.matchCatalogueItems(conversation.business.products, items);
    if (matched.length === 0) {
      return { success: false, error: `no matching products found in the catalogue for: ${items.map((i) => i.productName).join(", ")}`, unmatched };
    }

    // "UPI" or "COD" — anything else from the model falls back to COD (pay on delivery) as the safer default
    const normalizedPayment = /upi/i.test(paymentMethod) ? "UPI" : "COD";
    const orderItems: OrderItemInputDto[] = matched.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, quantity: i.quantity, unitPrice: i.price }));

    // if there's still an unpaid order open in this conversation, amend it in place instead of creating an overlapping second order
    const activeOrder = conversation.activeOrderId
      ? await this.prisma.order.findUnique({ where: { id: conversation.activeOrderId } })
      : null;
    const isAmendment = !!activeOrder && AMENDABLE_STATUSES.has(activeOrder.status);

    try {
      const order = isAmendment
        ? await this.orders.replaceItems(activeOrder!.id, conversation.businessId, orderItems, { address: shippingAddress })
        : await this.orders.create(conversation.businessId, {
            customerId: conversation.customerId,
            conversationId,
            subtotal: orderItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
            shippingFee: 0,
            currency: matched[0].currency,
            shippingAddress: { address: shippingAddress },
            paymentMethod: normalizedPayment,
            items: orderItems,
          });
      return {
        success: true,
        orderId: order.id,
        total: order.total.toString(),
        currency: order.currency,
        items: matched.map((i) => `${i.quantity}x ${i.name}`),
        status: order.status,
        isAmendment,
        // dummy payment link — simulates a payment gateway checkout page until a real one (e.g. Razorpay) is integrated;
        // withheld while the order is awaiting merchant approval
        ...(normalizedPayment === "UPI" && order.status !== "AWAITING_APPROVAL" ? { paymentLink: `https://pay.relay-dummy.app/checkout/${order.id}` } : {}),
        ...(unmatched.length ? { unmatched } : {}),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        return { success: false, error: error.message };
      }
      this.logger.error("Order creation from AI structured output failed", error instanceof Error ? error.stack : String(error));
      return { success: false, error: "Order could not be created due to a server error." };
    }
  }
}

