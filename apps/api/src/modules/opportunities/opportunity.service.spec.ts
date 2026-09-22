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
