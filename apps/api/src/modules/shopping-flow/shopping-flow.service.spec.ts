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
    };
    conversations = { sendButtons: jest.fn(), sendList: jest.fn(), sendMessage: jest.fn(), sendImage: jest.fn() };
    cart = { getOrCreateActive: jest.fn(), addItem: jest.fn(), totals: jest.fn() };
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
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_CATEGORIES" } });
    });

    it("menu_shop with NO categories falls straight through to the product list (BROWSING_PRODUCTS)", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.category.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "Shirt", variants: [{ price: 799, currency: "INR", inventory: 5 }] }]);
      await flow.handleInteractive("conv1", "biz1", "menu_shop");
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null } });
    });

    it("cat_<id> shows that category's products and records activeCategoryId", async () => {
      prisma.conversation.findFirst.mockResolvedValue({ customerId: "cust1", escalated: false });
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "Jeans", variants: [{ price: 1999, currency: "INR", inventory: 3 }] }]);
      await flow.handleInteractive("conv1", "biz1", "cat_abc123");
      expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ categoryId: "abc123" }) }));
      expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: "abc123" } });
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
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "MAIN_MENU" } });

      // 2. "What do you sell?" -> store discovery, shows categories, never runs a literal product search
      prisma.category.findMany.mockResolvedValue(categories);
      let handled = await flow.handleFreeText("conv1", "biz1", { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1" }, "What do you sell?");
      expect(handled).toBe(true);
      expect(conversations.sendList).toHaveBeenCalledWith("conv1", "biz1", expect.stringContaining("Choose a category"), "Browse", [
        { rows: [{ id: "cat_cat1", title: "Fashion" }, { id: "cat_cat2", title: "Bags" }, { id: "cat_cat3", title: "Accessories" }] },
      ]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenLastCalledWith({ where: { id: "conv1" }, data: { shoppingState: "BROWSING_CATEGORIES" } });

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
});
