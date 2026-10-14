import { extractAmounts, parseSearchQuery } from "./search-utils";
import { nextContext, readShoppingContext, resolveOrdinalIndex, type ShoppingContext } from "./shopping-context";
import {
  INTERPRETATION_SCHEMA, interpretDeterministically, mergeInterpretations, validateModelInterpretation,
} from "./shopping-interpretation";
import { mergeTopic } from "./shopping-topic";
import {
  applyHardConstraints, buildReason, cheaperCeiling, offeredAttributes, rankProducts, selectDiverse, splitByAttributes, type RankProduct,
} from "./shopping-ranking";
import { ShoppingInterpreterService } from "./shopping-interpreter.service";
import type { AiModelRouterService } from "../ai/ai-model-router.service";

const ctx = (overrides: Partial<ShoppingContext> = {}): ShoppingContext => ({ filters: { keywords: [] }, lastResults: [], ...overrides });

describe("parseSearchQuery — budgets as customers actually write them", () => {
  it.each([
    ["a date night gift under ₹1,500", 1500],
    ["wedding outfit under ₹3,000", 3000],
    ["something under Rs. 2,999", 2999],
    ["anything below 1,50,000", 150000],
    ["gifts under 3k", 3000],
    ["under 2.5k", 2500],
    ["options up to ₹5,000", 5000],
    ["upto 800", 800],
    ["not more than 2000", 2000],
    ["my budget is 2,500", 2500],
    ["max 1800", 1800],
    ["at most ₹900", 900],
  ])("%s -> max %d (and no leftover number tokens searched as keywords)", (text, max) => {
    const parsed = parseSearchQuery(text);
    expect(parsed.maxPrice).toBe(max);
    expect(parsed.minPrice).toBeUndefined();
    expect(parsed.keywords.some((k) => /^\d+$/.test(k))).toBe(false);
  });

  it("reads 'not more than X' as a ceiling, never as a floor", () => {
    const parsed = parseSearchQuery("not more than 2000");
    expect(parsed.maxPrice).toBe(2000);
    expect(parsed.minPrice).toBeUndefined();
  });

  it("reads a floor and a ceiling together", () => {
    expect(parseSearchQuery("shirts at least 1,000 under 2,500")).toMatchObject({ minPrice: 1000, maxPrice: 2500, keywords: ["shirts"] });
  });

  it("does not turn a list of sizes into an amount", () => {
    expect(parseSearchQuery("heels sizes 5,6,7").maxPrice).toBeUndefined();
  });

  it("drops function words that were being AND-required as literal keywords", () => {
    expect(parseSearchQuery("black and white shirt with buttons").keywords).toEqual(["black", "white", "shirt", "buttons"]);
  });

  it("extractAmounts finds every amount a customer wrote (used to verify a model-provided budget)", () => {
    expect(extractAmounts("something under ₹1,500 or maybe 2k")).toEqual(expect.arrayContaining([1500, 2000]));
  });
});

describe("readShoppingContext / nextContext", () => {
  it("reads the legacy AssistedBuying shape as lastResults", () => {
    const read = readShoppingContext({ recommendations: [{ productId: "p1", variantId: "v1", name: "A" }], query: "shirt" });
    expect(read?.lastResults).toEqual([{ productId: "p1", variantId: "v1", name: "A" }]);
    expect(read?.filters.keywords).toEqual([]);
  });

  it("reads the original ShoppingFlow shape unchanged", () => {
    const read = readShoppingContext({ filters: { keywords: ["shirt"], maxPrice: 1500 }, gender: "men", color: "blue", lastResults: [{ productId: "p1", variantId: "v1", name: "A" }] });
    expect(read).toMatchObject({ gender: "men", color: "blue", filters: { keywords: ["shirt"], maxPrice: 1500 } });
  });

  it("returns null for nothing usable, and ignores malformed entries instead of throwing", () => {
    expect(readShoppingContext(null)).toBeNull();
    expect(readShoppingContext("nope")).toBeNull();
    expect(readShoppingContext({ lastResults: [{ junk: true }, null, 5] })?.lastResults).toEqual([]);
  });

  it("carries the topic and the last cart item forward when only lastResults changes", () => {
    const prev = ctx({ filters: { keywords: ["heels"], maxPrice: 2000 }, color: "black", occasion: "party", lastCartItem: { productId: "p9", variantId: "v9", name: "Tee" }, shownProductIds: ["p1"] });
    const next = nextContext(prev, { lastResults: [{ productId: "p2", variantId: "v2", name: "B" }] });
    expect(next).toMatchObject({ filters: { keywords: ["heels"], maxPrice: 2000 }, color: "black", occasion: "party", lastCartItem: { productId: "p9" } });
    expect(next.shownProductIds).toEqual(["p1", "p2"]);
  });

  it("lets a patch explicitly clear a slot", () => {
    expect(nextContext(ctx({ color: "red" }), { color: undefined }).color).toBeUndefined();
  });
});

describe("resolveOrdinalIndex", () => {
  it.each([
    ["show me the second one", 4, 1], ["the first", 4, 0], ["the 3rd option", 4, 2], ["I'll take the last one", 4, 3], ["number 2 please", 4, 1], ["option 1", 4, 0],
  ])("%s", (text, count, expected) => expect(resolveOrdinalIndex(text, count)).toBe(expected));

  it("returns null with no list, or an index beyond the list", () => {
    expect(resolveOrdinalIndex("the second one", 0)).toBeNull();
    expect(resolveOrdinalIndex("the fifth one", 2)).toBeNull();
  });
});

describe("interpretDeterministically", () => {
  const sareeSearch = ctx({ filters: { keywords: ["emerald", "saree"], maxPrice: 5000 }, lastResults: [{ productId: "p1", variantId: "v1", name: "Emerald Saree" }] });
  const heelsSearch = ctx({ filters: { keywords: ["strappy", "heels"] }, color: "black", lastResults: [{ productId: "p1", variantId: "v1", name: "Black Strappy Heels" }] });

  it("a first message is a new topic; budget and occasion are read as structured fields", () => {
    const i = interpretDeterministically("I need a date night gift under ₹1,500", null);
    expect(i.topicRelation).toBe("NEW_TOPIC");
    expect(i.occasion).toBe("date night");
    expect(i.budget).toEqual({ min: undefined, max: 1500 });
    expect(i.hardConstraints).toEqual(expect.arrayContaining(["budget", "availability"]));
    expect(i.coreTerms).toEqual([]); // occasion/vibe words only — no product type named
  });

  it("a bare budget after an occasion search is a refinement that keeps the topic", () => {
    const prior = ctx({ filters: { keywords: ["date", "night", "gift"] }, occasion: "date night" });
    const i = interpretDeterministically("under ₹1,500", prior);
    expect(i.topicRelation).toBe("REFINEMENT");
    const merged = mergeTopic(prior, i);
    expect(merged.filters).toEqual({ keywords: ["date", "night", "gift"], maxPrice: 1500, minPrice: undefined });
    expect(merged.occasion).toBe("date night");
  });

  it("'pearl earrings' after an emerald saree search starts a NEW topic and drops the saree's budget", () => {
    const i = interpretDeterministically("Do you have pearl earrings?", sareeSearch);
    expect(i.topicRelation).toBe("NEW_TOPIC");
    const merged = mergeTopic(sareeSearch, i);
    expect(merged.reset).toBe(true);
    expect(merged.filters.keywords).toEqual(["pearl", "earrings"]);
    expect(merged.filters.maxPrice).toBeUndefined();
  });

  it("a bare product phrase with no overlap is flagged as an ambiguous topic switch (so the caller can recover)", () => {
    const i = interpretDeterministically("pearl earrings", sareeSearch);
    expect(i.ambiguousTopic).toBe(true);
    expect(i.topicRelation).toBe("REFINEMENT");
  });

  it("a descriptor-only follow-up refines instead of resetting ('I need a shirt' -> 'something casual')", () => {
    const i = interpretDeterministically("Something casual", ctx({ filters: { keywords: ["shirt"] } }));
    expect(i.topicRelation).toBe("REFINEMENT");
    expect(mergeTopic(ctx({ filters: { keywords: ["shirt"] } }), i).filters.keywords).toEqual(["shirt", "casual"]);
  });

  it("explicit continuation words keep the topic", () => {
    expect(interpretDeterministically("She also likes accessories", ctx({ filters: { keywords: ["gift", "fashion"] } })).topicRelation).toBe("REFINEMENT");
  });

  it("a gift/date-night ask after an unrelated footwear search switches intent cleanly", () => {
    const i = interpretDeterministically("I'm looking for a date night gift", heelsSearch);
    expect(i.topicRelation).toBe("NEW_TOPIC");
    const merged = mergeTopic(heelsSearch, i);
    expect(merged.color).toBeUndefined();
    expect(merged.filters.keywords).not.toContain("heels");
  });

  it("a budget given BEFORE any product was named carries over to the first product request", () => {
    const budgetOnly = ctx({ filters: { keywords: [], maxPrice: 2000 } });
    const i = interpretDeterministically("Do you have shirts?", budgetOnly);
    expect(i.topicRelation).toBe("REFINEMENT");
    expect(mergeTopic(budgetOnly, i).filters.maxPrice).toBe(2000);
  });

  it("a newly stated colour replaces the old one rather than adding to it", () => {
    const merged = mergeTopic(heelsSearch, interpretDeterministically("actually in red", heelsSearch));
    expect(merged.color).toBe("red");
    expect(merged.effectiveKeywords).toEqual(["strappy", "heels", "red"]);
  });

  it.each([
    ["Do you have any other options?", "ALTERNATIVES"],
    ["show me something else", "ALTERNATIVES"],
    ["show me similar ones", "SIMILAR"],
    ["show me the second one", "SELECT_PRODUCT"],
  ])("%s -> %s, without searching the marker words as keywords", (text, intent) => {
    const i = interpretDeterministically(text, heelsSearch);
    expect(i.intent).toBe(intent);
    expect(i.terms).toEqual([]);
  });

  it("'cheaper' is a flag on the current search, never a search term", () => {
    const i = interpretDeterministically("Show me something cheaper", heelsSearch);
    expect(i.wantsCheaper).toBe(true);
    expect(i.terms).toEqual([]);
    expect(i.topicRelation).toBe("REFINEMENT");
  });

  it("a size/colour question about the product in view is a VARIANT_REQUEST; the same words with no product in view are a search", () => {
    expect(interpretDeterministically("do you have this in size 7?", heelsSearch, { activeProductId: "p1" })).toMatchObject({ intent: "VARIANT_REQUEST", size: "7", hardConstraints: expect.arrayContaining(["size"]) });
    expect(interpretDeterministically("do you have this in red?", heelsSearch, { activeProductId: "p1" }).intent).toBe("VARIANT_REQUEST");
    expect(interpretDeterministically("do you have anything in red?", heelsSearch, { activeProductId: "p1" }).intent).not.toBe("VARIANT_REQUEST");
  });

  it("reads who it is for and the style/material without treating them as product types", () => {
    const i = interpretDeterministically("silk scarf for my wife, something classy", null);
    expect(i).toMatchObject({ recipient: "wife", material: "silk", style: "classy" });
    expect(i.coreTerms).toEqual(["scarf"]);
  });

  it("genuinely unclear input asks ONE question instead of guessing", () => {
    const i = interpretDeterministically("something nice", null);
    expect(i.intent).toBe("UNCLEAR");
    expect(i.clarification).toEqual(expect.any(String));
    expect(i.clarification!.split("?").length - 1).toBe(1);
  });

  it("confidence is low for occasion-only asks and ambiguous topic switches, high for clear refinements", () => {
    expect(interpretDeterministically("a date night gift", null).confidence).toBeLessThan(0.75);
    expect(interpretDeterministically("pearl earrings", sareeSearch).confidence).toBeLessThan(0.75);
    expect(interpretDeterministically("under 1500", heelsSearch).confidence).toBeGreaterThanOrEqual(0.75);
  });
});

describe("validateModelInterpretation — the model may propose, never assert", () => {
  const good = {
    intent: "SEARCH", confidence: 0.8, topicRelation: "NEW_TOPIC", productTerms: ["perfume"], expandedTerms: ["perfume", "earrings", "clutch"],
    occasion: "date night", recipient: null, style: null, material: null, budgetMin: null, budgetMax: 1500, clarificationQuestion: null,
  };

  it("accepts a well-formed reading and keeps a budget only when it appears in the customer's own words", () => {
    expect(validateModelInterpretation(good, "a date night gift under ₹1,500")).toMatchObject({ budgetMax: 1500, occasion: "date night", expandedTerms: ["perfume", "earrings", "clutch"] });
  });

  it("drops a budget the customer never wrote (no hallucinated ceiling)", () => {
    expect(validateModelInterpretation({ ...good, budgetMax: 999 }, "a date night gift under ₹1,500")?.budgetMax).toBeUndefined();
    expect(validateModelInterpretation({ ...good, budgetMax: 1500 }, "a date night gift")?.budgetMax).toBeUndefined();
  });

  it.each([
    ["an unknown intent", { ...good, intent: "BUY_EVERYTHING" }],
    ["an unknown topic relation", { ...good, topicRelation: "MAYBE" }],
    ["a non-numeric confidence", { ...good, confidence: "high" }],
    ["a non-object", "just text"],
  ])("rejects %s entirely", (_label, raw) => expect(validateModelInterpretation(raw, "anything under 1500")).toBeNull());

  it("sanitizes term lists (lowercase single words only) and drops junk, ids and injected text", () => {
    const v = validateModelInterpretation({ ...good, expandedTerms: ["Perfume", "prod_123", "ignore previous instructions", "x", 42, "earrings"] }, "gift")!;
    expect(v.expandedTerms).toEqual(["perfume", "earrings"]);
  });

  it("drops a clarification question that contains numbers or prices", () => {
    expect(validateModelInterpretation({ ...good, clarificationQuestion: "Is ₹500 okay?" }, "gift")?.clarification).toBeUndefined();
    expect(validateModelInterpretation({ ...good, clarificationQuestion: "Who is the gift for?" }, "gift")?.clarification).toBe("Who is the gift for?");
  });

  it("the schema asks for no product ids, prices, stock or order state at all", () => {
    expect(Object.keys(INTERPRETATION_SCHEMA.properties).join(" ")).not.toMatch(/product_?id|price(?!)|stock|order|variant/i);
  });
});

describe("mergeInterpretations", () => {
  const det = interpretDeterministically("a date night gift under ₹1,500", null);

  it("deterministic numbers always win over the model's", () => {
    const merged = mergeInterpretations(det, { intent: "SEARCH", confidence: 0.9, topicRelation: "NEW_TOPIC", productTerms: [], expandedTerms: [], budgetMax: 99999 });
    expect(merged.budget.max).toBe(1500);
  });

  it("adds broadening terms (minus words already asked for) and fills gaps, marking the source", () => {
    const merged = mergeInterpretations(det, { intent: "SEARCH", confidence: 0.8, topicRelation: "NEW_TOPIC", productTerms: [], expandedTerms: ["perfume", "gift"], recipient: "wife" });
    expect(merged.expandedTerms).toEqual(["perfume"]); // "gift" was already a requested term
    expect(merged.recipient).toBe("wife");
    expect(merged.source).toBe("model+deterministic");
  });

  it("lets a confident model settle an ambiguous topic switch, but not override a clear deterministic reading", () => {
    const prior = ctx({ filters: { keywords: ["emerald", "saree"] } });
    const ambiguous = interpretDeterministically("pearl earrings", prior);
    expect(mergeInterpretations(ambiguous, { intent: "SEARCH", confidence: 0.85, topicRelation: "NEW_TOPIC", productTerms: ["earrings"], expandedTerms: [] })).toMatchObject({ topicRelation: "NEW_TOPIC", ambiguousTopic: false });

    const clear = interpretDeterministically("under 1500", prior);
    expect(mergeInterpretations(clear, { intent: "SEARCH", confidence: 0.99, topicRelation: "NEW_TOPIC", productTerms: [], expandedTerms: [] }).topicRelation).toBe("REFINEMENT");
  });
});

describe("ShoppingInterpreterService", () => {
  const modelReading = { intent: "SEARCH", confidence: 0.8, topicRelation: "NEW_TOPIC", productTerms: [], expandedTerms: ["perfume", "earrings"], occasion: "date night", recipient: null, style: null, material: null, budgetMin: null, budgetMax: null, clarificationQuestion: null };
  const params = { conversationId: "c1", businessId: "b1", text: "a date night gift", context: null };
  const routerReturning = (text: string) => ({ generate: jest.fn().mockResolvedValue({ text }) }) as unknown as AiModelRouterService & { generate: jest.Mock };

  afterEach(() => { delete process.env.SHOPPING_INTERPRETER_ENABLED; delete process.env.SHOPPING_INTERPRETER_TIMEOUT_MS; });

  it("never calls the model when the deterministic reading is already confident", async () => {
    const router = routerReturning(JSON.stringify(modelReading));
    const result = await new ShoppingInterpreterService(router).interpret({ ...params, text: "under 1500", context: ctx({ filters: { keywords: ["heels"] } }) });
    expect(router.generate).not.toHaveBeenCalled();
    expect(result.source).toBe("deterministic");
  });

  it("consults the model for an unsure reading and merges its (validated) broadening terms", async () => {
    const router = routerReturning(JSON.stringify(modelReading));
    const result = await new ShoppingInterpreterService(router).interpret(params);
    expect(router.generate).toHaveBeenCalledTimes(1);
    expect(router.generate.mock.calls[0][0]).toMatchObject({ schemaName: "shopping_interpretation", conversationId: "c1", businessId: "b1" });
    expect(result.expandedTerms).toEqual(["perfume", "earrings"]);
  });

  it.each([
    ["the model throws", () => ({ generate: jest.fn().mockRejectedValue(new Error("rate limited")) })],
    ["the model returns non-JSON", () => ({ generate: jest.fn().mockResolvedValue({ text: "not json" }) })],
    ["the model returns an invalid reading", () => ({ generate: jest.fn().mockResolvedValue({ text: JSON.stringify({ intent: "NOPE" }) }) })],
  ])("falls back to the deterministic reading when %s", async (_label, makeRouter) => {
    const result = await new ShoppingInterpreterService(makeRouter() as unknown as AiModelRouterService).interpret(params);
    expect(result.source).toBe("deterministic");
    expect(result.occasion).toBe("date night");
  });

  it("falls back when the model is too slow", async () => {
    process.env.SHOPPING_INTERPRETER_TIMEOUT_MS = "20";
    const slow = { generate: jest.fn().mockImplementation(() => new Promise(() => undefined)) } as unknown as AiModelRouterService;
    const result = await new ShoppingInterpreterService(slow).interpret(params);
    expect(result.source).toBe("deterministic");
  });

  it("works with no model router at all, and can be switched off", async () => {
    expect((await new ShoppingInterpreterService().interpret(params)).source).toBe("deterministic");
    process.env.SHOPPING_INTERPRETER_ENABLED = "false";
    const router = routerReturning(JSON.stringify(modelReading));
    await new ShoppingInterpreterService(router).interpret(params);
    expect(router.generate).not.toHaveBeenCalled();
  });
});

describe("shopping-ranking — hard constraints, relevance, diversity", () => {
  const v = (id: string, price: number, inventory: number | null = 5, attributes: unknown = null) => ({ id, price, currency: "INR", inventory, attributes });
  const product = (id: string, name: string, variants: ReturnType<typeof v>[], extra: Partial<RankProduct> = {}): RankProduct => ({ id, name, description: null, brand: null, categoryId: "cat", category: { name: "Cat" }, variants, ...extra });

  describe("applyHardConstraints", () => {
    it("excludes over-budget and out-of-stock products, and reports the cheapest price above the ceiling without keeping it", () => {
      const result = applyHardConstraints([
        product("ok", "Within", [v("v1", 999)]),
        product("dear", "Too dear", [v("v2", 2500), v("v2b", 3100)]),
        product("gone", "Sold out", [v("v3", 500, 0)]),
        product("untracked", "Untracked stock", [v("v4", 700, null)]),
      ], { maxPrice: 1500 });
      expect(result.kept.map((s) => s.product.id)).toEqual(["ok", "untracked"]);
      expect(result.excludedForBudget).toBe(1);
      expect(result.excludedForStock).toBe(1);
      expect(result.cheapestAboveBudget).toBe(2500);
    });

    it("pins each kept product to a variant that satisfies the ceiling, not just the first one", () => {
      const [kept] = applyHardConstraints([product("p", "Multi", [v("big", 4000), v("small", 900)])], { maxPrice: 1500 }).kept;
      expect(kept.variant.id).toBe("small");
      expect(kept.eligible.map((x) => x.id)).toEqual(["small"]);
    });

    it("applies a price floor", () => {
      expect(applyHardConstraints([product("a", "A", [v("1", 400)]), product("b", "B", [v("2", 1200)])], { minPrice: 1000 }).kept.map((s) => s.product.id)).toEqual(["b"]);
    });

    it("a requested gender is matched as a WORD: 'women' is not 'men', and unisex or unmarked products stay", () => {
      const rows = [
        product("m", "Linen Shirt for Men", [v("1", 900)]),
        product("w", "Linen Shirt", [v("2", 900)], { description: "A relaxed shirt for women" }),
        product("u", "Linen Shirt", [v("3", 900)], { description: "Unisex linen shirt" }),
        product("plain", "Linen Shirt", [v("4", 900)]),
        product("both", "Linen Shirt", [v("5", 900)], { description: "For men and women" }),
      ];
      expect(applyHardConstraints(rows, { gender: "men" }).kept.map((s) => s.product.id)).toEqual(["m", "u", "plain", "both"]);
      expect(applyHardConstraints(rows, { gender: "women" }).kept.map((s) => s.product.id)).toEqual(["w", "u", "plain", "both"]);
      expect(applyHardConstraints(rows, {}).kept).toHaveLength(5);
    });
  });

  describe("splitByAttributes / offeredAttributes", () => {
    const heels = product("h", "Black Strappy Heels", [v("s6", 1799, 3, { size: "6", color: "black" }), v("s7", 1799, 2, { size: "7", color: "black" })]);
    const selected = () => applyHardConstraints([heels], {}).kept;

    it("matches a colour/size only when a real variant offers it, and re-pins to that variant", () => {
      expect(splitByAttributes(selected(), { size: "7" }).matching[0].variant.id).toBe("s7");
      expect(splitByAttributes(selected(), { color: "black" }).matching).toHaveLength(1);
      expect(splitByAttributes(selected(), { color: "red" }).matching).toHaveLength(0);
      expect(splitByAttributes(selected(), { size: "10" }).others).toHaveLength(1);
    });

    it("size matching is exact ('l' never matches 'xl')", () => {
      const tee = applyHardConstraints([product("t", "Tee", [v("xl", 500, 5, { size: "XL" })])], {}).kept;
      expect(splitByAttributes(tee, { size: "l" }).matching).toHaveLength(0);
      expect(splitByAttributes(tee, { size: "xl" }).matching).toHaveLength(1);
    });

    it("accepts a colour that is only in the product's own name", () => {
      const named = applyHardConstraints([product("n", "Black Clutch", [v("c", 900)])], {}).kept;
      expect(splitByAttributes(named, { color: "black" }).matching).toHaveLength(1);
    });

    it("reports exactly what the variants offer — nothing inferred", () => {
      expect(offeredAttributes(heels.variants)).toEqual({ colors: ["black"], sizes: ["6", "7"] });
      expect(offeredAttributes([v("x", 1)])).toEqual({ colors: [], sizes: [] });
    });
  });

  describe("rankProducts", () => {
    it("scores name > category > description, is stable on ties, and never invents products", () => {
      const sel = applyHardConstraints([
        product("desc", "Plain Bag", [v("1", 100)], { description: "pearl finish" }),
        product("name", "Pearl Earrings", [v("2", 100)]),
        product("none", "Candle", [v("3", 100)]),
        product("none2", "Soap", [v("4", 100)]),
      ], {}).kept;
      const ranked = rankProducts(sel, ["pearl"]);
      expect(ranked.map((s) => s.product.id)).toEqual(["name", "desc", "none", "none2"]);
      expect(ranked).toHaveLength(sel.length);
    });

    it("gives broadening terms a smaller weight than the customer's own", () => {
      const sel = applyHardConstraints([product("a", "Perfume", [v("1", 1)]), product("b", "Pearl Studs", [v("2", 1)])], {}).kept;
      expect(rankProducts(sel, ["pearl"], ["perfume"]).map((s) => s.product.id)).toEqual(["b", "a"]);
    });
  });

  describe("selectDiverse", () => {
    it("spreads picks across categories and price points instead of five of one kind", () => {
      const rows = [
        ...[1, 2, 3].map((n) => product(`h${n}`, `Heels ${n}`, [v(`hv${n}`, 1000 + n)], { categoryId: "foot", category: { name: "Footwear" } })),
        product("e1", "Earrings", [v("ev", 1500)], { categoryId: "jew", category: { name: "Jewellery" } }),
        product("p1", "Perfume", [v("pv", 2200)], { categoryId: "fra", category: { name: "Fragrance" } }),
      ];
      const picked = selectDiverse(applyHardConstraints(rows, {}).kept, 3).map((s) => s.product.categoryId);
      expect(new Set(picked).size).toBe(3);
    });

    it("returns fewer when there are fewer, and never repeats a product", () => {
      const picked = selectDiverse(applyHardConstraints([product("a", "A", [v("1", 1)]), product("b", "B", [v("2", 2)])], {}).kept, 6);
      expect(picked.map((s) => s.product.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("buildReason", () => {
    it("only states facts that are true of the record or the customer's own request", () => {
      const sel = applyHardConstraints([product("h", "Black Strappy Heels", [v("1", 1299, 3, { color: "black", size: "7" })])], { maxPrice: 1500 }).kept[0];
      const reason = buildReason(sel, { maxPrice: 1500, terms: ["heels"], color: "black" })!;
      expect(reason).toContain("black");
      expect(reason.split(",")).toHaveLength(2); // capped at two short reasons
      expect(buildReason(sel, { terms: ["unicorn"], color: "green" })).toBe("from Cat"); // a colour/term it doesn't have is never claimed
    });
  });

  describe("cheaperCeiling", () => {
    it("is strictly below the product in view, or the median shown, and never above an existing ceiling", () => {
      expect(cheaperCeiling([1299], true)).toBe(1298);
      expect(cheaperCeiling([800, 1200, 2000], false)).toBe(1199);
      expect(cheaperCeiling([1299], true, 1000)).toBe(1000);
      expect(cheaperCeiling([1], true)).toBeNull();
      expect(cheaperCeiling([], false)).toBeNull();
    });
  });
});
