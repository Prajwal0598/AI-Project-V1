import { AssistedBuyingService } from "./assisted-buying.service";
import type { PrismaService } from "../../database/prisma.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { CartService } from "../cart/cart.service";

describe("AssistedBuyingService", () => {
  let prisma: any;
  let conversations: { sendMessage: jest.Mock; sendButtons: jest.Mock };
  let cart: { getOrCreateActive: jest.Mock; addItem: jest.Mock; totals: jest.Mock };
  let service: AssistedBuyingService;

  const shirt = {
    id: "p1", name: "Navy Linen Shirt", description: "Slim fit formal shirt", brand: null, imageUrl: "/uploads/products/shirt.jpg",
    category: { name: "Shirts" },
    variants: [{ id: "v1", price: 1799, currency: "INR", inventory: 5, attributes: { size: "M" } }, { id: "v2", price: 1799, currency: "INR", inventory: 3, attributes: { size: "L" } }],
  };

  beforeEach(() => {
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ assistedBuyingContext: null }), update: jest.fn() },
      business: { findUnique: jest.fn().mockResolvedValue({ assistedBuyingMaxRecommendations: 5 }) },
      product: { findMany: jest.fn(), findFirst: jest.fn() },
      aiActionLog: { create: jest.fn() },
    };
    conversations = { sendMessage: jest.fn(), sendButtons: jest.fn() };
    cart = { getOrCreateActive: jest.fn(), addItem: jest.fn(), totals: jest.fn() };
    service = new AssistedBuyingService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationService,
      cart as unknown as CartService,
    );
  });

  describe("handle — recommending", () => {
    it("returns false (falls through to normal AI) when the text has no keywords or price bounds", async () => {
      const handled = await service.handle("conv1", "biz1", "cust1", "is there any");
      expect(handled).toBe(false);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it("returns false when nothing in the catalogue matches even after relaxing budget and keywords", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      const handled = await service.handle("conv1", "biz1", "cust1", "shirt for a wedding under 2000");
      expect(handled).toBe(false);
      expect(conversations.sendMessage).not.toHaveBeenCalled();
      expect(prisma.product.findMany).toHaveBeenCalledTimes(3); // exact, then budget-relaxed, then keyword-relaxed
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_NO_MATCH", result: "no_match" }) }));
    });

    it("relaxes the budget and offers the closest alternative when nothing fits the exact price", async () => {
      prisma.product.findMany
        .mockResolvedValueOnce([]) // exact: keywords + under 1000
        .mockResolvedValueOnce([shirt]); // relaxed: keywords only

      const handled = await service.handle("conv1", "biz1", "cust1", "red leather shoes under 1000");

      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("couldn't find an exact match"));
      expect(prisma.product.findMany).toHaveBeenCalledTimes(2);
    });

    it("sends recommendation cards and stores the recommendation set when candidates match", async () => {
      prisma.product.findMany.mockResolvedValue([shirt]);

      const handled = await service.handle("conv1", "biz1", "cust1", "shirt for a wedding under 2000");

      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("shirt"));
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Navy Linen Shirt"), [
        { id: "variant_v1", title: "🛒 Add to Cart" },
        { id: "suggestion_dismiss", title: "Maybe Later" },
      ], expect.stringContaining("/uploads/products/shirt.jpg"));
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { assistedBuyingContext: { recommendations: [{ productId: "p1", variantId: "v1", name: "Navy Linen Shirt" }], query: "shirt for a wedding under 2000" } },
      });
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_RECOMMENDATIONS_SHOWN", result: "shown" }) }));
    });
  });

  describe("handle — comparison", () => {
    const jeans = { id: "p2", name: "Slim Jeans", description: "Stretch denim", variants: [{ price: 1299, currency: "INR", inventory: 4 }] };

    beforeEach(() => {
      prisma.conversation.findFirst.mockResolvedValue({
        assistedBuyingContext: { recommendations: [{ productId: "p1", variantId: "v1", name: "Navy Linen Shirt" }, { productId: "p2", variantId: "v3", name: "Slim Jeans" }], query: "shirt" },
      });
    });

    it("compares two referenced-by-ordinal recommendations with a templated fallback (no OpenAI configured in tests)", async () => {
      prisma.product.findMany.mockResolvedValue([shirt, jeans]);

      const handled = await service.handle("conv1", "biz1", "cust1", "which is better, the first or second one?");

      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Navy Linen Shirt"));
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Slim Jeans"));
      expect(cart.addItem).not.toHaveBeenCalled(); // comparison intent takes priority over ordinal-as-cart-reference
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_COMPARISON_SHOWN", result: "shown" }) }));
    });

    it("compares by product name when no ordinal is used", async () => {
      prisma.product.findMany.mockResolvedValue([shirt, jeans]);
      const handled = await service.handle("conv1", "biz1", "cust1", "compare the Navy Linen Shirt and the Slim Jeans");
      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Navy Linen Shirt"));
    });

    it("does not treat a single ordinal reference as a comparison request", async () => {
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1" });
      cart.addItem.mockResolvedValue({ items: [] });
      cart.totals.mockReturnValue({ subtotal: 1799, currency: "INR" });
      prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Navy Linen Shirt", variants: shirt.variants });

      const handled = await service.handle("conv1", "biz1", "cust1", "add the first one");

      expect(handled).toBe(true);
      expect(cart.addItem).toHaveBeenCalled(); // falls through to reference resolution, not comparison
    });
  });

  describe("handle — reference resolution", () => {
    beforeEach(() => {
      prisma.conversation.findFirst.mockResolvedValue({
        assistedBuyingContext: { recommendations: [{ productId: "p1", variantId: "v1", name: "Navy Linen Shirt" }], query: "shirt" },
      });
    });

    it("resolves 'the first one' + a mentioned size to the matching variant and adds it to the cart", async () => {
      prisma.product.findFirst.mockResolvedValue(shirt);
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1" });
      cart.addItem.mockResolvedValue({ items: [] });
      cart.totals.mockReturnValue({ subtotal: 1799, currency: "INR" });

      const handled = await service.handle("conv1", "biz1", "cust1", "add the first one in size L");

      expect(handled).toBe(true);
      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v2", 1); // L variant, not the originally-recommended M
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Navy Linen Shirt"), [
        { id: "nav_viewcart", title: "View Cart" },
        { id: "cart_checkout", title: "Checkout" },
      ]);
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_ADDED_TO_CART", result: "added_to_cart" }) }));
    });

    it("falls back to the originally recommended variant when no size/color is mentioned", async () => {
      prisma.product.findFirst.mockResolvedValue(shirt);
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1" });
      cart.addItem.mockResolvedValue({ items: [] });
      cart.totals.mockReturnValue({ subtotal: 1799, currency: "INR" });

      await service.handle("conv1", "biz1", "cust1", "add the first one");

      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v1", 1);
    });

    it("reports out of stock instead of adding to cart when the resolved variant has none left", async () => {
      prisma.product.findFirst.mockResolvedValue({ ...shirt, variants: [{ ...shirt.variants[0], inventory: 0 }] });

      const handled = await service.handle("conv1", "biz1", "cust1", "add the first one");

      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("out of stock"));
      expect(cart.addItem).not.toHaveBeenCalled();
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_OUT_OF_STOCK", result: "out_of_stock" }) }));
    });

    it("does not treat unrelated free text as a reference and falls through to recommending instead", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      const handled = await service.handle("conv1", "biz1", "cust1", "what about something under 500");
      expect(handled).toBe(false);
      expect(cart.addItem).not.toHaveBeenCalled();
    });
  });
});
