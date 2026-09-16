import { WhatsAppWebhookService } from "./whatsapp-webhook.service";
import type { PrismaService } from "../../database/prisma.service";
import type { QueueService } from "../../queue/queue.service";
import type { AiService } from "../ai/ai.service";
import type { ShoppingFlowService } from "../shopping-flow/shopping-flow.service";
import type { ParsedWhatsAppMessage } from "./whatsapp-parser";

function baseMsg(overrides: Partial<ParsedWhatsAppMessage> = {}): ParsedWhatsAppMessage {
  return {
    phoneNumberId: "PHONE123", from: "911234567890", waMessageId: "wamid.1",
    text: "Hi", interactiveId: null, displayName: "Test Customer", timestamp: new Date(), ...overrides,
  };
}

describe("WhatsAppWebhookService — routing", () => {
  let prisma: any;
  let queues: { scheduleFollowUp: jest.Mock };
  let ai: { generateAndSendReply: jest.Mock };
  let shoppingFlow: { handleInteractive: jest.Mock; sendMainMenu: jest.Mock; handleFreeText: jest.Mock };
  let service: WhatsAppWebhookService;

  const business = { id: "biz1", whatsappPhoneNumberId: "PHONE123" };
  const customer = { id: "cust1" };
  const identity = { id: "ident1" };

  beforeEach(() => {
    prisma = {
      business: { findFirst: jest.fn().mockResolvedValue(business) },
      customer: { findFirst: jest.fn().mockResolvedValue(customer), create: jest.fn() },
      identity: { upsert: jest.fn().mockResolvedValue(identity) },
      conversation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      message: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      activityEvent: { create: jest.fn() },
      order: { count: jest.fn().mockResolvedValue(0) },
      leadScore: { upsert: jest.fn() },
    };
    queues = { scheduleFollowUp: jest.fn() };
    ai = { generateAndSendReply: jest.fn() };
    shoppingFlow = { handleInteractive: jest.fn(), sendMainMenu: jest.fn(), handleFreeText: jest.fn() };
    service = new WhatsAppWebhookService(
      prisma as unknown as PrismaService,
      queues as unknown as QueueService,
      ai as unknown as AiService,
      shoppingFlow as unknown as ShoppingFlowService,
    );
  });

  function mockConversation(overrides: Partial<{ id: string; shoppingState: string }> = {}) {
    const conv = { id: "conv1", shoppingState: "IDLE", ...overrides };
    prisma.conversation.findFirst.mockResolvedValue(conv);
    return conv;
  }

  it("ignores a message for an unmapped phone number id", async () => {
    prisma.business.findFirst.mockResolvedValue(null);
    await (service as any).processMessage(baseMsg());
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    expect(shoppingFlow.sendMainMenu).not.toHaveBeenCalled();
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });

  it("ignores a re-delivered message (duplicate providerMessageId)", async () => {
    mockConversation();
    prisma.message.findUnique.mockResolvedValue({ id: "existing-msg" });
    await (service as any).processMessage(baseMsg());
    expect(shoppingFlow.handleInteractive).not.toHaveBeenCalled();
    expect(shoppingFlow.sendMainMenu).not.toHaveBeenCalled();
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });

  it("always routes an interactive tap to the shopping flow, even while IDLE", async () => {
    mockConversation({ shoppingState: "IDLE" });
    await (service as any).processMessage(baseMsg({ interactiveId: "menu_shop", text: "🛍️ Shop" }));
    expect(shoppingFlow.handleInteractive).toHaveBeenCalledWith("conv1", "biz1", "menu_shop");
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });

  it("routes a plain greeting to the main menu regardless of current shopping state (regression: stuck-state bug)", async () => {
    mockConversation({ shoppingState: "BROWSING_PRODUCTS" }); // a non-IDLE, "stuck" state
    await (service as any).processMessage(baseMsg({ text: "hi" }));
    expect(shoppingFlow.sendMainMenu).toHaveBeenCalledWith("conv1", "biz1");
    expect(shoppingFlow.handleFreeText).not.toHaveBeenCalled();
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });

  it("matches greeting variants case-insensitively with punctuation", async () => {
    mockConversation();
    for (const text of ["Hi!", "HELLO", "menu", "Shop?", "  hey  "]) {
      jest.clearAllMocks();
      prisma.conversation.findFirst.mockResolvedValue({ id: "conv1", shoppingState: "IDLE" });
      prisma.message.findUnique.mockResolvedValue(null);
      await (service as any).processMessage(baseMsg({ text, waMessageId: `wamid-${text}` }));
      expect(shoppingFlow.sendMainMenu).toHaveBeenCalled();
    }
  });

  it("routes free text to the shopping flow when the conversation is mid-flow (non-IDLE, non-greeting)", async () => {
    mockConversation({ shoppingState: "AWAITING_QUANTITY" });
    shoppingFlow.handleFreeText.mockResolvedValue(true);
    await (service as any).processMessage(baseMsg({ text: "2" }));
    expect(shoppingFlow.handleFreeText).toHaveBeenCalledWith("conv1", "biz1", expect.objectContaining({ shoppingState: "AWAITING_QUANTITY" }), "2");
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });

  it("falls through to the AI when handleFreeText reports it didn't handle the text", async () => {
    mockConversation({ shoppingState: "CART_REVIEW" });
    shoppingFlow.handleFreeText.mockResolvedValue(false);
    await (service as any).processMessage(baseMsg({ text: "what else do you have that's blue?" }));
    expect(ai.generateAndSendReply).toHaveBeenCalledWith("conv1", "biz1");
  });

  it("falls through to the AI for plain, non-greeting text while IDLE", async () => {
    mockConversation({ shoppingState: "IDLE" });
    await (service as any).processMessage(baseMsg({ text: "what's your return policy?" }));
    expect(shoppingFlow.handleFreeText).not.toHaveBeenCalled();
    expect(ai.generateAndSendReply).toHaveBeenCalledWith("conv1", "biz1");
  });

  it("does not fall through to the AI if the shopping flow throws while handling free text", async () => {
    mockConversation({ shoppingState: "COLLECTING_ADDRESS" });
    shoppingFlow.handleFreeText.mockRejectedValue(new Error("boom"));
    await (service as any).processMessage(baseMsg({ text: "123 Main St" }));
    expect(ai.generateAndSendReply).not.toHaveBeenCalled();
  });
});
