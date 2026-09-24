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
      category: { findMany: jest.fn().mockResolvedValue([]) },
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

    it("PRODUCT_CARD_INTEGRITY: each card's name, price and image always belong to the same product, even across multiple results (regression)", async () => {
      const bag = { id: "p20", name: "Canvas Tote Bag", description: null, brand: null, imageUrl: "/uploads/products/bag.jpg", category: { name: "Bags" }, variants: [{ id: "v20", price: 899, currency: "INR", inventory: 2, attributes: null }] };
      const jeans = { id: "p21", name: "Slim Fit Jeans", description: null, brand: null, imageUrl: "/uploads/products/jeans.jpg", category: { name: "Apparel" }, variants: [{ id: "v21", price: 1999, currency: "INR", inventory: 6, attributes: null }] };
      prisma.product.findMany.mockResolvedValue([bag, jeans]);

      await service.handle("conv1", "biz1", "cust1", "something under 2500");

      // one sendButtons call per product, each pairing its OWN name/price/image — never mixed across products
      const calls = conversations.sendButtons.mock.calls;
      const bagCall = calls.find((c: unknown[]) => (c[2] as string).includes("Canvas Tote Bag"));
      const jeansCall = calls.find((c: unknown[]) => (c[2] as string).includes("Slim Fit Jeans"));
      expect(bagCall[2]).toContain("899");
      expect(bagCall[4]).toContain("bag.jpg");
      expect(jeansCall[2]).toContain("1,999");
      expect(jeansCall[4]).toContain("jeans.jpg");
    });
  });

  describe("handle — keyword matching (the 'black bag' bug and its regression)", () => {
    it("'do you have a black bag' requires 'bag' to independently match too (AND across keywords) — never matches a black shirt", async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await service.handle("conv1", "biz1", "cust1", "do you have a black bag");

      const where = prisma.product.findMany.mock.calls[0][0].where;
      const andClauses = where.AND as { OR: unknown[] }[];
      // one AND-clause per keyword ("black", "bag") — a product missing either one entirely must be excluded
      const bagClause = andClauses.find((c) => JSON.stringify(c).includes('"bag"'));
      expect(bagClause).toEqual({ OR: [
        { name: { contains: "bag", mode: "insensitive" } },
        { description: { contains: "bag", mode: "insensitive" } },
        { brand: { contains: "bag", mode: "insensitive" } },
        { category: { name: { contains: "bag", mode: "insensitive" } } },
      ] });
      expect(prisma.category.findMany).not.toHaveBeenCalled(); // no DB category lookup involved in matching at all
    });

    it("never returns a product from a different category just because it shares an unrelated keyword", async () => {
      // simulates the exact bug: the shirt matches "black" but has no "bag" anywhere, so AND-across-keywords excludes it
      const bag = { id: "p10", name: "Black Crossbody Bag", description: null, brand: null, imageUrl: null, category: { name: "Bags" }, variants: [{ id: "v10", price: 999, currency: "INR", inventory: 4 }] };
      prisma.product.findMany.mockResolvedValue([bag]); // stands in for the real query correctly excluding the shirt

      const handled = await service.handle("conv1", "biz1", "cust1", "do you have a black bag");

      expect(handled).toBe(true);
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Black Crossbody Bag"), expect.any(Array), undefined);
    });

    it("'black shirts' still matches a product literally named 'Black Premium Shirt' regardless of its actual category assignment (regression — a hard category filter previously caused false negatives for mis-categorized products)", async () => {
      const blackShirt = { id: "p11", name: "Black Premium Shirt", description: null, brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v11", price: 1499, currency: "INR", inventory: 2 }] };
      prisma.product.findMany.mockResolvedValue([blackShirt]);

      const handled = await service.handle("conv1", "biz1", "cust1", "do you have any black shirts");

      expect(handled).toBe(true);
      const where = prisma.product.findMany.mock.calls[0][0].where;
      const andClauses = where.AND as { OR: { name?: { contains: string } }[] }[];
      const shirtClause = andClauses.find((c) => c.OR.some((o) => o.name?.contains === "shirt"));
      expect(shirtClause).toBeTruthy(); // "shirts" also tries its singular-normalized form against the literal product name
    });

    it("falls back to plain AND-across-keywords matching when no keyword names a known category", async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await service.handle("conv1", "biz1", "cust1", "red comfortable");

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.AND).toHaveLength(2); // one AND clause per keyword ("red", "comfortable")
    });
  });

  describe("handle — store discovery", () => {
    it("'What do you sell?' answers with the business's own categories instead of running a product search", async () => {
      prisma.category.findMany.mockResolvedValue([{ id: "cat1", name: "Fashion" }, { id: "cat2", name: "Bags" }]);

      const handled = await service.handle("conv1", "biz1", "cust1", "What do you sell?");

      expect(handled).toBe(true);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Fashion"));
      expect(prisma.aiActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ASSISTED_BUYING_STORE_DISCOVERY" }) }));
    });

    it("still answers with a sensible reply when the business has no categories yet", async () => {
      prisma.category.findMany.mockResolvedValue([]);

      const handled = await service.handle("conv1", "biz1", "cust1", "what products do you have?");

      expect(handled).toBe(true);
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.any(String));
    });
  });

  describe("handle — merchant controls", () => {
    it("excludes categories the merchant configured, passing them through to the catalogue query", async () => {
      prisma.business.findUnique.mockResolvedValue({ assistedBuyingMaxRecommendations: 5, assistedBuyingExcludedCategoryIds: ["cat-clearance"], assistedBuyingRankingPreference: "BEST_MATCH" });
      prisma.product.findMany.mockResolvedValue([shirt]);

      await service.handle("conv1", "biz1", "cust1", "shirt for a wedding under 2000");

      expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ AND: expect.arrayContaining([{ OR: [{ categoryId: null }, { categoryId: { notIn: ["cat-clearance"] } }] }]) }),
      }));
    });

    it("ranks by cheapest first when the ranking preference is VALUE", async () => {
      const cheap = { ...shirt, id: "p3", name: "Basic Tee", variants: [{ id: "v9", price: 499, currency: "INR", inventory: 5 }] };
      prisma.business.findUnique.mockResolvedValue({ assistedBuyingMaxRecommendations: 5, assistedBuyingExcludedCategoryIds: [], assistedBuyingRankingPreference: "VALUE" });
      prisma.product.findMany.mockResolvedValue([shirt, cheap]);

      await service.handle("conv1", "biz1", "cust1", "shirt under 5000");

      // cheapest (Basic Tee, 499) should be sent first regardless of keyword relevance
      expect(conversations.sendButtons.mock.calls[0][2]).toContain("Basic Tee");
    });

    it("ranks by priciest first when the ranking preference is PREMIUM", async () => {
      const cheap = { ...shirt, id: "p3", name: "Basic Tee", variants: [{ id: "v9", price: 499, currency: "INR", inventory: 5 }] };
      prisma.business.findUnique.mockResolvedValue({ assistedBuyingMaxRecommendations: 5, assistedBuyingExcludedCategoryIds: [], assistedBuyingRankingPreference: "PREMIUM" });
      prisma.product.findMany.mockResolvedValue([cheap, shirt]);

      await service.handle("conv1", "biz1", "cust1", "shirt under 5000");

      expect(conversations.sendButtons.mock.calls[0][2]).toContain("Navy Linen Shirt"); // pricier (1799) shown first
    });

    it("ranks by most recently added first when the ranking preference is NEWEST", async () => {
      const older = { ...shirt, id: "p3", name: "Old Stock Shirt", createdAt: new Date("2025-01-01") };
      const newer = { ...shirt, id: "p4", name: "New Arrival Shirt", createdAt: new Date("2026-01-01") };
      prisma.business.findUnique.mockResolvedValue({ assistedBuyingMaxRecommendations: 5, assistedBuyingExcludedCategoryIds: [], assistedBuyingRankingPreference: "NEWEST" });
      prisma.product.findMany.mockResolvedValue([older, newer]);

      await service.handle("conv1", "biz1", "cust1", "shirt under 5000");

      expect(conversations.sendButtons.mock.calls[0][2]).toContain("New Arrival Shirt");
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
