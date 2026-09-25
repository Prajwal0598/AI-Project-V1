import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { parseSearchQuery, fmtMoney, formatVariantLabel, ShoppingFlowService } from "./shopping-flow.service";
import type { PrismaService } from "../../database/prisma.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { CartService } from "../cart/cart.service";
import type { OrderService } from "../orders/order.service";
import type { CustomerSignalService } from "../customer-signals/customer-signal.service";

describe("parseSearchQuery", () => {
  it("extracts a max price from 'under'", () => {
    expect(parseSearchQuery("black shoes under 2500")).toEqual({
      maxPrice: 2500,
      minPrice: undefined,
      keywords: ["black", "shoes"],
    });
  });

  it("extracts a max price from 'below' with a currency symbol", () => {
    expect(parseSearchQuery("jackets below ₹1000")).toEqual({
      maxPrice: 1000,
      minPrice: undefined,
      keywords: ["jackets"],
    });
  });

  it("extracts a min price from 'above'/'over'", () => {
    expect(parseSearchQuery("jackets above 1000")).toEqual({
      maxPrice: undefined,
      minPrice: 1000,
      keywords: ["jackets"],
    });
  });

  it("extracts both a min and max price", () => {
    const result = parseSearchQuery("shirts over 500 under 2000");
    expect(result.minPrice).toBe(500);
    expect(result.maxPrice).toBe(2000);
    expect(result.keywords).toEqual(["shirts"]);
  });

  it("strips stopwords from keywords", () => {
    expect(parseSearchQuery("do you have any blue jeans")).toEqual({
      maxPrice: undefined,
      minPrice: undefined,
      keywords: ["blue", "jeans"],
    });
  });

  it("returns no filters/keywords for an empty or stopword-only query", () => {
    expect(parseSearchQuery("show me")).toEqual({ maxPrice: undefined, minPrice: undefined, keywords: [] });
  });

  it("strips vague filler words ('something', 'anything', 'nice', 'good') so a budget-only ask isn't searched literally", () => {
    expect(parseSearchQuery("show me something under 1500")).toEqual({ maxPrice: 1500, minPrice: undefined, keywords: [] });
    expect(parseSearchQuery("anything good under 2000")).toEqual({ maxPrice: 2000, minPrice: undefined, keywords: [] });
    expect(parseSearchQuery("show me something nice")).toEqual({ maxPrice: undefined, minPrice: undefined, keywords: [] });
  });

  it("strips pure grammar words (prepositions, modal verbs, relative pronouns, conjunctions) from occasion-style questions", () => {
    expect(parseSearchQuery("I'm going on vacation. What would you recommend?").keywords).toEqual(["vacation"]);
    expect(parseSearchQuery("I want something classy but not too expensive.").keywords).toEqual(["classy", "expensive"]);
    expect(parseSearchQuery("I need a gift for someone who loves coffee.").keywords).toEqual(["gift", "coffee"]);
    expect(parseSearchQuery("I'm attending a wedding. Show me something suitable.").keywords).toEqual(["wedding"]);
  });

  it("is case-insensitive", () => {
    expect(parseSearchQuery("RED SHOES UNDER 3000").maxPrice).toBe(3000);
  });
});

describe("fmtMoney", () => {
  it("formats a plain number with thousands grouping", () => {
    expect(fmtMoney(1999, "INR")).toBe("INR 1,999");
  });

  it("formats a large number with Indian digit grouping", () => {
    expect(fmtMoney(123456, "INR")).toBe("INR 1,23,456");
  });

  it("formats a numeric string", () => {
    expect(fmtMoney("799", "INR")).toBe("INR 799");
  });

  it("formats a Decimal-like object (has toString)", () => {
    const decimalLike = { toString: () => "2299.00" };
    expect(fmtMoney(decimalLike, "INR")).toBe("INR 2,299");
  });
});

describe("formatVariantLabel", () => {
  it("returns null for null/non-object attributes", () => {
    expect(formatVariantLabel(null)).toBeNull();
    expect(formatVariantLabel("not an object")).toBeNull();
  });

  it("joins attribute values with a comma", () => {
    expect(formatVariantLabel({ size: "M", color: "Red" })).toBe("M, Red");
  });

  it("filters out empty/falsy attribute values", () => {
    expect(formatVariantLabel({ size: "M", color: "" })).toBe("M");
  });

  it("returns null when there are no truthy values", () => {
    expect(formatVariantLabel({})).toBeNull();
  });
});

describe("ShoppingFlowService — state machine", () => {
  let prisma: any;
  let conversations: { sendButtons: jest.Mock; sendList: jest.Mock; sendMessage: jest.Mock; sendImage: jest.Mock };
  let cart: Record<string, jest.Mock>;
  let orders: Record<string, jest.Mock>;
  let signals: { record: jest.Mock };
  let flow: ShoppingFlowService;

  beforeEach(() => {
    prisma = {
      business: { findUnique: jest.fn().mockResolvedValue({ id: "biz1", name: "Test Biz" }) },
      conversation: { findFirst: jest.fn(), update: jest.fn() },
      category: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      variant: { findFirst: jest.fn() },
      productRelation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    conversations = { sendButtons: jest.fn(), sendList: jest.fn(), sendMessage: jest.fn(), sendImage: jest.fn() };
    cart = { getOrCreateActive: jest.fn(), findActiveForConversation: jest.fn(), addItem: jest.fn(), updateItemQuantity: jest.fn(), totals: jest.fn() };
    orders = {};
    signals = { record: jest.fn() };
    flow = new ShoppingFlowService(
      prisma as unknown as PrismaService,
      conversations as unknown as ConversationService,
      cart as unknown as CartService,
      orders as unknown as OrderService,
      signals as unknown as CustomerSignalService,
    );
  });

  describe("handleInteractive dispatch", () => {
    it("is a no-op when the conversation doesn't exist", async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);
      await flow.handleInteractive("conv1", "biz1", "menu_shop");
      expect(prisma.category.findMany).not.toHaveBeenCalled();
    });

    it("is a no-op when the conversation is escalated to a human", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: true });
      await flow.handleInteractive("conv1", "biz1", "menu_shop");
      expect(prisma.category.findMany).not.toHaveBeenCalled();
    });

    it("menu_shop with categories available shows the category list (BROWSING_CATEGORIES)", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.category.findMany.mockResolvedValue([{ id: "cat1", name: "Jeans" }]);
      await flow.handleInteractive("conv1", "biz1", "menu_shop");
      expect(conversations.sendList).toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_CATEGORIES", assistedBuyingContext: Prisma.JsonNull } });
    });

    it("menu_shop with NO categories falls straight through to the product list (BROWSING_PRODUCTS)", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.category.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "Shirt", variants: [{ price: 799, currency: "INR", inventory: 5 }] }]);
      await flow.handleInteractive("conv1", "biz1", "menu_shop");
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null, assistedBuyingContext: Prisma.JsonNull } });
    });

    it("cat_<id> shows that category's products and records activeCategoryId", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "Jeans", variants: [{ price: 1999, currency: "INR", inventory: 3 }] }]);
      await flow.handleInteractive("conv1", "biz1", "cat_abc123");
      expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ categoryId: "abc123" }) }));
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: "abc123", assistedBuyingContext: Prisma.JsonNull } });
    });

    it("nav_continue ('Keep Shopping') always returns to the top-level catalog, ignoring any previously-active category (regression)", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false, activeCategoryId: "some-old-category" });
      prisma.category.findMany.mockResolvedValue([{ id: "cat1", name: "Jeans" }]);
      await flow.handleInteractive("conv1", "biz1", "nav_continue");
      // showShop() with no categoryId argument -> lists categories, never scoped to "some-old-category"
      expect(prisma.category.findMany).toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ categoryId: "some-old-category" }) }));
    });

    it("suggestion_dismiss ('Maybe Later' on a proactive product suggestion) just acknowledges, with no state change", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      await flow.handleInteractive("conv1", "biz1", "suggestion_dismiss");
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("No worries"));
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it("prod_<id> shows product detail and records a PRODUCT_VIEWED signal", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.product.findFirst.mockResolvedValue({
        id: "p1", name: "Shirt", description: null, imageUrl: null,
        variants: [{ id: "v1", price: 799, currency: "INR", inventory: 5 }],
      });
      await flow.handleInteractive("conv1", "biz1", "prod_p1");
      expect(signals.record).toHaveBeenCalledWith("biz1", "cust1", "PRODUCT_VIEWED", { productId: "p1" });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { shoppingState: "AWAITING_QUANTITY", activeProductId: "p1", pendingVariantId: "v1" },
      });
    });

    it("prod_<id> for an out-of-stock single-variant product goes to VIEWING_PRODUCT instead of AWAITING_QUANTITY", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.product.findFirst.mockResolvedValue({
        id: "p1", name: "Shirt", description: null, imageUrl: null,
        variants: [{ id: "v1", price: 799, currency: "INR", inventory: 0 }],
      });
      await flow.handleInteractive("conv1", "biz1", "prod_p1");
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { shoppingState: "VIEWING_PRODUCT", activeProductId: "p1", pendingVariantId: null },
      });
    });

    it("pay_card sets pendingPaymentMethod to CARD and moves to ORDER_CONFIRMATION", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.conversation.update.mockResolvedValue({ customerId: "cust1", pendingAddress: "123 Main St" });
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [] });
      cart.totals.mockReturnValue({ subtotal: 799, currency: "INR" });

      await flow.handleInteractive("conv1", "biz1", "pay_card");

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { pendingPaymentMethod: "CARD", shoppingState: "ORDER_CONFIRMATION" },
      });
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("💳 Payment: Card"));
    });
  });

  describe("handleFreeText dispatch", () => {
    it("AWAITING_QUANTITY routes to quantity handling and consumes the text", async () => {
      prisma.variant.findFirst.mockResolvedValue({ id: "v1", price: 799, currency: "INR", product: { name: "Shirt" } });
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1" });
      cart.addItem.mockResolvedValue({ items: [] });
      cart.totals.mockReturnValue({ subtotal: 1598, currency: "INR" });

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "AWAITING_QUANTITY", pendingVariantId: "v1", customerId: "cust1" }, "2");

      expect(handled).toBe(true);
      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v1", 2);
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "CART_REVIEW", pendingVariantId: null } });
    });

    it("adding a cross-sell/upsell suggestion's variant merges into the existing active cart rather than replacing it (regression)", async () => {
      // the conversation's cart already has an unrelated item from earlier — tapping "Add to Cart" on a
      // suggestion must land alongside it, not wipe it out, since getOrCreateActive reuses the same cart
      prisma.variant.findFirst.mockResolvedValue({ id: "v2", price: 499, currency: "INR", product: { name: "Socks" } });
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [{ variantId: "v1", quantity: 1 }] });
      cart.addItem.mockResolvedValue({ items: [{ variantId: "v1", quantity: 1 }, { variantId: "v2", quantity: 1 }] });
      cart.totals.mockReturnValue({ subtotal: 1298, currency: "INR" });

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "AWAITING_QUANTITY", pendingVariantId: "v2", customerId: "cust1" }, "1");

      expect(handled).toBe(true);
      expect(cart.getOrCreateActive).toHaveBeenCalledWith("conv1", "biz1", "cust1");
      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v2", 1);
      // total reflects both items, confirming the earlier item wasn't dropped
      expect(conversations.sendButtons).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.stringContaining("1,298"), expect.any(Array));
    });

    it("COLLECTING_ADDRESS routes to address handling and advances to COLLECTING_PAYMENT", async () => {
      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "COLLECTING_ADDRESS", pendingVariantId: null, customerId: "cust1" }, "123 Main Street, Springfield");
      expect(handled).toBe(true);
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { pendingAddress: "123 Main Street, Springfield", shoppingState: "COLLECTING_PAYMENT" },
      });
      // customer picks a payment method by tapping a button, never by typing it — offers exactly 3 (WhatsApp's max)
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", expect.any(String), [
        { id: "pay_card", title: "💳 Card" },
        { id: "pay_upi", title: "📱 UPI" },
        { id: "pay_cod", title: "💵 COD" },
      ]);
    });

    it("COLLECTING_ADDRESS re-prompts (doesn't advance) for a too-short address", async () => {
      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "COLLECTING_ADDRESS", pendingVariantId: null, customerId: "cust1" }, "short");
      expect(handled).toBe(true);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("complete shipping address"));
    });

    it("COLLECTING_PAYMENT accepts 'cancel' and reverts to CART_REVIEW", async () => {
      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "COLLECTING_PAYMENT", pendingVariantId: null, customerId: "cust1" }, "cancel");
      expect(handled).toBe(true);
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: "conv1" },
        data: { shoppingState: "CART_REVIEW", pendingAddress: null, pendingPaymentMethod: null },
      });
    });

    it("COLLECTING_PAYMENT re-prompts for anything other than 'cancel'", async () => {
      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "COLLECTING_PAYMENT", pendingVariantId: null, customerId: "cust1" }, "UPI please");
      expect(handled).toBe(true);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(conversations.sendMessage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("tap one of the buttons"));
    });

    it.each(["MAIN_MENU", "BROWSING_CATEGORIES", "BROWSING_PRODUCTS", "VIEWING_PRODUCT"])(
      "%s treats free text as a product search",
      async (state) => {
        prisma.product.findMany.mockResolvedValue([]);
        const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: state, pendingVariantId: null, customerId: "cust1" }, "blue jeans");
        expect(handled).toBe(true);
        expect(prisma.product.findMany).toHaveBeenCalled();
      },
    );

    it.each(["CART_REVIEW", "IDLE"])("%s is NOT consumed — falls through for the AI to handle", async (state) => {
      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: state, pendingVariantId: null, customerId: "cust1" }, "anything");
      expect(handled).toBe(false);
    });

    it("'do you have a black bag' never matches a black shirt (regression) — AND across keywords requires 'bag' to independently match too", async () => {
      prisma.product.findMany.mockResolvedValue([]); // the mocked DB call stands in for the real AND filter correctly excluding the shirt

      await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "do you have a black bag");

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        { OR: [
          { name: { contains: "black", mode: "insensitive" } },
          { description: { contains: "black", mode: "insensitive" } },
          { brand: { contains: "black", mode: "insensitive" } },
          { category: { name: { contains: "black", mode: "insensitive" } } },
        ] },
        { OR: [
          { name: { contains: "bag", mode: "insensitive" } },
          { description: { contains: "bag", mode: "insensitive" } },
          { brand: { contains: "bag", mode: "insensitive" } },
          { category: { name: { contains: "bag", mode: "insensitive" } } },
        ] },
      ]);
    });

    it("'do you have any black shirts' still matches a product literally named 'Black Premium Shirt' regardless of which category it's actually filed under (regression — a hard category filter previously caused false negatives for mis-categorized products)", async () => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "Black Premium Shirt", description: null, variants: [{ price: 1999, currency: "INR", inventory: 5 }] }]);

      await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "do you have any black shirts");

      // "shirts" (plural) still has to match via its singular-normalized variant against a name literally containing "Shirt"
      const where = prisma.product.findMany.mock.calls[0][0].where;
      const shirtClause = where.AND[1];
      expect(shirtClause.OR).toEqual(expect.arrayContaining([{ name: { contains: "shirt", mode: "insensitive" } }]));
      expect(prisma.category.findMany).not.toHaveBeenCalled(); // no DB category lookup involved in matching at all anymore
    });

    it("'What do you sell?' is recognized as store discovery and shows categories, never runs it as a literal product search", async () => {
      prisma.category.findMany.mockResolvedValue([{ id: "cat1", name: "Fashion" }, { id: "cat2", name: "Bags" }]);

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "What do you sell?");

      expect(handled).toBe(true);
      expect(conversations.sendList).toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it.each(["What products do you have?", "Show me your products", "What categories do you have?", "What can I buy?"])(
      "'%s' is also recognized as store discovery",
      async (text) => {
        prisma.category.findMany.mockResolvedValue([{ id: "cat1", name: "Fashion" }]);
        await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, text);
        expect(prisma.product.findMany).not.toHaveBeenCalled();
      },
    );
  });

  describe("full conversation replay — Hi / discovery / category search / black shirt / budget-only", () => {
    // representative catalogue for "Prajwal Studio": a black shirt filed under the generic "Fashion" category
    // (not a dedicated "Shirts" category) plus a couple of other items, exactly the shape that previously
    // caused the "no black shirts available" false negative
    const blackShirt = { id: "p1", name: "Black Premium Shirt", description: "Slim fit formal shirt", brand: null, imageUrl: "/uploads/products/shirt.jpg", category: { name: "Fashion" }, variants: [{ id: "v1", price: 1799, currency: "INR", inventory: 5 }] };
    const bag = { id: "p2", name: "Canvas Tote Bag", description: null, brand: null, imageUrl: "/uploads/products/bag.jpg", category: { name: "Bags" }, variants: [{ id: "v2", price: 899, currency: "INR", inventory: 2 }] };
    const categories = [{ id: "cat1", name: "Fashion" }, { id: "cat2", name: "Bags" }, { id: "cat3", name: "Accessories" }];

    it("replays the exact 7-message test conversation end to end", async () => {
      // 1. "Hi" -> always (re)opens the main menu, regardless of prior state
      await flow.sendMainMenu("conv1", "biz1");
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Welcome to"), expect.any(Array));
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "MAIN_MENU", assistedBuyingContext: Prisma.JsonNull } });

      // 2. "What do you sell?" -> store discovery, shows categories, never runs a literal product search
      prisma.category.findMany.mockResolvedValue(categories);
      let handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "What do you sell?");
      expect(handled).toBe(true);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Choose a category"), "Browse", [
        { rows: [{ id: "cat_cat1", title: "Fashion" }, { id: "cat_cat2", title: "Bags" }, { id: "cat_cat3", title: "Accessories" }] },
      ]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_CATEGORIES", assistedBuyingContext: Prisma.JsonNull } });

      // 3. "Show me your products" -> also store discovery (still just the catalogue entry point, not a search)
      conversations.sendList.mockClear();
      handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "BROWSING_CATEGORIES", pendingVariantId: null, customerId: "cust1" }, "Show me your products");
      expect(handled).toBe(true);
      expect(conversations.sendList).toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalled();

      // 4. "What fashion products do you have?" -> a real category-scoped search this time (not pure discovery);
      // extracts just "fashion" as the keyword (stopwords strip "what"/"products"/"do"/"you"/"have")
      prisma.product.findMany.mockResolvedValueOnce([blackShirt]);
      handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "BROWSING_CATEGORIES", pendingVariantId: null, customerId: "cust1" }, "What fashion products do you have?");
      expect(handled).toBe(true);
      let where = prisma.product.findMany.mock.calls.at(-1)![0].where;
      expect(where.AND).toEqual([{ OR: expect.arrayContaining([{ category: { name: { contains: "fashion", mode: "insensitive" } } }]) }]);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Found 1 matching product"), "View", expect.any(Array));

      // 5. "Show me shirts" -> matches the black shirt purely on its own name, regardless of category
      prisma.product.findMany.mockResolvedValueOnce([blackShirt]);
      handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null, customerId: "cust1" }, "Show me shirts");
      expect(handled).toBe(true);
      where = prisma.product.findMany.mock.calls.at(-1)![0].where;
      expect(where.AND[0].OR).toEqual(expect.arrayContaining([{ name: { contains: "shirt", mode: "insensitive" } }]));

      // 6. "Do you have any black shirts?" -> the reported bug: must still find the black shirt (AND requires
      // BOTH "black" and "shirt(s)" to independently match — the shirt's own name satisfies both)
      prisma.product.findMany.mockResolvedValueOnce([blackShirt]);
      handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null, customerId: "cust1" }, "Do you have any black shirts?");
      expect(handled).toBe(true);
      where = prisma.product.findMany.mock.calls.at(-1)![0].where;
      expect(where.AND).toHaveLength(2); // "black" AND "shirts" both independently required
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Found 1 matching product"), "View", [
        { rows: [{ id: "prod_p1", title: "Black Premium Shirt", description: expect.stringContaining("1,799") }] },
      ]);

      // 7. "Show me something under 1500" -> budget-only: "something" is stripped, only maxPrice applies,
      // so the affordable bag (899) is returned even though it has no keyword overlap at all
      prisma.product.findMany.mockResolvedValueOnce([bag, blackShirt]); // shirt (1799) is over budget, filtered out below
      handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null, customerId: "cust1" }, "Show me something under 1500");
      expect(handled).toBe(true);
      where = prisma.product.findMany.mock.calls.at(-1)![0].where;
      expect(where.AND).toBeUndefined(); // no keywords left at all once "something" is stripped
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Found 1 matching product"), "View", [
        { rows: [{ id: "prod_p2", title: "Canvas Tote Bag", description: expect.stringContaining("899") }] },
      ]);
    });
  });

  describe("Test 2 — occasion/vibe-based queries relax to a ranked partial match instead of a dead end", () => {
    const hoodie = { id: "p3", name: "Weekend Casual Hoodie", description: "Relaxed fit for lazy weekends", brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v3", price: 1299, currency: "INR", inventory: 4 }] };
    const yogaPants = { id: "p4", name: "Comfortable Yoga Pants", description: null, brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v4", price: 999, currency: "INR", inventory: 10 }] };
    const coffeeMug = { id: "p5", name: "Coffee Lover's Mug", description: null, brand: null, imageUrl: null, category: { name: "Gifts" }, variants: [{ id: "v5", price: 349, currency: "INR", inventory: 20 }] };
    const giftWrap = { id: "p6", name: "Premium Gift Wrap Kit", description: null, brand: null, imageUrl: null, category: { name: "Gifts" }, variants: [{ id: "v6", price: 199, currency: "INR", inventory: 15 }] };

    it("'I need something comfortable for a casual weekend' ranks partial matches by how many keywords they satisfy", async () => {
      prisma.product.findMany
        .mockResolvedValueOnce([]) // exact AND across "comfortable"+"casual"+"weekend" — nothing matches all three
        .mockResolvedValueOnce([yogaPants, hoodie]); // relaxed OR query, deliberately returned worst-match-first

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "I need something comfortable for a casual weekend");

      expect(handled).toBe(true);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(2);
      const relaxedWhere = prisma.product.findMany.mock.calls[1][0].where;
      expect(relaxedWhere.OR).toBeDefined();
      expect(relaxedWhere.AND).toBeUndefined();
      // the hoodie matches 2 of 3 keywords ("casual", "weekend") vs. the yoga pants' 1 ("comfortable") — reranked to come first
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Nothing matched exactly"), "View", [
        { rows: [
          { id: "prod_p3", title: "Weekend Casual Hoodie", description: expect.stringContaining("1,299") },
          { id: "prod_p4", title: "Comfortable Yoga Pants", description: expect.stringContaining("999") },
        ] },
      ]);
    });

    it("'I need a gift for someone who loves coffee' surfaces loosely-related options instead of nothing", async () => {
      prisma.product.findMany
        .mockResolvedValueOnce([]) // exact AND across "gift"+"coffee" — nothing is literally both
        .mockResolvedValueOnce([coffeeMug, giftWrap]);

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "I need a gift for someone who loves coffee.");

      expect(handled).toBe(true);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Nothing matched exactly"), "View", expect.any(Array));
      // both single-keyword matches still surfaced, not silently dropped
      const rows = conversations.sendList.mock.calls.at(-1)![4][0].rows;
      expect(rows.map((r: { title: string }) => r.title)).toEqual(expect.arrayContaining(["Coffee Lover's Mug", "Premium Gift Wrap Kit"]));
    });

    it("does NOT relax a single-keyword miss (e.g. an unstocked colour) — still correctly reports no match", async () => {
      prisma.product.findMany.mockResolvedValueOnce([]); // exact match on the single keyword "maroon" finds nothing

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "Do you have anything in maroon?");

      expect(handled).toBe(true);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(1); // no second (relaxed) query attempted
      expect(conversations.sendButtons).toHaveBeenCalledWith("conv1", "biz1", "😕 No products matched that search.", expect.any(Array));
    });

    it("'I need something nice for a party' still matches directly (single real keyword, no relaxation needed)", async () => {
      const dress = { id: "p7", name: "Black Party Dress", description: null, brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v7", price: 2499, currency: "INR", inventory: 3 }] };
      prisma.product.findMany.mockResolvedValueOnce([dress]);

      const handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "I need something nice for a party");

      expect(handled).toBe(true);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Found 1 matching product"), "View", expect.any(Array));
    });
  });

  describe("Test 4 — conversation memory across multiple refining turns", () => {
    const shirt1 = { id: "p1", name: "Casual Blue Denim Shirt", description: "Relaxed casual fit", brand: null, imageUrl: "/uploads/products/shirt1.jpg", category: { name: "Fashion" }, variants: [{ id: "v1", price: 1299, currency: "INR", inventory: 5 }] };
    const shirt2 = { id: "p2", name: "Blue Casual Linen Shirt", description: null, brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v2", price: 1450, currency: "INR", inventory: 3 }] };

    function lastContext() {
      return prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext;
    }

    it("'I need a shirt' -> 'Something casual' -> 'Preferably blue' -> 'Under 1500' -> 'Show me the first one' -> 'I'll take it'", async () => {
      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", assistedBuyingContext: null };

      // 1. "I need a shirt"
      prisma.product.findMany.mockResolvedValueOnce([shirt1, shirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "I need a shirt");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toEqual([{ OR: expect.arrayContaining([{ name: { contains: "shirt", mode: "insensitive" } }]) }]);
      conversation = { ...conversation, assistedBuyingContext: lastContext() };
      expect((conversation.assistedBuyingContext as { filters: { keywords: string[] } }).filters.keywords).toEqual(["shirt"]);

      // 2. "Something casual" -> merges onto "shirt" instead of starting a brand new, unrelated search
      prisma.product.findMany.mockResolvedValueOnce([shirt1, shirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Something casual");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toHaveLength(2); // "shirt" AND "casual"
      conversation = { ...conversation, assistedBuyingContext: lastContext() };
      expect((conversation.assistedBuyingContext as { filters: { keywords: string[] } }).filters.keywords).toEqual(["shirt", "casual"]);

      // 3. "Preferably blue" -> "preferably" is filler (stripped), "blue" merges onto the accumulated keywords too
      prisma.product.findMany.mockResolvedValueOnce([shirt1, shirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Preferably blue");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toHaveLength(3); // "shirt" AND "casual" AND "blue"
      conversation = { ...conversation, assistedBuyingContext: lastContext() };
      expect((conversation.assistedBuyingContext as { filters: { keywords: string[] } }).filters.keywords).toEqual(["shirt", "casual", "blue"]);

      // 4. "Under 1500" -> the price bound stacks ON TOP of the 3 accumulated keywords, not instead of them
      prisma.product.findMany.mockResolvedValueOnce([shirt1, shirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Under 1500");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toHaveLength(3); // this turn added no new keywords
      conversation = { ...conversation, assistedBuyingContext: lastContext() };
      const ctx = conversation.assistedBuyingContext as { filters: { keywords: string[]; maxPrice?: number }; lastResults: { productId: string; name: string }[] };
      expect(ctx.filters).toEqual({ keywords: ["shirt", "casual", "blue"], maxPrice: 1500, minPrice: undefined });
      expect(ctx.lastResults.map((r) => r.name)).toEqual(["Casual Blue Denim Shirt", "Blue Casual Linen Shirt"]);
      expect(conversations.sendList).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Found 2 matching products"), "View", [
        { rows: [
          { id: "prod_p1", title: "Casual Blue Denim Shirt", description: expect.stringContaining("1,299") },
          { id: "prod_p2", title: "Blue Casual Linen Shirt", description: expect.stringContaining("1,450") },
        ] },
      ]);

      // 5. "Show me the first one" -> resolves the ORDINAL against the just-shown list, never runs it as a keyword search
      prisma.product.findFirst.mockResolvedValueOnce({
        id: "p1", name: "Casual Blue Denim Shirt", description: "Relaxed casual fit", imageUrl: "/uploads/products/shirt1.jpg",
        variants: [{ id: "v1", price: 1299, currency: "INR", inventory: 5 }],
      });
      const handledFirst = await flow.handleFreeText("conv1", "biz1", conversation, "Show me the first one");
      expect(handledFirst).toBe(true);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(4); // no additional search query for this turn
      expect(prisma.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", businessId: "biz1", status: "PUBLISHED" } }));
      expect(conversations.sendImage).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("shirt1.jpg"), expect.stringContaining("Casual Blue Denim Shirt"));
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "AWAITING_QUANTITY", activeProductId: "p1", pendingVariantId: "v1" } });

      // 6. "I'll take it" -> a plain affirmative while AWAITING_QUANTITY means quantity 1, no number required
      prisma.variant.findFirst.mockResolvedValueOnce({ id: "v1", price: 1299, currency: "INR", inventory: 5, product: { name: "Casual Blue Denim Shirt" } });
      cart.getOrCreateActive.mockResolvedValueOnce({ id: "cart1" });
      cart.addItem.mockResolvedValueOnce({ items: [{ variantId: "v1", quantity: 1 }] });
      cart.totals.mockReturnValueOnce({ subtotal: 1299, currency: "INR" });
      const handledLast = await flow.handleFreeText("conv1", "biz1", { shoppingState: "AWAITING_QUANTITY", pendingVariantId: "v1", customerId: "cust1" }, "I'll take it");
      expect(handledLast).toBe(true);
      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v1", 1);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Added *1 × Casual Blue Denim Shirt*"), expect.any(Array));
    });
  });

  describe("Test 5 — product details, follow-ups, and recommendation-pick", () => {
    const tshirtFull = {
      id: "p1", name: "Premium Cotton T-Shirt", description: "Soft breathable cotton tee", imageUrl: "/uploads/products/tshirt.jpg", categoryId: "cat-fashion",
      variants: [
        { id: "v1", price: 899, currency: "INR", inventory: 10, attributes: { color: "White" } },
        { id: "v2", price: 899, currency: "INR", inventory: 5, attributes: { color: "Black" } },
      ],
    };

    it("'Tell me more about the Premium Cotton T-Shirt' -> 'How much is it?' -> 'Is it available?' -> 'What colours do you have?' -> 'Is there anything similar but cheaper?' -> 'Which one would you recommend?'", async () => {
      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "Tell me more about the Premium Cotton T-Shirt" -> resolved BY NAME, shows the product directly
      // (never run as a literal keyword search for "tell"/"more"/"about")
      prisma.product.findMany.mockResolvedValueOnce([{ id: "p1", name: "Premium Cotton T-Shirt", description: "Soft breathable cotton tee", brand: null, category: { name: "Fashion" } }]);
      prisma.product.findFirst.mockResolvedValue(tshirtFull); // reused for every "the product I'm looking at" lookup below
      await flow.handleFreeText("conv1", "biz1", conversation, "Tell me more about the Premium Cotton T-Shirt");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toEqual([{ OR: expect.arrayContaining([{ name: { contains: "premium", mode: "insensitive" } }]) }, { OR: expect.arrayContaining([{ name: { contains: "cotton", mode: "insensitive" } }]) }, { OR: expect.arrayContaining([{ name: { contains: "shirt", mode: "insensitive" } }]) }]);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", "Choose an option:", "Select", expect.any(Array)); // 2 variants -> variant picker
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "VIEWING_PRODUCT", activeProductId: "p1" } });
      conversation = { ...conversation, activeProductId: "p1" };

      // 2. "How much is it?" -> answers directly from the active product, no search at all
      const findManyCallsBefore = prisma.product.findMany.mock.calls.length;
      await flow.handleFreeText("conv1", "biz1", conversation, "How much is it?");
      expect(prisma.product.findMany.mock.calls.length).toBe(findManyCallsBefore); // no new search query
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Premium Cotton T-Shirt* is INR 899"));

      // 3. "Is it available?" -> same anchor, answers stock status
      await flow.handleFreeText("conv1", "biz1", conversation, "Is it available?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("currently in stock"));

      // 4. "What colours do you have?" -> lists variant attribute options instead of searching the catalogue for the literal word "colours"
      await flow.handleFreeText("conv1", "biz1", conversation, "What colours do you have?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("White, Black"));

      // 5. "Is there anything similar but cheaper?" -> same category, priced below the active product, excluding itself
      const cheaperAlt = { id: "p2", name: "Classic Cotton Tee", variants: [{ id: "v3", price: 599, currency: "INR" }] };
      prisma.product.findMany.mockResolvedValueOnce([cheaperAlt]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Is there anything similar but cheaper?");
      const alternativesWhere = prisma.product.findMany.mock.calls.at(-1)![0].where;
      expect(alternativesWhere).toEqual(expect.objectContaining({ categoryId: "cat-fashion", id: { not: "p1" } }));
      expect(conversations.sendList).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("similar option"), "View", [
        { rows: [{ id: "prod_p2", title: "Classic Cotton Tee", description: expect.stringContaining("599") }] },
      ]);
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 6. "Which one would you recommend?" -> picks from the just-shown alternatives, not a fresh search for "one",
      // and explains why (grounded in the actual category/price, not an invented reason)
      prisma.product.findFirst
        .mockResolvedValueOnce({ id: "p2", name: "Classic Cotton Tee", category: { name: "Fashion" }, variants: [{ id: "v3", price: 599, currency: "INR" }] }) // reasoning lookup
        .mockResolvedValueOnce({ id: "p2", name: "Classic Cotton Tee", description: null, imageUrl: "/uploads/products/tee.jpg", variants: [{ id: "v3", price: 599, currency: "INR", inventory: 8 }] }); // showProductDetail's own lookup
      const findManyCallsBeforeRecommend = prisma.product.findMany.mock.calls.length;
      await flow.handleFreeText("conv1", "biz1", conversation, "Which one would you recommend?");
      expect(prisma.product.findMany.mock.calls.length).toBe(findManyCallsBeforeRecommend); // no new search query
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Classic Cotton Tee"));
      expect(conversations.sendImage).toHaveBeenLastCalledWith("conv1", "biz1", expect.any(String), expect.stringContaining("Classic Cotton Tee"));
    });
  });

  describe("Test 6 — product comparison, grounded in catalogue facts only", () => {
    const tshirt1 = { id: "p1", name: "Premium Cotton T-Shirt", description: "Soft breathable cotton tee", brand: null, category: { name: "Fashion" }, variants: [{ id: "v1", price: 899, currency: "INR", inventory: 10 }] };
    const tshirt2 = { id: "p2", name: "Oversized Beige T-Shirt", description: "Relaxed oversized fit", brand: null, category: { name: "Fashion" }, variants: [{ id: "v2", price: 1099, currency: "INR", inventory: 6 }] };
    const watch1 = { id: "p3", name: "Rose Gold Watch", description: "Elegant rose gold finish", brand: null, category: { name: "Accessories" }, variants: [{ id: "v3", price: 4999, currency: "INR", inventory: 4 }] };
    const watch2 = { id: "p4", name: "Minimal Silver Watch", description: "Sleek minimalist design", brand: null, category: { name: "Accessories" }, variants: [{ id: "v4", price: 3499, currency: "INR", inventory: 7 }] };

    it("'What's the difference...T-Shirt?' -> 'Which is cheaper?' -> 'Which one is better for casual wear?' -> 'Compare...Watch.' -> 'Which watch would make a better gift?'", async () => {
      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "What's the difference between the Premium Cotton T-Shirt and Oversized Beige T-Shirt?" -> resolves
      // BOTH named products and sends only grounded facts (name/price/stock/description), never invented specs
      prisma.product.findMany.mockResolvedValueOnce([tshirt1]).mockResolvedValueOnce([tshirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "What's the difference between the Premium Cotton T-Shirt and Oversized Beige T-Shirt?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Premium Cotton T-Shirt"));
      expect(conversations.sendMessage.mock.calls.at(-1)![2]).toContain("Oversized Beige T-Shirt");
      expect(prisma.conversation.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ assistedBuyingContext: expect.objectContaining({ comparedProductIds: ["p1", "p2"] }) }),
      }));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 2. "Which is cheaper?" -> a real catalogue fact (price) -> confident, grounded answer
      prisma.product.findMany.mockResolvedValueOnce([tshirt1, tshirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Which is cheaper?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Premium Cotton T-Shirt* is cheaper"));

      // 3. "Which one is better for casual wear?" -> no catalogue signal exists for this — must NOT invent one
      prisma.product.findMany.mockResolvedValueOnce([tshirt1, tshirt2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Which one is better for casual wear?");
      const casualWearReply = conversations.sendMessage.mock.calls.at(-1)![2] as string;
      expect(casualWearReply).toContain("don't have enough detail");
      expect(casualWearReply).toContain("Premium Cotton T-Shirt");
      expect(casualWearReply).toContain("Oversized Beige T-Shirt");

      // 4. "Compare the Rose Gold Watch and Minimal Silver Watch." -> a FRESH comparison overwrites the old one
      prisma.product.findMany.mockResolvedValueOnce([watch1]).mockResolvedValueOnce([watch2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Compare the Rose Gold Watch and Minimal Silver Watch.");
      expect(prisma.conversation.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ assistedBuyingContext: expect.objectContaining({ comparedProductIds: ["p3", "p4"] }) }),
      }));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 5. "Which watch would make a better gift?" -> follows the NEW watch comparison, not the old t-shirts;
      // "gift-worthiness" has no catalogue signal either, so again restates facts rather than inventing one
      prisma.product.findMany.mockResolvedValueOnce([watch1, watch2]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Which watch would make a better gift?");
      const giftReply = conversations.sendMessage.mock.calls.at(-1)![2] as string;
      expect(giftReply).toContain("don't have enough detail");
      expect(giftReply).toContain("Rose Gold Watch");
      expect(giftReply).toContain("Minimal Silver Watch");
    });
  });

  describe("Test 7 — cart intelligence: free text must actually mutate the real cart", () => {
    const tshirtCandidate = { id: "p1", name: "Premium Cotton T-Shirt", description: null, brand: null, category: { name: "Fashion" }, variants: [{ id: "v1", price: 899, currency: "INR", inventory: 20 }] };
    const watchCandidate = { id: "p2", name: "Rose Gold Watch", description: null, brand: null, category: { name: "Accessories" }, variants: [{ id: "v2", price: 4999, currency: "INR", inventory: 10 }] };
    const tshirtLine = (quantity: number) => ({ variantId: "v1", quantity, variant: { price: 899, currency: "INR", product: { id: "p1", name: "Premium Cotton T-Shirt" } } });
    const watchLine = (quantity: number) => ({ variantId: "v2", quantity, variant: { price: 4999, currency: "INR", product: { id: "p2", name: "Rose Gold Watch" } } });

    it("'Add the Premium Cotton T-Shirt' -> 'Add two of them' -> 'make that three' -> 'Remove one' -> 'Add the Rose Gold Watch too' -> 'What's in my cart?' -> 'How much is everything?' -> 'Remove the watch' -> 'Show me my cart again'", async () => {
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [] }); // safe blanket default — only .id matters except where overridden below for showCart() calls
      cart.totals.mockImplementation((c: { items: { variant: { price: number; currency: string } }[] }) => ({
        subtotal: c.items.reduce((sum, i: any) => sum + i.variant.price * i.quantity, 0),
        currency: c.items[0]?.variant.currency ?? "INR",
      }));

      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "Add the Premium Cotton T-Shirt to my cart" -> resolves the NAMED product and actually adds it (qty 1)
      prisma.product.findMany.mockResolvedValueOnce([tshirtCandidate]);
      cart.addItem.mockResolvedValueOnce({ items: [tshirtLine(1)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Add the Premium Cotton T-Shirt to my cart");
      expect(cart.addItem).toHaveBeenCalledWith("cart1", "biz1", "v1", 1);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("now 1 in your cart"), expect.any(Array));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 2. "Add two of them" -> ADDITIVE: increments the same variant by 2 (1 -> 3), resolved via the pronoun, not a new search
      cart.addItem.mockResolvedValueOnce({ items: [tshirtLine(3)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Add two of them");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 2);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("now 3 in your cart"), expect.any(Array));

      // 3. "Actually make that three" -> an ABSOLUTE set to 3, via updateItemQuantity — NOT cart.addItem(3), which would wrongly result in 6
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [tshirtLine(3)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Actually make that three");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 3);
      expect(cart.addItem).toHaveBeenCalledTimes(2); // no additional (wrong) addItem call for this turn

      // 4. "Remove one" -> decrements the last-touched item's quantity by 1 (3 -> 2), via an absolute set, not cart.addItem(-1)
      cart.findActiveForConversation.mockResolvedValueOnce({ items: [tshirtLine(3)] });
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [tshirtLine(2)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Remove one");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 2);

      // 5. "Add the Rose Gold Watch too" -> a SECOND, different product added alongside the t-shirt
      prisma.product.findMany.mockResolvedValueOnce([watchCandidate]);
      cart.addItem.mockResolvedValueOnce({ items: [tshirtLine(2), watchLine(1)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Add the Rose Gold Watch too");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v2", 1);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Rose Gold Watch* — now 1 in your cart"), expect.any(Array));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 6. "What's in my cart?" -> the REAL current cart contents (both items), not a fabricated summary
      cart.getOrCreateActive.mockResolvedValueOnce({ id: "cart1", items: [tshirtLine(2), watchLine(1)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "What's in my cart?");
      const cartListing = conversations.sendMessage.mock.calls.at(-1)![2] as string;
      expect(cartListing).toContain("Premium Cotton T-Shirt");
      expect(cartListing).toContain("Rose Gold Watch");
      expect(cartListing).toContain("6,797"); // 899*2 + 4999*1

      // 7. "How much is everything?" -> the same real cart total, computed, not stated from memory
      cart.getOrCreateActive.mockResolvedValueOnce({ id: "cart1", items: [tshirtLine(2), watchLine(1)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "How much is everything?");
      expect(conversations.sendMessage.mock.calls.at(-1)![2]).toContain("6,797");

      // 8. "Remove the watch" -> drops that NAMED product entirely (quantity -> 0), not a decrement by 1
      cart.findActiveForConversation.mockResolvedValueOnce({ items: [tshirtLine(2), watchLine(1)] });
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [tshirtLine(2)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Remove the watch");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v2", 0);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Removed *Rose Gold Watch*"), expect.any(Array));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 9. "Show me my cart again" -> reflects the watch's removal — only the t-shirt remains
      cart.getOrCreateActive.mockResolvedValueOnce({ id: "cart1", items: [tshirtLine(2)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Show me my cart again");
      const finalListing = conversations.sendMessage.mock.calls.at(-1)![2] as string;
      expect(finalListing).toContain("Premium Cotton T-Shirt");
      expect(finalListing).not.toContain("Rose Gold Watch");
      expect(finalListing).toContain("1,798"); // 899*2 only
    });
  });

  describe("Test — quantity understanding: increment vs replacement", () => {
    const tshirtCandidate = { id: "p1", name: "Premium Cotton T-Shirt", description: null, brand: null, category: { name: "Fashion" }, variants: [{ id: "v1", price: 899, currency: "INR", inventory: 20 }] };
    const tshirtLine = (quantity: number) => ({ variantId: "v1", quantity, variant: { price: 899, currency: "INR", product: { id: "p1", name: "Premium Cotton T-Shirt" } } });

    it("'I want 2 X' -> 'Actually, make it 5' -> 'No, just 3' -> 'Add another one' — correctly distinguishes an explicit quantity, two absolute replacements, and an increment", async () => {
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [] });
      cart.totals.mockImplementation((c: { items: { variant: { price: number; currency: string } }[] }) => ({
        subtotal: c.items.reduce((sum, i: any) => sum + i.variant.price * i.quantity, 0),
        currency: c.items[0]?.variant.currency ?? "INR",
      }));

      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "I want 2 Premium Cotton T-Shirts" -> a NAMED product with an EXPLICIT quantity, actually added (not just searched)
      prisma.product.findMany.mockResolvedValueOnce([tshirtCandidate]);
      cart.addItem.mockResolvedValueOnce({ items: [tshirtLine(2)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "I want 2 Premium Cotton T-Shirts");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 2);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("now 2 in your cart"), expect.any(Array));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 2. "Actually, make it 5" -> an ABSOLUTE replacement to 5, via updateItemQuantity — NOT additive (2+5=7)
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [tshirtLine(5)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Actually, make it 5");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 5);
      expect(cart.addItem).toHaveBeenCalledTimes(1); // no incorrect additive call this turn

      // 3. "No, just 3" -> a DIFFERENT trigger phrase for the same absolute-replacement semantics (5 -> 3)
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [tshirtLine(3)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "No, just 3");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 3);

      // 4. "Add another one" -> back to ADDITIVE: +1 more (3 -> 4), not a third replacement
      cart.addItem.mockResolvedValueOnce({ items: [tshirtLine(4)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Add another one");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 1);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("now 4 in your cart"), expect.any(Array));
    });
  });

  describe("Test — inventory awareness: rejects/adjusts quantities against real stock", () => {
    const dressCandidate = { id: "p9", name: "Black Party Dress", description: null, brand: null, category: { name: "Fashion" }, variants: [{ id: "v9", price: 2999, currency: "INR", inventory: 8 }] };
    const dressLine = (quantity: number) => ({ variantId: "v9", quantity, variant: { price: 2999, currency: "INR", product: { id: "p9", name: "Black Party Dress" } } });

    it("'I want 20 X' (only 8 in stock) -> 'Okay, give me 5' -> 'Can I get 10 instead?' — over-requests are rejected, not silently capped or ignored, and the rejected product is still remembered", async () => {
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [] });
      cart.totals.mockImplementation((c: { items: { variant: { price: number; currency: string } }[] }) => ({
        subtotal: c.items.reduce((sum, i: any) => sum + i.variant.price * i.quantity, 0),
        currency: c.items[0]?.variant.currency ?? "INR",
      }));

      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "I want 20 Black Party Dresses" -> rejected (only 8 in stock), NOT silently added
      prisma.product.findMany.mockResolvedValueOnce([dressCandidate]);
      cart.addItem.mockRejectedValueOnce(new BadRequestException("Only 8 left in stock."));
      await flow.handleFreeText("conv1", "biz1", conversation, "I want 20 Black Party Dresses");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v9", 20);
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", "Only 8 left in stock.");
      expect(conversations.sendButtons).not.toHaveBeenCalled(); // no false "added to cart" confirmation
      // even a rejected attempt must still remember which product it was about, for the follow-up correction below
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 2. "Okay, give me 5" -> within stock, actually applied (5 <= 8)
      cart.updateItemQuantity.mockResolvedValueOnce({ items: [dressLine(5)] });
      await flow.handleFreeText("conv1", "biz1", conversation, "Okay, give me 5");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v9", 5);
      expect(conversations.sendButtons).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("now 5 in your cart"), expect.any(Array));
      conversation = { ...conversation, assistedBuyingContext: prisma.conversation.update.mock.calls.at(-1)![0].data.assistedBuyingContext };

      // 3. "Can I get 10 instead?" -> rejected again (still only 8 in stock), not silently adjusted to the cap
      cart.updateItemQuantity.mockRejectedValueOnce(new BadRequestException("Only 8 left in stock."));
      await flow.handleFreeText("conv1", "biz1", conversation, "Can I get 10 instead?");
      expect(cart.updateItemQuantity).toHaveBeenLastCalledWith("cart1", "biz1", "v9", 10);
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", "Only 8 left in stock.");
    });
  });

  describe("Test — recommendation engine: multi-turn gift search, top-N picks, and grounded reasoning", () => {
    const scarf = { id: "p1", name: "Silk Scarf", description: null, brand: null, imageUrl: null, category: { name: "Fashion" }, variants: [{ id: "v1", price: 999, currency: "INR", inventory: 12 }] };
    const necklace = { id: "p2", name: "Rose Gold Necklace", description: null, brand: null, imageUrl: null, category: { name: "Accessories" }, variants: [{ id: "v2", price: 1499, currency: "INR", inventory: 6 }] };
    const handbag = { id: "p3", name: "Leather Handbag", description: null, brand: null, imageUrl: null, category: { name: "Accessories" }, variants: [{ id: "v3", price: 2499, currency: "INR", inventory: 4 }] };
    const sunglasses = { id: "p4", name: "Sunglasses", description: null, brand: null, imageUrl: null, category: { name: "Accessories" }, variants: [{ id: "v4", price: 799, currency: "INR", inventory: 15 }] };

    it("'gift for my girlfriend under 3000' -> 'she likes fashion' -> 'she also likes accessories' -> 'top 3 options' -> 'which one would you personally recommend' — budget survives a generic-word miss, interests accumulate, and picks are explained", async () => {
      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "I need a gift for my girlfriend under 3000" -> exact AND on the sole real keyword "gift" finds
      // nothing (no product is literally tagged "gift"), but the budget must NOT be lost — falls back to a
      // plain budget-only browse instead of a dead end that wipes the ₹3000 constraint
      prisma.product.findMany.mockResolvedValueOnce([]); // exact AND on "gift"
      prisma.product.findMany.mockResolvedValueOnce([scarf, necklace, handbag, sunglasses]); // budget-only fallback
      await flow.handleFreeText("conv1", "biz1", conversation, "I need a gift for my girlfriend under 3000");
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.any(String), "View", [
        { rows: expect.arrayContaining([expect.objectContaining({ title: "Silk Scarf" }), expect.objectContaining({ title: "Rose Gold Necklace" })]) },
      ]);
      let update = prisma.conversation.update.mock.calls.at(-1)![0];
      expect(update.data.assistedBuyingContext.filters.maxPrice).toBe(3000); // budget survived the miss
      conversation = { ...conversation, ...update.data, assistedBuyingContext: update.data.assistedBuyingContext };

      // 2. "She likes fashion" -> "girlfriend"/"my"/"she"/"likes" are recipient/grammar filler, not attributes;
      // "fashion" merges onto the still-remembered ₹3000 budget from turn 1
      prisma.product.findMany.mockResolvedValueOnce([scarf]);
      await flow.handleFreeText("conv1", "biz1", conversation, "She likes fashion");
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where.AND).toEqual(
        expect.arrayContaining([{ OR: expect.arrayContaining([{ name: { contains: "fashion", mode: "insensitive" } }]) }]),
      );
      update = prisma.conversation.update.mock.calls.at(-1)![0];
      expect(update.data.assistedBuyingContext.filters.maxPrice).toBe(3000);
      conversation = { ...conversation, ...update.data, assistedBuyingContext: update.data.assistedBuyingContext };

      // 3. "She also likes accessories" -> accumulates onto fashion+gift+budget; exact AND across all fails,
      // relaxes to a ranked partial match rather than a dead end
      prisma.product.findMany.mockResolvedValueOnce([]); // exact AND(gift, fashion, accessories)
      prisma.product.findMany.mockResolvedValueOnce([scarf, necklace, handbag, sunglasses]); // relaxed OR
      await flow.handleFreeText("conv1", "biz1", conversation, "She also likes accessories");
      update = prisma.conversation.update.mock.calls.at(-1)![0];
      expect(update.data.assistedBuyingContext.filters.keywords).toEqual(expect.arrayContaining(["gift", "fashion", "accessories"]));
      conversation = { ...conversation, ...update.data, assistedBuyingContext: update.data.assistedBuyingContext };

      // 4. "Give me your top 3 options" -> the best 3 of what was just found, each with a reason grounded in
      // the real budget/category — not a fresh (meaningless) search for "give"/"top"/"options"
      const findManyCallsBeforeTopN = prisma.product.findMany.mock.calls.length;
      prisma.product.findMany.mockResolvedValueOnce([scarf, necklace, handbag]);
      await flow.handleFreeText("conv1", "biz1", conversation, "Give me your top 3 options");
      expect(prisma.product.findMany.mock.calls.length).toBe(findManyCallsBeforeTopN + 1); // one lookup for the 3 picks, not a fresh keyword search
      const topNMessage = conversations.sendMessage.mock.calls.at(-1)![2] as string;
      expect(topNMessage).toContain("Silk Scarf");
      expect(topNMessage).toContain("Rose Gold Necklace");
      expect(topNMessage).toContain("Leather Handbag");
      expect(topNMessage).toContain("budget"); // explains WHY, not just a bare list
      expect(topNMessage).toContain("Accessories");
      update = prisma.conversation.update.mock.calls.at(-1)![0];
      conversation = { ...conversation, assistedBuyingContext: update.data.assistedBuyingContext };

      // 5. "Which one would you personally recommend?" -> the inserted adverb ("personally") must not break
      // RECOMMEND_PICK_RE; picks from the top-3 just shown (not the full earlier list) and explains why
      prisma.product.findFirst.mockResolvedValueOnce(scarf); // reasoning lookup
      prisma.product.findFirst.mockResolvedValueOnce({ ...scarf, variants: [{ id: "v1", price: 999, currency: "INR", inventory: 12, attributes: null }] }); // showProductDetail lookup
      const findManyCallsBeforeRecommend = prisma.product.findMany.mock.calls.length;
      await flow.handleFreeText("conv1", "biz1", conversation, "Which one would you personally recommend?");
      expect(prisma.product.findMany.mock.calls.length).toBe(findManyCallsBeforeRecommend); // no fresh search
      // the reasoning message is sent BEFORE showProductDetail's own follow-up prompt, so it's the second-to-last sendMessage call
      const recommendMessage = conversations.sendMessage.mock.calls.at(-2)![2] as string;
      expect(recommendMessage).toContain("Silk Scarf");
      expect(recommendMessage).toContain("budget"); // grounded reasoning, not a silent pick
    });
  });

  describe("Test — cross-selling: ProductRelation-grounded 'what else goes with this'", () => {
    const coffeeBeans = { id: "p1", name: "Premium Coffee Beans", description: null, brand: null, imageUrl: null, category: { name: "Home & Kitchen" }, variants: [{ id: "v1", price: 499, currency: "INR", inventory: 30 }] };

    it("'I want to buy Premium Coffee Beans' actually adds it (not just a search), then 'What else would go well with this?' surfaces the merchant-configured companions", async () => {
      cart.getOrCreateActive.mockResolvedValue({ id: "cart1", items: [] });
      cart.totals.mockImplementation((c: { items: { variant: { price: number; currency: string } }[] }) => ({
        subtotal: c.items.reduce((sum, i: any) => sum + i.variant.price * i.quantity, 0),
        currency: c.items[0]?.variant.currency ?? "INR",
      }));

      let conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "I want to buy Premium Coffee Beans" -> a real add-to-cart (implicit qty 1), not a keyword search
      prisma.product.findMany.mockResolvedValueOnce([coffeeBeans]);
      cart.addItem.mockResolvedValueOnce({ items: [{ variantId: "v1", quantity: 1, variant: { price: 499, currency: "INR", product: { id: "p1", name: "Premium Coffee Beans" } } }] });
      await flow.handleFreeText("conv1", "biz1", conversation, "I want to buy Premium Coffee Beans");
      expect(cart.addItem).toHaveBeenLastCalledWith("cart1", "biz1", "v1", 1);
      const update = prisma.conversation.update.mock.calls.at(-1)![0];
      expect(update.data.activeProductId).toBe("p1"); // anchors the active product for the cross-sell follow-up below
      conversation = { ...conversation, ...update.data, assistedBuyingContext: update.data.assistedBuyingContext };

      // 2. "What else would go well with this?" -> the merchant-configured CROSS_SELL/UPSELL companions for the
      // active product, not a fresh (meaningless) search for "else"/"well"
      prisma.product.findFirst.mockResolvedValueOnce(coffeeBeans);
      prisma.productRelation.findMany.mockResolvedValueOnce([
        { relatedProduct: { id: "p2", name: "Ceramic Coffee Mug", status: "PUBLISHED", variants: [{ id: "v2", price: 299, currency: "INR" }] } },
        { relatedProduct: { id: "p3", name: "Cold Brew Coffee Kit", status: "PUBLISHED", variants: [{ id: "v3", price: 899, currency: "INR" }] } },
        { relatedProduct: { id: "p4", name: "Coffee Lover Gift Box", status: "PUBLISHED", variants: [{ id: "v4", price: 1299, currency: "INR" }] } },
      ]);
      await flow.handleFreeText("conv1", "biz1", conversation, "What else would go well with this?");
      expect(prisma.productRelation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { businessId: "biz1", productId: "p1" } }));
      expect(conversations.sendList).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("Premium Coffee Beans"), "View", [
        { rows: [
          { id: "prod_p2", title: "Ceramic Coffee Mug", description: "INR 299" },
          { id: "prod_p3", title: "Cold Brew Coffee Kit", description: "INR 899" },
          { id: "prod_p4", title: "Coffee Lover Gift Box", description: "INR 1,299" },
        ] },
      ]);
    });

    it("is honest when no relation is configured yet — never invents a pairing", async () => {
      const conversation = { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null, customerId: "cust1", activeProductId: "p1", assistedBuyingContext: null };
      prisma.product.findFirst.mockResolvedValueOnce(coffeeBeans);
      prisma.productRelation.findMany.mockResolvedValueOnce([]);
      await flow.handleFreeText("conv1", "biz1", conversation, "What else would go well with this?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("don't have specific pairing suggestions"));
      expect(conversations.sendList).not.toHaveBeenCalled();
    });
  });

  describe("Test — upselling: 'anything more premium' means an upgrade, not a random alternative", () => {
    const premiumBeans = { id: "p1", name: "Premium Coffee Beans", description: null, brand: null, imageUrl: null, categoryId: "cat-kitchen", category: { name: "Home & Kitchen" }, variants: [{ id: "v1", price: 499, currency: "INR", inventory: 30 }] };
    const baristaReserve = { id: "p2", name: "Barista Reserve Coffee Beans", description: null, brand: null, imageUrl: null, variants: [{ id: "v2", price: 1499, currency: "INR", inventory: 10 }] };

    it("'Show me coffee beans under 1000' -> 'Do you have anything more premium?' — resolves the upgrade against the just-found product, not a fresh/random search", async () => {
      const conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown } =
        { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

      // 1. "Show me coffee beans under 1000" -> ordinary search, finds the (only) match; the customer never
      // taps into it, so there's no activeProductId yet — just a remembered lastResults entry
      prisma.product.findMany.mockResolvedValueOnce([premiumBeans]);
      const handled = await flow.handleFreeText("conv1", "biz1", conversation, "Show me coffee beans under 1000");
      expect(handled).toBe(true);
      const update = prisma.conversation.update.mock.calls.at(-1)![0];
      expect(update.data.activeProductId).toBeUndefined(); // no product tapped yet
      expect(update.data.assistedBuyingContext.lastResults).toEqual([{ productId: "p1", variantId: "v1", name: "Premium Coffee Beans" }]);

      // 2. "Do you have anything more premium?" -> an UPSELL relative to the just-found coffee beans (resolved
      // via lastResults since no product was tapped), not a fresh keyword search for "anything"/"premium" and
      // not just any other coffee product — must be priced ABOVE the original, same category
      prisma.product.findFirst.mockResolvedValueOnce(premiumBeans);
      prisma.product.findMany.mockResolvedValueOnce([baristaReserve]);
      await flow.handleFreeText("conv1", "biz1", { ...conversation, ...update.data, assistedBuyingContext: update.data.assistedBuyingContext }, "Do you have anything more premium?");
      expect(prisma.product.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "p1", businessId: "biz1" } }));
      expect(prisma.product.findMany.mock.calls.at(-1)![0].where).toEqual(expect.objectContaining({
        categoryId: "cat-kitchen", id: { not: "p1" }, variants: { some: { active: true, price: { gt: 499 } } },
      }));
      expect(conversations.sendList).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("more premium"), "View", [
        { rows: [{ id: "prod_p2", title: "Barista Reserve Coffee Beans", description: "INR 1,499" }] },
      ]);
    });

    it("is honest when the current product is already the most premium in its category", async () => {
      const conversation = { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null, customerId: "cust1", activeProductId: "p1", assistedBuyingContext: null };
      prisma.product.findFirst.mockResolvedValueOnce(premiumBeans);
      prisma.product.findMany.mockResolvedValueOnce([]); // nothing priced higher in the same category
      await flow.handleFreeText("conv1", "biz1", conversation, "Anything higher end?");
      expect(conversations.sendMessage).toHaveBeenLastCalledWith("conv1", "biz1", expect.stringContaining("most premium option"));
      expect(conversations.sendList).not.toHaveBeenCalled();
    });
  });
});
