import { OpportunityService } from "./opportunity.service";
import type { PrismaService } from "../../database/prisma.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { SuggestionAiService } from "./suggestion-ai.service";
import type { AutomationRuleService } from "./automation-rule.service";

describe("OpportunityService.send", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock; sendImage: jest.Mock };
  let service: OpportunityService;

  beforeEach(() => {
    prisma = {
      opportunity: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      suggestion: { update: jest.fn() },
      opportunityOutcome: { upsert: jest.fn() },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: "conv1" }) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn(), sendImage: jest.fn() };
    service = new OpportunityService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationService,
      {} as unknown as SuggestionAiService,
      {} as unknown as AutomationRuleService,
    );
  });

  it.each((["BACK_IN_STOCK", "CROSS_SELL", "UPSELL", "PRODUCT_ENQUIRY", "HIGH_PURCHASE_INTENT", "REPEAT_PURCHASE", "NEW_PRODUCT_MATCH"]) as const)("%s with an active variant sends the product photo + Add to Cart/Maybe Later buttons instead of plain text", async (type) => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type,
      suggestion: { message: "Check this out!", editedMessage: null },
      relatedProduct: { id: "p1", imageUrl: "/uploads/products/shoe.jpg", variants: [{ id: "v1" }] },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", "Check this out!", [
      { id: "variant_v1", title: "🛒 Add to Cart" },
      { id: "suggestion_dismiss", title: "Maybe Later" },
    ], expect.stringContaining("/uploads/products/shoe.jpg"));
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });

  it("BACK_IN_STOCK with no active variant falls back to plain text", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "BACK_IN_STOCK",
      suggestion: { message: "It's back!", editedMessage: null },
      relatedProduct: { id: "p1", imageUrl: null, variants: [] },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", "It's back!");
    expect(conversations.sendButtons).not.toHaveBeenCalled();
  });

  it("other opportunity types always send plain text, even with a relatedProduct", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "UNANSWERED_CONVERSATION",
      suggestion: { message: "Sorry for the delay!", editedMessage: null },
      relatedProduct: { id: "p1", imageUrl: "/uploads/products/shoe.jpg", variants: [{ id: "v1" }] },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", "Sorry for the delay!");
    expect(conversations.sendButtons).not.toHaveBeenCalled();
    expect(conversations.sendImage).not.toHaveBeenCalled();
  });

  it("PROMOTION with an image sends it as a photo + caption instead of plain text", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "PROMOTION",
      suggestion: { message: "50% off today only!", editedMessage: null },
      relatedProduct: null, relatedPromotion: { imageUrl: "/uploads/promotions/banner.jpg" },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendImage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("/uploads/promotions/banner.jpg"), "50% off today only!");
    expect(conversations.sendMessage).not.toHaveBeenCalled();
    expect(conversations.sendButtons).not.toHaveBeenCalled();
  });

  it("PROMOTION with no image falls back to plain text", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "PROMOTION",
      suggestion: { message: "50% off today only!", editedMessage: null },
      relatedProduct: null, relatedPromotion: null,
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", "50% off today only!");
    expect(conversations.sendImage).not.toHaveBeenCalled();
  });
});

describe("OpportunityService.create — active-conversation suppression", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock; sendImage: jest.Mock };
  let automationRules: { getFor: jest.Mock; countCreatedTodayForCustomer: jest.Mock; isWithinBusinessHours: jest.Mock };
  let service: OpportunityService;

  const baseInput = { businessId: "biz1", customerId: "cust1", type: "PRODUCT_ENQUIRY" as const, reason: "test", confidence: 0.9, message: "Hi!" };
  const sentOpportunity = { id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "PRODUCT_ENQUIRY", suggestion: { message: "Hi!", editedMessage: null }, relatedProduct: null };

  beforeEach(() => {
    prisma = {
      business: { findUnique: jest.fn().mockResolvedValue({ proactiveSuggestionsEnabled: true }) },
      customer: { findUnique: jest.fn().mockResolvedValue({ proactiveMessagingOptOut: false, leadScore: null }) },
      opportunity: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "opp1" }), findUnique: jest.fn().mockResolvedValue({ id: "opp1", status: "SENT" }) },
      message: { findFirst: jest.fn() },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: "conv1" }) },
      suggestion: { update: jest.fn() },
      aiActionLog: { create: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn(), sendImage: jest.fn() };
    automationRules = {
      getFor: jest.fn().mockResolvedValue({ enabled: true, autoSend: true, minConfidenceForAutoSend: 0, frequencyCapPerCustomerPerDay: null, personalizedTiming: false, businessHoursStart: null, businessHoursEnd: null }),
      countCreatedTodayForCustomer: jest.fn().mockResolvedValue(0),
      isWithinBusinessHours: jest.fn().mockReturnValue(true),
    };
    service = new OpportunityService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationService,
      {} as unknown as SuggestionAiService,
      automationRules as unknown as AutomationRuleService,
    );
  });

  it("auto-sends normally when the customer hasn't messaged recently (regression)", async () => {
    prisma.message.findFirst.mockResolvedValue({ direction: "INBOUND", sentAt: new Date(Date.now() - 60 * 60_000) }); // 1h ago
    prisma.opportunity.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(sentOpportunity);
    await service.create(baseInput);
    expect(conversations.sendMessage).toHaveBeenCalled();
  });

  it("defers auto-send (but still creates the opportunity for manual review) when the customer messaged very recently", async () => {
    prisma.message.findFirst.mockResolvedValue({ direction: "INBOUND", sentAt: new Date() }); // just now
    const result = await service.create(baseInput);
    expect(conversations.sendMessage).not.toHaveBeenCalled();
    expect(conversations.sendButtons).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "opp1" });
  });

  it("does NOT defer when the customer's most recent message was OUTBOUND (e.g. our own last reply, not theirs)", async () => {
    prisma.message.findFirst.mockResolvedValue({ direction: "OUTBOUND", sentAt: new Date() });
    prisma.opportunity.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(sentOpportunity);
    await service.create(baseInput);
    expect(conversations.sendMessage).toHaveBeenCalled();
  });
});
