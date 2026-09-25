import { AiService, buildOrderKey, stripHallucinatedLinks } from "./ai.service";
import type { PrismaService } from "../../database/prisma.service";
import type { OrderService } from "../orders/order.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { CartService } from "../cart/cart.service";
import type { CustomerSignalService } from "../customer-signals/customer-signal.service";
import type { OpportunityService } from "../opportunities/opportunity.service";
import type { AssistedBuyingService } from "../assisted-buying/assisted-buying.service";

describe("buildOrderKey", () => {
  it("builds a stable key from items, address, and payment method", () => {
    const key = buildOrderKey([{ productName: "Blue Shirt", quantity: 2 }], "123 Main St", "UPI");
    expect(key).toBe("blue shirtx2|123 main st|upi");
  });

  it("is order-independent for the items list (sorted)", () => {
    const a = buildOrderKey(
      [{ productName: "Shirt", quantity: 1 }, { productName: "Jeans", quantity: 2 }],
      "Addr", "COD",
    );
    const b = buildOrderKey(
      [{ productName: "Jeans", quantity: 2 }, { productName: "Shirt", quantity: 1 }],
      "Addr", "COD",
    );
    expect(a).toBe(b);
  });

  it("is case- and whitespace-insensitive for product names, address, and payment method", () => {
    const a = buildOrderKey([{ productName: "  Blue Shirt  ", quantity: 1 }], "  123 Main St  ", "  UPI  ");
    const b = buildOrderKey([{ productName: "blue shirt", quantity: 1 }], "123 main st", "upi");
    expect(a).toBe(b);
  });

  it("produces different keys for different quantities of the same product", () => {
    const a = buildOrderKey([{ productName: "Shirt", quantity: 1 }], "Addr", "COD");
    const b = buildOrderKey([{ productName: "Shirt", quantity: 2 }], "Addr", "COD");
    expect(a).not.toBe(b);
  });
});

describe("stripHallucinatedLinks", () => {
  it("removes a line containing a URL, keeping surrounding lines intact", () => {
    const reply = "Thanks for your order!\nTrack it here: https://example.com/track/123\nLet us know if you need anything.";
    const result = stripHallucinatedLinks(reply);
    expect(result).not.toContain("http");
    expect(result).toContain("Thanks for your order!");
    expect(result).toContain("Let us know if you need anything.");
  });

  it("leaves a reply with no URL untouched", () => {
    const reply = "Your order has been placed and will be delivered soon.";
    expect(stripHallucinatedLinks(reply)).toBe(reply);
  });

  it("collapses extra blank lines left behind after stripping", () => {
    const reply = "Line one.\nhttps://bad-link.com/pay\nLine two.";
    const result = stripHallucinatedLinks(reply);
    expect(result).not.toMatch(/\n{3,}/);
  });
});

describe("AiService — payment-claim guard", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock };
  let ai: AiService;

  const baseConversation = {
    id: "conv1", businessId: "biz1", customerId: "cust1", channel: "WHATSAPP", escalated: false,
    activeOrderId: "order1", customer: { firstName: "Alex", lastName: null },
    business: { name: "Test Biz", assistedBuyingEnabled: false, products: [] },
    messages: [{ direction: "INBOUND", content: "I have paid", sentAt: new Date(), metadata: null }],
  };

  beforeEach(() => {
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(baseConversation) },
      order: { findUnique: jest.fn() },
      aiActionLog: { create: jest.fn() },
    };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn() };
    ai = new AiService(
      prisma as unknown as PrismaService,
      {} as unknown as OrderService,
      conversations as unknown as ConversationService,
      {} as unknown as CartService,
      {} as unknown as CustomerSignalService,
      {} as unknown as OpportunityService,
      { handle: jest.fn() } as unknown as AssistedBuyingService,
    );
  });

  it("never confirms an unverified 'I have paid' claim — the order is still PENDING_PAYMENT", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order1", status: "PENDING_PAYMENT", currency: "INR", total: 899 });
    const result = await ai.generateAndSendReply("conv1", "biz1");
    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.any(String));
    const reply = conversations.sendMessage.mock.calls[0][2] as string;
    expect(reply).not.toContain("Payment successful");
    expect(reply.toLowerCase()).not.toContain("payment received");
    expect(reply.toLowerCase()).not.toContain("confirmed");
    expect(result.message).toBe(reply);
  });

  it("grounds a truthful confirmation in the REAL order status when it genuinely is PAID", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order1", status: "PAID", currency: "INR", total: 899 });
    await ai.generateAndSendReply("conv1", "biz1");
    const reply = conversations.sendMessage.mock.calls[0][2] as string;
    expect(reply).toContain("confirmed");
    expect(reply).toContain("899");
  });

  it("is a no-op for messages that aren't a payment claim (control case)", async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      ...baseConversation,
      messages: [{ direction: "INBOUND", content: "What's the status of my order?", sentAt: new Date(), metadata: null }],
    });
    // guard doesn't match -> falls through past it to the normal LLM turn, which throws without an API key configured;
    // what matters here is confirming the guard itself was correctly SKIPPED, not the unrelated LLM failure
    await expect(ai.generateAndSendReply("conv1", "biz1")).rejects.toThrow();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe("AiService — order-status guard", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock };
  let orders: { getRecentForCustomer: jest.Mock };
  let ai: AiService;

  const recentOrder = {
    id: "order1abcdef", status: "PENDING_PAYMENT", fulfillmentStatus: "NOT_STARTED", total: 899, currency: "INR",
    createdAt: new Date("2026-09-20"), items: [{ name: "Premium Cotton T-Shirt", quantity: 1 }],
  };

  const conversationFor = (messageText: string) => ({
    id: "conv1", businessId: "biz1", customerId: "cust1", channel: "WHATSAPP", escalated: false,
    activeOrderId: "order1abcdef", customer: { firstName: "Alex", lastName: null },
    business: { name: "Test Biz", assistedBuyingEnabled: false, products: [] },
    messages: [{ direction: "INBOUND", content: messageText, sentAt: new Date(), metadata: null }],
  });

  beforeEach(() => {
    orders = { getRecentForCustomer: jest.fn().mockResolvedValue([recentOrder]) };
    prisma = { conversation: { findFirst: jest.fn() }, aiActionLog: { create: jest.fn() } };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn() };
    ai = new AiService(
      prisma as unknown as PrismaService,
      orders as unknown as OrderService,
      conversations as unknown as ConversationService,
      {} as unknown as CartService,
      {} as unknown as CustomerSignalService,
      {} as unknown as OpportunityService,
      { handle: jest.fn() } as unknown as AssistedBuyingService,
    );
  });

  it.each([
    "Where is my order?",
    "What's my order status?",
    "When will my order arrive?",
    "Show me my recent orders",
  ])("'%s' is answered from the real order record, never an invented shipping estimate", async (messageText) => {
    prisma.conversation.findFirst.mockResolvedValue(conversationFor(messageText));
    const result = await ai.generateAndSendReply("conv1", "biz1");
    expect(orders.getRecentForCustomer).toHaveBeenCalledWith("cust1", "biz1", 5);
    const reply = conversations.sendMessage.mock.calls[0][2] as string;
    expect(reply).toContain("PENDING PAYMENT"); // the real status, not a made-up shipping ETA
    expect(reply).not.toMatch(/deliver(?:ed|y) (?:tomorrow|today|by|in \d)/i); // no invented delivery estimate
    expect(result.message).toBe(reply);
  });

  it("is honest when there are no orders on file yet", async () => {
    orders.getRecentForCustomer.mockResolvedValue([]);
    prisma.conversation.findFirst.mockResolvedValue(conversationFor("Where is my order?"));
    await ai.generateAndSendReply("conv1", "biz1");
    const reply = conversations.sendMessage.mock.calls[0][2] as string;
    expect(reply).toContain("don't see any orders");
  });

  it("is a no-op for unrelated messages (control case) — falls through past the guard", async () => {
    prisma.conversation.findFirst.mockResolvedValue(conversationFor("I'd like to buy another shirt"));
    // guard doesn't match -> falls through to the normal LLM turn (which itself also calls getRecentForCustomer
    // for prompt context, so that alone isn't a useful signal) -> throws without an API key configured; what
    // matters here is that the guard's OWN reply was never sent
    await expect(ai.generateAndSendReply("conv1", "biz1")).rejects.toThrow();
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });
});

describe("AiService — repeat purchase grounding", () => {
  it("instructs the model to resolve 'the same thing I bought last time' against real order history, and never invent a product", async () => {
    const pastOrder = {
      id: "o1", status: "PAID", fulfillmentStatus: "DELIVERED", total: 899, currency: "INR",
      createdAt: new Date("2026-09-01"), items: [{ name: "Premium Cotton T-Shirt", quantity: 1 }],
    };
    const orders = { getRecentForCustomer: jest.fn().mockResolvedValue([pastOrder]) };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue({
        id: "conv1", businessId: "biz1", customerId: "cust1", channel: "WHATSAPP", escalated: false,
        activeOrderId: null, customer: { firstName: "Alex", lastName: null },
        business: { name: "Test Biz", assistedBuyingEnabled: false, products: [{ id: "p1", name: "Premium Cotton T-Shirt", variants: [{ id: "v1", price: 899, currency: "INR", inventory: 10 }] }] },
        messages: [{ direction: "INBOUND", content: "I want to buy the same thing I bought last time", sentAt: new Date(), metadata: null }],
      }) },
      aiActionLog: { create: jest.fn() },
    };
    const conversations = { sendMessage: jest.fn(), sendButtons: jest.fn() };
    const ai = new AiService(
      prisma as unknown as PrismaService,
      orders as unknown as OrderService,
      conversations as unknown as ConversationService,
      {} as unknown as CartService,
      {} as unknown as CustomerSignalService,
      {} as unknown as OpportunityService,
      { handle: jest.fn() } as unknown as AssistedBuyingService,
    );

    let capturedInstructions = "";
    const create = jest.fn(async (args: { instructions: string }) => {
      capturedInstructions = args.instructions;
      return { output_text: JSON.stringify({
        reply: "Got it — reordering your Premium Cotton T-Shirt! What's your shipping address?",
        items: [{ productName: "Premium Cotton T-Shirt", quantity: 1 }],
        shippingAddress: null, paymentMethod: null, orderConfirmed: false, cancelOrder: false,
        needsHumanReview: false, needsHumanReviewReason: null, showProductImages: [],
      }) };
    });
    (ai as unknown as { client: unknown }).client = { responses: { create } };

    await ai.generateAndSendReply("conv1", "biz1");

    expect(capturedInstructions).toContain("REPEAT PURCHASE");
    expect(capturedInstructions).toContain("Never invent or guess a product");
    expect(capturedInstructions).toContain("REPLACES that item's quantity"); // "make it two this time" sets, not adds
    // the real past-order item name must actually be present in the prompt for the model to ground against
    expect(capturedInstructions).toContain("Premium Cotton T-Shirt");
    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Premium Cotton T-Shirt"));
  });
});
