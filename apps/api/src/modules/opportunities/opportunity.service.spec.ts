import { OpportunityService } from "./opportunity.service";
import type { PrismaService } from "../../database/prisma.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { SuggestionAiService } from "./suggestion-ai.service";
import type { AutomationRuleService } from "./automation-rule.service";

describe("OpportunityService.send", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock };
  let service: OpportunityService;

  beforeEach(() => {
    prisma = {
      opportunity: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      suggestion: { update: jest.fn() },
      opportunityOutcome: { upsert: jest.fn() },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: "conv1" }) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn() };
    service = new OpportunityService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationService,
      {} as unknown as SuggestionAiService,
      {} as unknown as AutomationRuleService,
    );
  });

  it("BACK_IN_STOCK with an active variant sends the product photo + Add to Cart/Maybe Later buttons instead of plain text", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "BACK_IN_STOCK",
      suggestion: { message: "It's back!", editedMessage: null },
      relatedProduct: { id: "p1", imageUrl: "/uploads/products/shoe.jpg", variants: [{ id: "v1" }] },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", "It's back!", [
      { id: "variant_v1", title: "🛒 Add to Cart" },
      { id: "bis_dismiss", title: "Maybe Later" },
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
      id: "opp1", customerId: "cust1", relatedCartId: null, status: "NEW", type: "PRODUCT_ENQUIRY",
      suggestion: { message: "Still interested?", editedMessage: null },
      relatedProduct: { id: "p1", imageUrl: "/uploads/products/shoe.jpg", variants: [{ id: "v1" }] },
    });
    prisma.opportunity.findUnique.mockResolvedValue({ id: "opp1" });

    await service.send("opp1", "biz1");

    expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", "Still interested?");
    expect(conversations.sendButtons).not.toHaveBeenCalled();
  });
});
