import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ShoppingFlowService } from "../shopping-flow/shopping-flow.service";
import { AssistedBuyingService } from "../assisted-buying/assisted-buying.service";
import { WhatsAppWebhookService } from "../webhooks/whatsapp-webhook.service";
import { ShoppingInterpreterService } from "./shopping-interpreter.service";
import { fmtMoney } from "./search-utils";
import type { AiModelRouterService } from "../ai/ai-model-router.service";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp-parser";

// ---------------------------------------------------------------------------------------------------------------
// End-to-end conversation scenarios. The REAL ShoppingFlowService / AssistedBuyingService / WhatsAppWebhookService
// and the real interpreter + ranking run against in-memory fakes that behave like the real backends:
//  - a catalogue that actually EVALUATES the Prisma-style filters the services send (AND/OR/contains/variants.some/
//    price/stock/id.notIn), so a service that forgets a constraint is caught instead of "passing" on a canned mock
//  - a conversation row persisted through a JSON round-trip (like Postgres Json), so context really survives turns
//  - a cart that validates stock, and a message table with a unique providerMessageId
// ---------------------------------------------------------------------------------------------------------------

const BIZ = "biz1";
const CUSTOMER = "cust1";
const CONV = "conv1";

interface FakeVariant { id: string; price: number; currency: "INR"; inventory: number | null; active: boolean; attributes: Record<string, string> | null; sku: string | null }
interface FakeProduct { id: string; businessId: string; name: string; description: string | null; brand: string | null; imageUrl: string | null; status: "PUBLISHED" | "DRAFT"; categoryId: string; category: { name: string }; createdAt: Date; variants: FakeVariant[] }

const CATEGORY_NAMES: Record<string, string> = { "cat-foot": "Footwear", "cat-saree": "Sarees", "cat-jew": "Jewellery", "cat-gift": "Gifts", "cat-occ": "Occasion Wear" };
let clock = 0;
const product = (id: string, name: string, categoryId: string, description: string | null, variants: Partial<FakeVariant>[]): FakeProduct => ({
  id, businessId: BIZ, name, description, brand: null, imageUrl: null, status: "PUBLISHED", categoryId, category: { name: CATEGORY_NAMES[categoryId] }, createdAt: new Date(2026, 0, 1 + clock++),
  variants: variants.map((v, i) => ({ id: v.id ?? `${id}-${i}`, price: v.price!, currency: "INR", inventory: v.inventory === undefined ? 5 : v.inventory, active: v.active ?? true, attributes: v.attributes ?? null, sku: null })),
});

const catalogue = (): FakeProduct[] => [
  product("heels", "Black Strappy Heels", "cat-foot", "Elegant strappy heels with a cushioned sole", [
    { id: "heels-6", price: 1799, inventory: 3, attributes: { size: "6", color: "black" } },
    { id: "heels-7", price: 1799, inventory: 2, attributes: { size: "7", color: "black" } },
    { id: "heels-8", price: 1799, inventory: 0, attributes: { size: "8", color: "black" } },
  ]),
  product("block", "Nude Block Heels", "cat-foot", "Comfortable block heels", [{ id: "block-7", price: 1499, inventory: 4, attributes: { size: "7", color: "nude" } }]),
  product("sandals", "Gold Strappy Sandals", "cat-foot", "Flat strappy sandals", [{ id: "sandals-7", price: 1299, inventory: 6, attributes: { size: "7", color: "gold" } }]),
  product("sneakers", "White Sneakers", "cat-foot", "Everyday sneakers", [{ id: "sneak-7", price: 2499, inventory: 9, attributes: { size: "7", color: "white" } }]),
  product("saree-em", "Emerald Silk Saree", "cat-saree", "Handwoven emerald silk saree", [{ id: "saree-em-1", price: 4500, inventory: 5 }]),
  product("saree-red", "Red Banarasi Saree", "cat-saree", "Festive red saree", [{ id: "saree-red-1", price: 6999, inventory: 3 }]),
  product("saree-navy", "Navy Cotton Saree", "cat-saree", "Light cotton saree", [{ id: "saree-navy-1", price: 2799, inventory: 8 }]),
  product("lehenga", "Wedding Lehenga Set", "cat-occ", "A complete wedding outfit with heavy embroidery", [{ id: "leh-1", price: 14999, inventory: 2 }]),
  product("kurta", "Embroidered Kurta Set", "cat-occ", "Festive wear outfit for weddings and parties", [{ id: "kurta-1", price: 2799, inventory: 6 }]),
  product("dupatta", "Silk Dupatta", "cat-occ", "A light silk dupatta", [{ id: "dup-1", price: 1299, inventory: 10 }]),
  product("pearl-drop", "Pearl Drop Earrings", "cat-jew", "Classic pearl earrings", [{ id: "pd-1", price: 1199, inventory: 7 }]),
  product("pearl-stud", "Pearl Stud Earrings", "cat-jew", "Minimal pearl earrings", [{ id: "ps-1", price: 799, inventory: 12 }]),
  product("pearl-diamond", "Diamond Pearl Earrings", "cat-jew", "Luxury pearl earrings with diamonds", [{ id: "pdi-1", price: 8999, inventory: 2 }]),
  product("hoop", "Gold Hoop Earrings", "cat-jew", "Everyday gold earrings", [{ id: "hoop-1", price: 1499, inventory: 5 }]),
  product("necklace", "Rose Gold Necklace", "cat-jew", "Delicate necklace", [{ id: "neck-1", price: 1899, inventory: 4 }]),
  product("perfume", "Rose Perfume 50ml", "cat-gift", "A romantic floral fragrance", [{ id: "perf-1", price: 1299, inventory: 10 }]),
  product("candle", "Scented Candle Set", "cat-gift", "Cosy candle trio", [{ id: "candle-1", price: 899, inventory: 20 }]),
  product("clutch", "Leather Clutch", "cat-gift", "Compact evening clutch", [{ id: "clutch-1", price: 1399, inventory: 6 }]),
  product("giftset", "Luxury Perfume Gift Set", "cat-gift", "A premium gift set", [{ id: "gs-1", price: 3499, inventory: 3 }]),
];

// ----- tiny Prisma-where evaluator (throws on anything it doesn't understand, so an unsupported query can't silently "match") -----
type Row = Record<string, any>;
const containsText = (hay: unknown, needle: string) => String(hay ?? "").toLowerCase().includes(needle.toLowerCase());

function fieldMatches(value: unknown, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== "object") return value === cond;
  if ("contains" in cond) return containsText(value, cond.contains);
  if ("not" in cond) return value !== cond.not;
  if ("notIn" in cond) return !cond.notIn.includes(value);
  if ("in" in cond) return cond.in.includes(value);
  if ("gt" in cond || "gte" in cond || "lt" in cond || "lte" in cond) {
    if (value === null || value === undefined) return false;
    const n = Number(value);
    return (cond.gt === undefined || n > cond.gt) && (cond.gte === undefined || n >= cond.gte) && (cond.lt === undefined || n < cond.lt) && (cond.lte === undefined || n <= cond.lte);
  }
  // a nested relation filter, e.g. variant.findFirst({ where: { product: { status: "PUBLISHED" } } })
  if (value && typeof value === "object") return Object.entries(cond).every(([k, c]) => fieldMatches((value as Row)[k], c));
  throw new Error(`fake catalogue: unsupported field condition ${JSON.stringify(cond)}`);
}
const variantMatches = (v: Row, where: Row): boolean => Object.entries(where).every(([k, c]) => (k === "OR" ? (c as Row[]).some((s) => variantMatches(v, s)) : k === "AND" ? (c as Row[]).every((s) => variantMatches(v, s)) : fieldMatches(v[k], c)));
const productMatches = (p: Row, where: Row): boolean => Object.entries(where).every(([k, c]) => {
  switch (k) {
    case "AND": return (c as Row[]).every((s) => productMatches(p, s));
    case "OR": return (c as Row[]).some((s) => productMatches(p, s));
    case "category": return containsText(p.category?.name, c.name.contains);
    case "variants": return p.variants.some((v: Row) => variantMatches(v, c.some));
    case "name": case "description": case "brand": case "id": case "businessId": case "status": case "categoryId": return fieldMatches(p[k], c);
    default: throw new Error(`fake catalogue: unsupported where.${k}`);
  }
});

function buildWorld(opts: { router?: AiModelRouterService; products?: FakeProduct[] } = {}) {
  const products = opts.products ?? catalogue();
  const queries: Row[] = [];
  const state = { failNextProductQuery: null as Error | null, leakyDb: false };
  const conversation: Row = { id: CONV, businessId: BIZ, customerId: CUSTOMER, shoppingState: "IDLE", pendingVariantId: null, activeProductId: null, activeCategoryId: null, assistedBuyingContext: null, pendingAddress: null, pendingPaymentMethod: null, activeOrderId: null, escalated: false };
  const sent: { kind: "message" | "buttons" | "list" | "image"; body: string; rows?: { id: string; title: string; description?: string }[]; buttons?: { id: string; title: string }[] }[] = [];

  const shape = (p: FakeProduct, include?: Row) => {
    const variantsInclude = include?.variants;
    let variants = p.variants.filter((v) => !variantsInclude?.where || variantMatches(v, variantsInclude.where));
    if (variantsInclude?.orderBy?.price === "asc") variants = [...variants].sort((a, b) => a.price - b.price);
    if (variantsInclude?.take) variants = variants.slice(0, variantsInclude.take);
    return { ...p, variants: variants.map((v) => ({ ...v })) };
  };
  const productFindMany = async (args: Row) => {
    queries.push(args);
    if (state.failNextProductQuery) { const e = state.failNextProductQuery; state.failNextProductQuery = null; throw e; }
    const rows = state.leakyDb ? products.filter((p) => p.status === "PUBLISHED") : products.filter((p) => productMatches(p, args.where ?? {}));
    return rows.slice(0, args.take ?? Infinity).map((p) => shape(p, args.include));
  };

  const prisma: any = {
    business: { findUnique: async () => ({ id: BIZ, name: "Luna Closet", smartRepliesEnabled: false, assistedBuyingMaxRecommendations: 5, assistedBuyingExcludedCategoryIds: [], assistedBuyingRankingPreference: "BEST_MATCH" }) },
    category: { findMany: async () => Object.entries(CATEGORY_NAMES).map(([id, name]) => ({ id, name })) },
    product: {
      findMany: productFindMany,
      findFirst: async (args: Row) => (await productFindMany({ ...args, take: 1 }))[0] ?? null,
    },
    variant: {
      findFirst: async (args: Row) => {
        for (const p of products) for (const v of p.variants) if (variantMatches({ ...v, productId: p.id, businessId: BIZ, product: { id: p.id, name: p.name, status: p.status } }, args.where)) return { ...v, productId: p.id, businessId: BIZ, product: { id: p.id, name: p.name, status: p.status } };
        return null;
      },
    },
    productRelation: { findMany: async () => [] },
    conversation: {
      findFirst: async () => ({ ...conversation }),
      update: async ({ data }: { data: Row }) => {
        for (const [k, v] of Object.entries(data)) conversation[k] = k === "assistedBuyingContext" ? (v === Prisma.JsonNull || v === null ? null : JSON.parse(JSON.stringify(v))) : v;
        return { ...conversation };
      },
    },
    aiActionLog: { create: async () => ({}) },
  };

  const conversations = {
    sendMessage: async (_c: string, _b: string, body: string) => { sent.push({ kind: "message", body }); },
    sendImage: async (_c: string, _b: string, _url: string, body: string) => { sent.push({ kind: "image", body }); },
    sendButtons: async (_c: string, _b: string, body: string, buttons: { id: string; title: string }[], _imageUrl?: string) => { sent.push({ kind: "buttons", body, buttons }); },
    sendList: async (_c: string, _b: string, body: string, _btn: string, sections: { rows: { id: string; title: string; description?: string }[] }[]) => { sent.push({ kind: "list", body, rows: sections.flatMap((s) => s.rows) }); },
  };

  // ----- cart: stock-validated, one ACTIVE cart per conversation, checkout creates an order and closes the cart -----
  const carts: { id: string; status: "ACTIVE" | "CHECKED_OUT"; items: Map<string, number> }[] = [];
  const orders: { id: string; items: [string, number][] }[] = [];
  const findVariant = (variantId: string) => { for (const p of products) for (const v of p.variants) if (v.id === variantId) return { v, p }; return null; };
  const shapeCart = (c: (typeof carts)[number]) => ({
    id: c.id, status: c.status,
    items: [...c.items.entries()].map(([variantId, quantity]) => { const { v, p } = findVariant(variantId)!; return { variantId, quantity, variant: { ...v, productId: p.id, product: { id: p.id, name: p.name } } }; }),
  });
  const addItemCalls: { variantId: string; quantity: number }[] = [];
  const cart: any = {
    getOrCreateActive: async () => { let c = carts.find((x) => x.status === "ACTIVE"); if (!c) { c = { id: `cart${carts.length + 1}`, status: "ACTIVE", items: new Map() }; carts.push(c); } return shapeCart(c); },
    findActiveForConversation: async () => { const c = carts.find((x) => x.status === "ACTIVE"); return c ? shapeCart(c) : null; },
    addItem: async (cartId: string, _b: string, variantId: string, quantity: number) => {
      addItemCalls.push({ variantId, quantity });
      const c = carts.find((x) => x.id === cartId); const found = findVariant(variantId);
      if (!c || !found || !found.v.active || found.p.status !== "PUBLISHED") throw new NotFoundException("Product variant not found.");
      const next = (c.items.get(variantId) ?? 0) + quantity;
      if (found.v.inventory !== null && next > found.v.inventory) throw new BadRequestException(`Only ${found.v.inventory} left in stock.`);
      c.items.set(variantId, next);
      return shapeCart(c);
    },
    updateItemQuantity: async (cartId: string, _b: string, variantId: string, quantity: number) => {
      const c = carts.find((x) => x.id === cartId)!; const found = findVariant(variantId)!;
      if (quantity <= 0) c.items.delete(variantId);
      else { if (found.v.inventory !== null && quantity > found.v.inventory) throw new BadRequestException(`Only ${found.v.inventory} left in stock.`); c.items.set(variantId, quantity); }
      return shapeCart(c);
    },
    totals: (c: ReturnType<typeof shapeCart>) => ({ subtotal: c.items.reduce((s, i) => s + i.variant.price * i.quantity, 0), currency: "INR", itemCount: c.items.reduce((s, i) => s + i.quantity, 0) }),
    clear: async () => undefined,
    checkout: async (cartId: string) => {
      const c = carts.find((x) => x.id === cartId)!;
      if (c.status !== "ACTIVE") throw new ConflictException("This cart has already been checked out.");
      if (!c.items.size) throw new BadRequestException("Your cart is empty.");
      c.status = "CHECKED_OUT";
      const order = { id: `order${orders.length + 1}`, items: [...c.items.entries()] as [string, number][] };
      orders.push(order);
      return { id: order.id, status: "PENDING_PAYMENT", total: 0, currency: "INR", razorpayPaymentLinkUrl: null };
    },
  };

  const interpreter = new ShoppingInterpreterService(opts.router);
  const flow = new ShoppingFlowService(prisma, conversations as any, cart, {} as any, { record: async () => undefined } as any, interpreter);
  const assisted = new AssistedBuyingService(prisma, conversations as any, cart, interpreter);

  const GREETING = /^\s*(hi+|hello+|hey+|start|menu|shop|shopping)\s*[!.?]*\s*$/i;
  /** What the webhook does for one inbound text: greeting -> menu; non-IDLE -> the shopping flow; otherwise it would go to the AI (returned as false). */
  const say = async (text: string): Promise<boolean> => {
    if (GREETING.test(text)) { await flow.sendMainMenu(CONV, BIZ); return true; }
    if (conversation.shoppingState === "IDLE") return false;
    return flow.handleFreeText(CONV, BIZ, { ...conversation } as any, text);
  };
  const tap = (id: string) => flow.handleInteractive(CONV, BIZ, id);

  const lastSent = () => sent[sent.length - 1];
  const lastList = () => { const l = [...sent].reverse().find((s) => s.kind === "list"); if (!l) throw new Error("no list was sent"); return l; };
  const ctx = () => conversation.assistedBuyingContext as Row | null;
  const productById = (id: string) => products.find((p) => p.id === id)!;
  const priceOfRow = (rowId: string) => { const lr = (ctx()?.lastResults as { productId: string; variantId: string }[]).find((r) => `prod_${r.productId}` === rowId)!; return findVariant(lr.variantId)!.v.price; };

  /** Every product/price shown must be a real, published catalogue record, linked to a variant of THAT product that is active and in stock. */
  const assertRowsAreRealRecords = (rows: { id: string; title: string; description?: string }[]) => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const entry = (ctx()?.lastResults as { productId: string; variantId: string; name: string }[]).find((r) => `prod_${r.productId}` === row.id);
      expect(entry).toBeTruthy();
      const p = productById(entry!.productId);
      expect(p.status).toBe("PUBLISHED");
      expect(row.title).toBe(p.name);
      const variant = p.variants.find((v) => v.id === entry!.variantId)!;
      expect(variant).toBeTruthy();
      expect(variant.active).toBe(true);
      expect(variant.inventory === null || variant.inventory > 0).toBe(true);
      expect(row.description).toContain(fmtMoney(variant.price, "INR"));
    }
  };

  return { products, queries, state, conversation, sent, orders, carts, addItemCalls, cart, flow, assisted, say, tap, lastSent, lastList, ctx, productById, priceOfRow, assertRowsAreRealRecords, prisma, conversations, interpreter };
}
type World = ReturnType<typeof buildWorld>;

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

describe("conversational shopping — scenarios", () => {
  let w: World;
  beforeEach(() => { clock = 0; w = buildWorld(); });

  describe("1. date-night gift, then 'under ₹1,500' — intent is preserved and the budget is enforced", () => {
    it("keeps the occasion and keywords, applies the budget (parsed from '₹1,500'), and shows nothing above it", async () => {
      await w.say("hi");
      await w.say("I need a date night gift");
      const unbudgeted = w.lastList();
      expect(unbudgeted.body).toContain("Nothing matched exactly"); // no product literally named for it — said honestly
      expect(titles(unbudgeted.rows!)).toContain("Luxury Perfume Gift Set"); // ₹3,499, fine without a budget
      w.assertRowsAreRealRecords(unbudgeted.rows!);

      await w.say("under ₹1,500");
      const list = w.lastList();
      expect(w.ctx()!.filters).toEqual({ keywords: ["date", "night", "gift"], maxPrice: 1500 }); // not 1, not 500
      expect(w.ctx()!.occasion).toBe("date night");
      expect(list.body).toContain("within INR 1,500");
      expect(titles(list.rows!)).not.toContain("Luxury Perfume Gift Set");
      for (const r of list.rows!) expect(w.priceOfRow(r.id)).toBeLessThanOrEqual(1500);
      w.assertRowsAreRealRecords(list.rows!);
      // the ceiling is in every catalogue query of that turn, not only applied afterwards
      for (const q of w.queries.slice(-2)) expect(q.where.variants.some.price).toEqual({ lte: 1500 });
    });
  });

  describe("2. black strappy heels, then 'other options' — different, relevant products", () => {
    it("excludes what was already shown and offers other footwear, closest first", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      expect(titles(w.lastList().rows!)).toEqual(["Black Strappy Heels"]);
      await w.tap("prod_heels"); // the customer opens it

      await w.say("do you have any other options?");
      const list = w.lastList();
      expect(list.body).toContain("other options");
      expect(list.body).toContain("*Black Strappy Heels*");
      expect(titles(list.rows!)).not.toContain("Black Strappy Heels");
      expect(titles(list.rows!)).toEqual(expect.arrayContaining(["Nude Block Heels", "Gold Strappy Sandals"]));
      for (const row of list.rows!) expect(w.productById(row.id.slice(5)).categoryId).toBe("cat-foot");
      w.assertRowsAreRealRecords(list.rows!);
    });

    it("never repeats products on a second 'other options', and says so honestly when nothing is left", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      await w.tap("prod_heels");
      await w.say("any other options");
      const firstBatch = titles(w.lastList().rows!);
      await w.say("any other options");
      const secondBatch = w.lastSent();
      if (secondBatch.kind === "list") expect(titles(secondBatch.rows!).filter((t) => firstBatch.includes(t))).toEqual([]);
      else expect(secondBatch.body).toContain("everything I have");
    });
  });

  describe("3. emerald saree, then pearl earrings — a new intent that inherits nothing irrelevant", () => {
    it("drops the saree's keywords AND its budget", async () => {
      await w.say("hi");
      await w.say("show me an emerald saree under 5000");
      expect(titles(w.lastList().rows!)).toEqual(["Emerald Silk Saree"]);
      expect(w.ctx()!.filters.maxPrice).toBe(5000);

      await w.say("Do you have pearl earrings?");
      const list = w.lastList();
      expect(w.ctx()!.filters).toEqual({ keywords: ["pearl", "earrings"] }); // no emerald/saree, no ₹5,000
      expect(titles(list.rows!)).toEqual(expect.arrayContaining(["Pearl Drop Earrings", "Pearl Stud Earrings", "Diamond Pearl Earrings"]));
      expect(titles(list.rows!)).toContain("Diamond Pearl Earrings"); // ₹8,999 — only visible because the old budget was NOT inherited
      expect(w.queries.at(-1)!.where.variants.some.price).toBeUndefined();
      w.assertRowsAreRealRecords(list.rows!);
    });

    it("recovers when the switch has no request words ('pearl earrings'): the combined search finds nothing, so it is retried as a fresh topic", async () => {
      await w.say("hi");
      await w.say("emerald saree");
      await w.say("pearl earrings");
      expect(titles(w.lastList().rows!)).toEqual(expect.arrayContaining(["Pearl Drop Earrings", "Pearl Stud Earrings"]));
      expect(titles(w.lastList().rows!).some((t) => /saree/i.test(t))).toBe(false);
      expect(w.ctx()!.filters.keywords).toEqual(["pearl", "earrings"]);
    });
  });

  describe("4. pearl earrings, then 'show me similar ones' — the viewed product is the reference", () => {
    it("finds products similar to the one in view, even while the quantity prompt is open, without touching the cart", async () => {
      await w.say("hi");
      await w.say("pearl earrings");
      await w.tap("prod_pearl-stud"); // single-variant -> asks "how many would you like?"
      expect(w.conversation.shoppingState).toBe("AWAITING_QUANTITY");

      await w.say("show me similar ones");
      const list = w.lastList();
      expect(list.body).toContain("similar to *Pearl Stud Earrings*");
      expect(titles(list.rows!)).not.toContain("Pearl Stud Earrings");
      expect(titles(list.rows!).slice(0, 2)).toEqual(expect.arrayContaining(["Pearl Drop Earrings", "Diamond Pearl Earrings"])); // closest first
      expect(w.conversation.shoppingState).toBe("BROWSING_PRODUCTS");
      expect(w.addItemCalls).toEqual([]);
      w.assertRowsAreRealRecords(list.rows!);
    });
  });

  describe("5. wedding outfit under ₹3,000 — never above the budget", () => {
    it("parses '₹3,000' correctly and never lists the ₹14,999 lehenga", async () => {
      await w.say("hi");
      await w.say("I need a wedding outfit under ₹3,000");
      const list = w.lastList();
      expect(titles(list.rows!)).toContain("Embroidered Kurta Set");
      expect(titles(list.rows!)).not.toContain("Wedding Lehenga Set");
      for (const r of list.rows!) expect(w.priceOfRow(r.id)).toBeLessThanOrEqual(3000);
      expect(w.ctx()!.filters.maxPrice).toBe(3000);
    });

    it("still never lists an over-budget product when the data layer misbehaves and returns everything (the ceiling is re-checked on the records)", async () => {
      w.state.leakyDb = true;
      await w.say("hi");
      await w.say("I need a wedding outfit under ₹3,000");
      const list = w.lastList();
      for (const r of list.rows!) expect(w.priceOfRow(r.id)).toBeLessThanOrEqual(3000);
      expect(titles(list.rows!)).not.toContain("Wedding Lehenga Set");
    });

    it("is also enforced by the free-text card engine (AssistedBuyingService)", async () => {
      await w.assisted.handle(CONV, BIZ, CUSTOMER, "a wedding outfit under ₹3,000");
      const cards = w.sent.filter((s) => s.kind === "buttons").map((s) => s.body);
      expect(cards.join("\n")).not.toContain("Wedding Lehenga Set");
      expect(cards.length).toBeGreaterThan(0);
    });
  });

  describe("6. footwear browsing, then a date-night gift — a clean switch", () => {
    it("leaves the footwear category and its colour behind", async () => {
      await w.say("hi");
      await w.tap("menu_shop");
      await w.tap("cat_cat-foot");
      expect(w.conversation.activeCategoryId).toBe("cat-foot");
      await w.say("black heels");
      expect(w.ctx()!.color).toBe("black");

      await w.say("I'm looking for a date night gift");
      const list = w.lastList();
      expect(w.ctx()).toMatchObject({ occasion: "date night", filters: { keywords: ["date", "night", "gift"] } });
      expect(w.ctx()!.color).toBeUndefined();
      expect(w.conversation.activeCategoryId).toBeNull();
      expect(titles(list.rows!).some((t) => /heels|sneakers|sandals/i.test(t))).toBe(false);
      w.assertRowsAreRealRecords(list.rows!);
    });
  });

  describe("7. an unavailable colour — honest, with real alternatives", () => {
    it("says it doesn't come in red, says what it does come in, and shows the real product", async () => {
      await w.say("hi");
      await w.say("do you have red strappy heels?");
      const list = w.lastList();
      expect(list.body).toContain("don't have");
      expect(list.body).toContain("in red");
      expect(list.body).toContain("It comes in: black");
      expect(titles(list.rows!)).toEqual(["Black Strappy Heels"]);
      expect(list.rows![0].description).not.toMatch(/red/i); // never claims a colour it doesn't have
      expect(w.ctx()!.color).toBeUndefined(); // the unavailable colour isn't remembered as a constraint

      await w.say("black ones then");
      expect(w.lastList().body).toContain("I found one option"); // and the colour that DOES exist is found exactly
    });

    it("reports a product that doesn't exist at all as a plain no-match — not an invented alternative", async () => {
      await w.say("hi");
      await w.say("do you have a red unicorn saddle?");
      expect(w.lastSent().kind).toBe("buttons");
      expect(w.lastSent().body).toContain("couldn't find anything matching");
      expect(w.sent.some((s) => s.kind === "list")).toBe(false);
    });
  });

  describe("8. a different size/variant — validated against the real variants", () => {
    it("confirms an in-stock size, refuses an out-of-stock or non-existent one, and never reads 'size 8' as a quantity of 8", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      await w.tap("prod_heels");

      await w.say("do you have this in size 7?");
      expect(w.lastSent().body).toContain("is available at INR 1,799");
      expect(w.conversation).toMatchObject({ shoppingState: "AWAITING_QUANTITY", pendingVariantId: "heels-7" });

      await w.say("what about size 8?"); // exists, but 0 in stock — and the quantity prompt is still open
      expect(w.lastSent().body).toContain("size 8 is currently out of stock");
      expect(w.lastSent().body).toContain("Still available: 6, black | 7, black");
      expect(w.addItemCalls).toEqual([]); // the old behaviour would have added 8 pairs

      await w.say("do you have it in size 10?");
      expect(w.lastSent().body).toContain("I don't have *Black Strappy Heels* in size 10");
      expect(w.lastSent().body).toContain("6, black | 7, black");

      await w.say("do you have this in blue?");
      expect(w.lastSent().body).toContain("I don't have *Black Strappy Heels* in blue");
    });

    it("only a real quantity reply is a quantity — a message that merely contains a number is a new request", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      await w.tap("prod_heels");
      await w.say("do you have this in size 7?"); // quantity prompt is open

      await w.say("heels under 1300"); // a budget, not 1300 pairs
      expect(w.addItemCalls).toEqual([]);

      // the search replaced the product in view, so start the quantity prompt again
      await w.say("black strappy heels");
      await w.tap("prod_heels");
      await w.say("do you have this in size 7?");
      await w.say("three pairs");
      expect(w.addItemCalls).toEqual([{ variantId: "heels-7", quantity: 3 }]);
    });

    it("an in-stock size then flows into the normal quantity step on exactly that variant", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      await w.tap("prod_heels");
      await w.say("do you have this in size 7?");
      await w.say("2");
      expect(w.addItemCalls).toEqual([{ variantId: "heels-7", quantity: 2 }]);
    });

    it("a stock limit is still enforced by the cart service, not by the interpretation", async () => {
      await w.say("hi");
      await w.say("black strappy heels");
      await w.tap("prod_heels");
      await w.say("do you have this in size 7?");
      await w.say("5"); // only 2 in stock
      expect(w.lastSent().body).toContain("Only 2 left in stock");
      expect([...w.carts[0].items.values()].reduce((a, b) => a + b, 0)).toBe(0);
    });
  });

  describe("9. ordinal references resolve against the MOST RECENT result set", () => {
    it("'the second one' / 'the last one' follow the latest list, including after a refinement", async () => {
      await w.say("hi");
      await w.say("pearl earrings");
      await w.say("show me the second one");
      expect(w.conversation.activeProductId).toBe("pearl-stud");

      await w.say("pearl earrings under 1300"); // a refined, shorter list: stud (799), drop (1199)
      expect(titles(w.lastList().rows!)).toEqual(["Pearl Drop Earrings", "Pearl Stud Earrings"]);
      await w.say("the last one");
      expect(w.conversation.activeProductId).toBe("pearl-stud");
      await w.say("show me the first one");
      expect(w.conversation.activeProductId).toBe("pearl-drop");
    });
  });

  describe("10. add to cart, then a new shopping question — the cart survives and the search context updates", () => {
    it("keeps the cart and the last cart item while the topic changes, and 'make that 3' still targets the earrings", async () => {
      await w.say("hi");
      await w.say("pearl earrings");
      const before = w.ctx()!.lastResults;
      await w.tap("quickadd_ps-1");
      expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 1]]);
      expect(w.ctx()!.lastResults).toEqual(before); // the shown list is still there ("the second one" would still work)
      expect(w.ctx()!.lastCartItem).toMatchObject({ productId: "pearl-stud" });

      await w.say("do you have a rose perfume?");
      expect(w.ctx()!.filters.keywords).toEqual(["rose", "perfume"]);
      expect(titles(w.lastList().rows!)).toContain("Rose Perfume 50ml");
      expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 1]]); // untouched
      expect(w.ctx()!.lastCartItem).toMatchObject({ productId: "pearl-stud" });

      await w.say("make that 3");
      expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 3]]); // an absolute set on the earrings, not the perfume
      await w.say("the first one");
      expect(w.conversation.activeProductId).toBe("perfume"); // the new list is still the live one
    });

    it("category browsing starts a fresh topic but keeps the last cart item", async () => {
      await w.say("hi");
      await w.say("pearl earrings");
      await w.tap("quickadd_ps-1");
      await w.tap("nav_continue"); // Keep Shopping
      expect(w.ctx()).toMatchObject({ lastCartItem: { productId: "pearl-stud" } });
      expect(w.ctx()!.filters.keywords).toEqual([]);
      await w.tap("cat_cat-gift");
      await w.say("make that 2");
      expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 2]]);
    });
  });

  describe("12. no results, budget-only-above, and failures — truthful, and never invented", () => {
    it("a product that isn't stocked: plain no-match, no list, state stays usable", async () => {
      await w.say("hi");
      await w.say("do you have unicorn saddles");
      expect(w.lastSent().body).toContain('couldn\'t find anything matching "unicorn saddles"');
      expect(w.sent.some((s) => s.kind === "list")).toBe(false);
      expect(w.conversation.shoppingState).toBe("BROWSING_PRODUCTS");
      await w.say("pearl earrings"); // and the very next ask works normally
      expect(w.lastList().rows!.length).toBeGreaterThan(0);
    });

    it("the product exists only above the budget: says so with the lowest price, shows NOTHING over budget, and the next refinement works", async () => {
      await w.say("hi");
      await w.say("pearl earrings under 500");
      const msg = w.lastSent();
      expect(msg.kind).toBe("buttons");
      expect(msg.body).toContain('within INR 500');
      expect(msg.body).toContain("starts at INR 799");
      expect(w.sent.some((s) => s.kind === "list")).toBe(false);

      await w.say("under 1000");
      expect(titles(w.lastList().rows!)).toEqual(["Pearl Stud Earrings"]);
    });

    it("a catalogue lookup failure is reported as a failure (not 'no match'), with context and cart untouched", async () => {
      await w.say("hi");
      await w.say("pearl earrings");
      await w.tap("quickadd_ps-1");
      const ctxBefore = JSON.stringify(w.ctx());
      w.state.failNextProductQuery = new Error("connection reset");

      await w.say("do you have a rose perfume?");
      expect(w.lastSent().body).toContain("trouble searching");
      expect(w.lastSent().body).not.toContain("couldn't find");
      expect(JSON.stringify(w.ctx())).toBe(ctxBefore);
      expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 1]]);

      await w.say("do you have a rose perfume?"); // recovers on the next try
      expect(titles(w.lastList().rows!)).toContain("Rose Perfume 50ml");
    });

    it("a genuinely ambiguous ask gets exactly ONE clarifying question and no product dump", async () => {
      await w.say("hi");
      await w.say("something nice");
      expect(w.lastSent().kind).toBe("message");
      expect((w.lastSent().body.match(/\?/g) ?? []).length).toBe(1);
      expect(w.sent.some((s) => s.kind === "list")).toBe(false);
    });

    it("'show me something cheaper' with nothing to be cheaper than asks what to search for", async () => {
      await w.say("hi");
      await w.say("show me something cheaper");
      expect(w.lastSent().body).toContain("Cheaper than what?");
    });
  });

  describe("'cheaper' tightens the current search below what was shown", () => {
    it("retains the product intent and adds a budget below the shown prices", async () => {
      await w.say("hi");
      await w.say("earrings");
      const shown = w.lastList().rows!.map((r) => w.priceOfRow(r.id)).sort((a, b) => a - b);
      expect(shown.length).toBeGreaterThan(2);
      await w.say("show me something cheaper");
      const list = w.lastList();
      expect(w.ctx()!.filters.keywords).toEqual(["earrings"]);
      const ceiling = w.ctx()!.filters.maxPrice as number;
      expect(ceiling).toBeLessThan(shown[shown.length - 1]);
      expect(list.rows!.length).toBeGreaterThan(0);
      for (const r of list.rows!) expect(w.priceOfRow(r.id)).toBeLessThanOrEqual(ceiling);
      w.assertRowsAreRealRecords(list.rows!);
    });

    it("says so honestly when nothing is cheaper, instead of repeating the same products", async () => {
      await w.say("hi");
      await w.say("heels"); // Nude Block Heels INR 1,499 and Black Strappy Heels — nothing for heels below the cheapest shown
      w.sent.length = 0;
      await w.say("show me something cheaper");
      expect(w.sent.some((s) => s.kind === "list")).toBe(false);
      expect(w.lastSent().body).toMatch(/don't have anything|lowest/i);
    });
  });

  describe("13. everything shown corresponds to real records — even with a model in the loop", () => {
    const routerWith = (reading: Record<string, unknown>) => ({ generate: jest.fn().mockResolvedValue({ text: JSON.stringify(reading) }) }) as unknown as AiModelRouterService & { generate: jest.Mock };
    const reading = { intent: "SEARCH", confidence: 0.85, topicRelation: "NEW_TOPIC", productTerms: [], expandedTerms: ["perfume", "clutch", "unicorn"], occasion: "date night", recipient: null, style: null, material: null, budgetMin: null, budgetMax: 100, clarificationQuestion: null };

    it("uses the model's broadening terms to widen a failed search, but shows only real products, ignores a budget it invented, and ignores terms nothing matches", async () => {
      const router = routerWith(reading);
      w = buildWorld({ router });
      await w.say("hi");
      await w.say("a date night gift");

      expect(router.generate).toHaveBeenCalledTimes(1);
      const list = w.lastList();
      expect(titles(list.rows!)).toEqual(expect.arrayContaining(["Rose Perfume 50ml", "Leather Clutch"]));
      expect(titles(list.rows!).join(" ")).not.toMatch(/unicorn/i);
      expect(w.ctx()!.filters.maxPrice).toBeUndefined(); // "100" never appeared in the customer's message
      w.assertRowsAreRealRecords(list.rows!);
    });

    it("falls back to the deterministic reading — still budget-safe — when the model fails", async () => {
      const router = { generate: jest.fn().mockRejectedValue(new Error("model unavailable")) } as unknown as AiModelRouterService;
      w = buildWorld({ router });
      await w.say("hi");
      await w.say("a date night gift under ₹1,500");
      const list = w.lastList();
      for (const r of list.rows!) expect(w.priceOfRow(r.id)).toBeLessThanOrEqual(1500);
      w.assertRowsAreRealRecords(list.rows!);
    });

    it("a model that returns junk (unknown intent, injected text) is ignored entirely", async () => {
      const router = routerWith({ intent: "DROP_TABLE", confidence: 5, topicRelation: "NEW_TOPIC" });
      w = buildWorld({ router });
      await w.say("hi");
      await w.say("a date night gift");
      w.assertRowsAreRealRecords(w.lastList().rows!);
    });

    it("recommendation cards from the free-text engine pair each product's own name, price and image", async () => {
      w = buildWorld();
      w.products.find((p) => p.id === "pearl-stud")!.imageUrl = "/uploads/products/stud.jpg";
      const sendButtons = jest.spyOn(w.conversations, "sendButtons");
      await w.assisted.handle(CONV, BIZ, CUSTOMER, "pearl earrings under 1000");
      const stud = sendButtons.mock.calls.find((c) => (c[2] as string).includes("Pearl Stud Earrings"))!;
      expect(stud[2]).toContain("INR 799");
      expect(stud[4]).toContain("stud.jpg");
      expect(sendButtons.mock.calls.some((c) => (c[2] as string).includes("INR 8,999"))).toBe(false);
    });
  });

  describe("free-text engine (AssistedBuyingService) shares the same context and behaviour", () => {
    it("'other options' excludes what it already recommended, and a new topic drops the old budget", async () => {
      await w.assisted.handle(CONV, BIZ, CUSTOMER, "gold earrings under 2000");
      const first = w.ctx()!.lastResults.map((r: { name: string }) => r.name);
      expect(first).toContain("Gold Hoop Earrings");

      w.sent.length = 0;
      const handled = await w.assisted.handle(CONV, BIZ, CUSTOMER, "any other options?");
      if (handled) {
        const second = w.ctx()!.lastResults.map((r: { name: string }) => r.name);
        expect(second.filter((n: string) => first.includes(n))).toEqual([]);
      }

      await w.assisted.handle(CONV, BIZ, CUSTOMER, "Do you have a navy saree?");
      expect(w.ctx()!.filters).toEqual({ keywords: ["saree"] }); // no earrings, no ₹2,000
      expect(w.ctx()!.color).toBe("navy"); // colour lives in its own replaceable slot, not the keywords
      expect(w.ctx()!.recommendations).toEqual(w.ctx()!.lastResults); // legacy alias kept in step
    });

    it("its context can be read by the deterministic flow (one shared shape)", async () => {
      await w.assisted.handle(CONV, BIZ, CUSTOMER, "pearl earrings");
      w.conversation.shoppingState = "BROWSING_PRODUCTS"; // the customer then taps something that moves them into the button flow
      await w.say("show me the second one");
      expect(w.conversation.activeProductId).toBe(w.ctx()!.lastResults[1].productId);
    });
  });
});

describe("WhatsApp end-to-end findings — the customer's exact phrasing", () => {
  const stock = (): FakeProduct[] => [
    ...catalogue(),
    product("b-clutch", "Black Evening Clutch", "cat-gift", "A compact black clutch", [{ id: "bclutch-1", price: 1399 }]),
    product("b-kurta", "Black Silk Kurta", "cat-occ", "A black festive kurta", [{ id: "bkurta-1", price: 2999 }]),
    product("b-onyx", "Black Onyx Necklace", "cat-jew", "A black onyx pendant necklace", [{ id: "bonyx-1", price: 1599 }]),
    product("b-belt", "Black Leather Belt", "cat-gift", "A black leather belt", [{ id: "bbelt-1", price: 999 }]),
    product("b-shawl", "Black Pashmina Shawl", "cat-occ", "A black pashmina shawl", [{ id: "bshawl-1", price: 3499 }]),
    product("b-bracelet", "Black Pearl Bracelet", "cat-jew", "A black pearl bracelet", [{ id: "bbrace-1", price: 1199 }]),
    product("shirt-w", "Linen Shirt for Women", "cat-occ", "A relaxed linen shirt for women", [{ id: "shirt-w-1", price: 1699 }]),
    product("shirt-m", "Linen Shirt for Men", "cat-occ", "A breathable linen shirt for men", [{ id: "shirt-m-1", price: 1799 }]),
  ];
  let w: World;
  beforeEach(() => { clock = 0; w = buildWorld({ products: stock() }); });

  it("1. 'Do you have anything in black?' then 'Show me some other options.' — more black products, never a repeat", async () => {
    await w.say("hi");
    await w.say("Do you have anything in black?");
    const first = titles(w.lastList().rows!);
    expect(w.ctx()!.color).toBe("black");
    expect(first.length).toBeGreaterThan(0);
    for (const t of first) expect(t).toMatch(/black/i);
    w.assertRowsAreRealRecords(w.lastList().rows!);

    await w.say("Show me some other options.");
    const second = titles(w.lastList().rows!);
    expect(second.length).toBeGreaterThan(0);
    for (const t of second) expect(t).toMatch(/black/i);
    expect(second.filter((t) => first.includes(t))).toEqual([]);
    w.assertRowsAreRealRecords(w.lastList().rows!);
  });

  it("2. black search, then 'Actually, do you have pearl earrings?' — no stale colour, category or occasion", async () => {
    await w.say("hi");
    await w.say("Do you have anything in black?");
    await w.say("Actually, do you have pearl earrings?");
    const list = w.lastList();
    expect(w.ctx()!.filters.keywords).toEqual(["pearl", "earrings"]);
    expect(w.ctx()!.color).toBeUndefined();
    expect(w.ctx()!.occasion).toBeUndefined();
    expect(list.body).not.toContain("Nothing matched exactly");
    for (const t of titles(list.rows!)) expect(t).toMatch(/pearl.*earrings/i);
    expect(titles(list.rows!)).toContain("Pearl Stud Earrings");
    w.assertRowsAreRealRecords(list.rows!);
  });

  it("2b. …and the occasion and the budget of the earlier request are gone too", async () => {
    await w.say("hi");
    await w.say("I need a black outfit for a wedding under ₹3,000");
    expect(w.ctx()!.filters.maxPrice).toBe(3000);
    await w.say("Actually, do you have pearl earrings?");
    expect(w.ctx()!.filters.maxPrice).toBeUndefined();
    expect(w.ctx()!.occasion).toBeUndefined();
    expect(w.ctx()!.color).toBeUndefined();
    expect(titles(w.lastList().rows!)).toContain("Diamond Pearl Earrings"); // ₹8,999 — proof the old ceiling did not leak
  });

  it("3. \"I'm looking for a gift for date night.\" — a gift for an occasion, not a search for the words 'looking' or 'I'm'", async () => {
    await w.say("hi");
    await w.say("I'm looking for a gift for date night.");
    const list = w.lastList();
    expect(w.ctx()!.occasion).toBe("date night");
    expect(w.ctx()!.filters.keywords.join(" ")).not.toMatch(/looking|i'm|\bim\b/);
    expect(titles(list.rows!)).toEqual(expect.arrayContaining(["Rose Perfume 50ml"]));
    w.assertRowsAreRealRecords(list.rows!);
  });

  it("4. 'Show me some jewellery options.' — a diverse set of real jewellery, with 'some' and 'options' ignored", async () => {
    await w.say("hi");
    await w.say("Show me some jewellery options.");
    const list = w.lastList();
    expect(w.ctx()!.filters.keywords).toEqual(["jewellery"]);
    expect(list.body).not.toContain("Nothing matched exactly");
    const shown = list.rows!.map((r) => w.productById(r.id.replace("prod_", "")));
    expect(shown.length).toBeGreaterThanOrEqual(4);
    for (const p of shown) expect(p.categoryId).toBe("cat-jew");
    expect(shown.some((p) => /necklace/i.test(p.name)) && shown.some((p) => /earrings/i.test(p.name))).toBe(true); // more than one kind of piece
    w.assertRowsAreRealRecords(list.rows!);
  });

  it("5. 'I like the second one' selects the second item of the LATEST list — and verifies it still exists", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    const firstList = w.ctx()!.lastResults;
    await w.say("I like the second one");
    expect(w.conversation.activeProductId).toBe(firstList[1].productId);

    await w.say("pearl earrings under 1300"); // a shorter, newer list
    const latest = w.ctx()!.lastResults;
    await w.say("I like the second one");
    expect(w.conversation.activeProductId).toBe(latest[1].productId);

    w.productById(latest[0].productId).status = "DRAFT"; // the merchant hides it after it was shown
    await w.say("I like the first one");
    expect(w.lastSent().body).toContain("no longer available");
    expect(w.conversation.activeProductId).not.toBe(latest[0].productId);
  });

  it("6. 'For men' while awaiting a quantity is a new request — not a quantity — and only men's products come back", async () => {
    await w.say("hi");
    await w.say("linen shirt");
    await w.tap("prod_shirt-w");
    expect(w.conversation.shoppingState).toBe("AWAITING_QUANTITY");

    await w.say("For men");
    expect(w.addItemCalls).toEqual([]);
    expect(w.conversation.shoppingState).not.toBe("AWAITING_QUANTITY");
    expect(w.ctx()!.gender).toBe("men");
    expect(titles(w.lastList().rows!)).toEqual(["Linen Shirt for Men"]); // "for women" contains the letters "men" — it must not match
    w.assertRowsAreRealRecords(w.lastList().rows!);
  });

  it("6b. 'I like the second one' while a quantity is awaited picks the second product — it is never read as a quantity of one", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    const list = w.ctx()!.lastResults;
    await w.tap("prod_pearl-drop");
    expect(w.conversation.shoppingState).toBe("AWAITING_QUANTITY");

    await w.say("I like the second one");
    expect(w.addItemCalls).toEqual([]);
    expect(w.carts.every((c) => c.items.size === 0)).toBe(true);
    expect(w.conversation.activeProductId).toBe(list[1].productId);
  });

  it("6c. a gender stays part of 'other options' — women's products never turn up for a men's search", async () => {
    w.products.push(product("shirt-m2", "Denim Shirt for Men", "cat-occ", "A sturdy denim shirt for men", [{ id: "shirt-m2-1", price: 2099 }]));
    await w.say("hi");
    await w.say("shirt for men");
    const first = titles(w.lastList().rows!);
    expect(first.sort()).toEqual(["Denim Shirt for Men", "Linen Shirt for Men"]);

    await w.say("show me some other options");
    for (const list of w.sent.filter((s) => s.kind === "list")) for (const t of titles(list.rows!)) expect(t).not.toMatch(/women/i);
    expect(w.ctx()!.gender).toBe("men");
  });

  it("6d. 'anything in black' matches a black VARIANT even when the product's own text never says black", async () => {
    w = buildWorld({
      products: [
        product("tote", "Evening Tote", "cat-gift", "A roomy everyday tote", [{ id: "tote-1", price: 1999, attributes: { color: "black" } }]),
        product("purse", "Silver Purse", "cat-gift", "A small purse", [{ id: "purse-1", price: 1499, attributes: { color: "silver" } }]),
      ],
    });
    await w.say("hi");
    await w.say("Do you have anything in black?");
    expect(titles(w.lastList().rows!)).toEqual(["Evening Tote"]);
    expect(w.lastList().rows![0].description).toContain("in black");

    await w.say("Do you have anything in red?");
    expect(w.lastSent().kind).toBe("buttons");
    expect(w.lastSent().body).toContain("couldn't find anything matching");
  });

  it("7. 'Something cheaper.' keeps the product context and lowers the budget below the product being viewed", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    await w.tap("prod_pearl-drop"); // ₹1,199
    await w.say("Something cheaper.");
    expect(w.ctx()!.filters.keywords).toEqual(["pearl", "earrings"]);
    expect(w.ctx()!.filters.maxPrice).toBe(1198);
    expect(titles(w.lastList().rows!)).toEqual(["Pearl Stud Earrings"]);
  });

  it.each([
    ["pearl earrings under 1000", 1000],
    ["I need a gift under ₹1,500", 1500],
    ["show me some jewellery under 1600", 1600],
    ["a black outfit under 3000", 3000],
    ["something for a wedding up to ₹3,000", 3000],
    ["gold earrings below 1500", 1500],
  ])("8. '%s' never shows a product above %i", async (phrase, ceiling) => {
    // a row's price is the lowest in-stock variant price of that product — looked up in the catalogue, not in the latest context
    const rowPrice = (rowId: string) => Math.min(...w.productById(rowId.replace("prod_", "")).variants.filter((v) => v.active && (v.inventory === null || v.inventory > 0)).map((v) => v.price));
    await w.say("hi");
    await w.say(phrase);
    for (const l of w.sent.filter((s) => s.kind === "list")) for (const r of l.rows!) expect(rowPrice(r.id)).toBeLessThanOrEqual(ceiling);
    // …and the follow-ups that re-run the search keep honouring it
    await w.say("show me some other options");
    for (const l of w.sent.filter((s) => s.kind === "list")) for (const r of l.rows!) expect(rowPrice(r.id)).toBeLessThanOrEqual(ceiling);
  });

  it("9. an unavailable colour is reported honestly and nothing is presented as that colour", async () => {
    await w.say("hi");
    await w.say("Do you have pearl earrings in red?");
    const text = w.sent.map((s) => s.body).join("\n");
    expect(text).toMatch(/red/i);
    const rows = w.sent.filter((s) => s.kind === "list").flatMap((s) => s.rows!);
    for (const r of rows) expect(r.description ?? "").not.toMatch(/\bin red\b/i);
    expect(w.lastSent().body).not.toMatch(/here (is|are) .*red/i);
    if (rows.length) expect(w.sent.some((s) => /doesn't come in red|isn't available in red|no red|not .*red|in red/i.test(s.body))).toBe(true);
  });

  it("10. the cart survives a new session on another day, and a change of topic", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    await w.tap("quickadd_ps-1");
    await w.tap("quickadd_pd-1");
    const inCart = () => [...w.carts.find((c) => c.status === "ACTIVE")!.items.entries()];
    expect(inCart()).toEqual([["ps-1", 1], ["pd-1", 1]]);

    // the next day: the conversation is at rest and yesterday's search context is gone
    Object.assign(w.conversation, { shoppingState: "IDLE", assistedBuyingContext: null, activeProductId: null, pendingVariantId: null, activeCategoryId: null });
    await w.say("hi");
    await w.tap("nav_viewcart");
    const cartMessage = w.sent.filter((s) => s.body.includes("Your Cart")).pop()!;
    expect(cartMessage.body).toContain("Pearl Stud Earrings");
    expect(cartMessage.body).toContain("Pearl Drop Earrings");

    await w.say("do you have a rose perfume?");
    await w.say("Actually show me some jewellery options");
    await w.say("I like the first one");
    expect(inCart()).toEqual([["ps-1", 1], ["pd-1", 1]]);

    await w.tap("cart_checkout"); // and the cart is still what checkout works on
    expect(w.conversation.shoppingState).toBe("COLLECTING_ADDRESS");
  });

  it("11. a stale, hidden or non-existent product/variant id can never be added to the cart", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    const stud = w.productById("pearl-stud");

    stud.status = "DRAFT"; // hidden by the merchant after it was shown
    await w.tap("quickadd_ps-1");
    expect(w.lastSent().body).toMatch(/no longer available/i);
    stud.status = "PUBLISHED";

    stud.variants[0].active = false; // variant switched off
    await w.tap("quickadd_ps-1");
    expect(w.lastSent().body).toMatch(/no longer available/i);
    stud.variants[0].active = true;

    for (const id of ["quickadd_deleted-variant", "variant_deleted-variant", "prod_deleted-product"]) {
      await w.tap(id);
      expect(w.lastSent().body).toMatch(/no longer available/i);
    }
    expect(w.carts.every((c) => c.items.size === 0)).toBe(true);
  });

  it("11b. a quantity typed for a product that was hidden while the prompt was open is refused, and the prompt is closed", async () => {
    await w.say("hi");
    await w.say("pearl earrings");
    await w.tap("prod_pearl-stud");
    expect(w.conversation.shoppingState).toBe("AWAITING_QUANTITY");

    w.productById("pearl-stud").status = "DRAFT";
    await w.say("2");
    expect(w.lastSent().body).toMatch(/no longer available/i);
    expect(w.carts.every((c) => c.items.size === 0)).toBe(true);
    expect(w.conversation.shoppingState).not.toBe("AWAITING_QUANTITY");
    expect(w.conversation.pendingVariantId).toBeNull();
  });
});

describe("11. repeated button/webhook delivery never duplicates cart items or orders", () => {
  const phoneNumberId = "PHONE1";
  const waMsg = (overrides: Partial<ParsedWhatsAppMessage>): ParsedWhatsAppMessage => ({ phoneNumberId, from: "911234567890", waMessageId: "wamid.1", text: "", interactiveId: null, displayName: "Asha", timestamp: new Date(), ...overrides });

  function webhookWorld() {
    const world = buildWorld();
    const seen = new Set<string>();
    const prisma: any = {
      ...world.prisma,
      business: { findFirst: async () => ({ id: BIZ, whatsappPhoneNumberId: phoneNumberId }), findUnique: world.prisma.business.findUnique },
      customer: { findFirst: async () => ({ id: CUSTOMER }), create: jest.fn() },
      identity: { upsert: async () => ({ id: "ident1" }) },
      conversation: { ...world.prisma.conversation, create: jest.fn(), count: async () => 1 },
      message: {
        findFirst: async () => null,
        // the unique index on providerMessageId
        create: async ({ data }: { data: { providerMessageId: string } }) => {
          await Promise.resolve(); // yield, so concurrent deliveries genuinely interleave
          if (seen.has(data.providerMessageId)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
          seen.add(data.providerMessageId);
          return {};
        },
      },
      activityEvent: { create: async () => ({}) },
      order: { count: async () => 0 },
      leadScore: { upsert: async () => ({}) },
    };
    prisma.conversation.findFirst = async () => ({ ...world.conversation });
    const ai = { generateAndSendReply: jest.fn() };
    const service = new WhatsAppWebhookService(prisma, { scheduleFollowUp: jest.fn() } as any, ai as any, world.flow, { canUseRelay: async () => true } as any);
    return { ...world, service, ai, deliver: (m: ParsedWhatsAppMessage) => (service as any).processMessage(m) };
  }

  it("the same 'Add to Cart' tap delivered several times, concurrently and later, adds the item once", async () => {
    const w = webhookWorld();
    const tap = waMsg({ interactiveId: "quickadd_ps-1", text: "🛒 Add to Cart", waMessageId: "wamid.TAP1" });

    await Promise.all([w.deliver(tap), w.deliver(tap), w.deliver(tap)]);
    await w.deliver(tap);

    expect(w.addItemCalls).toEqual([{ variantId: "ps-1", quantity: 1 }]);
    expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 1]]);
  });

  it("two genuine, separate taps are two intended actions (different message ids) — duplicates are only the SAME delivery", async () => {
    const w = webhookWorld();
    await w.deliver(waMsg({ interactiveId: "quickadd_ps-1", waMessageId: "wamid.A" }));
    await w.deliver(waMsg({ interactiveId: "quickadd_ps-1", waMessageId: "wamid.B" }));
    expect([...w.carts[0].items.entries()]).toEqual([["ps-1", 2]]);
  });

  it("Confirm Order tapped twice (even as two different deliveries) places exactly one order", async () => {
    const w = webhookWorld();
    await w.deliver(waMsg({ interactiveId: "quickadd_ps-1", waMessageId: "wamid.ADD" }));
    Object.assign(w.conversation, { shoppingState: "ORDER_CONFIRMATION", pendingAddress: "12 Rose Street, Bengaluru", pendingPaymentMethod: "COD" });

    await Promise.all([w.deliver(waMsg({ interactiveId: "order_confirm", waMessageId: "wamid.CONFIRM1" })), w.deliver(waMsg({ interactiveId: "order_confirm", waMessageId: "wamid.CONFIRM1" }))]);
    await w.deliver(waMsg({ interactiveId: "order_confirm", waMessageId: "wamid.CONFIRM2" })); // an impatient second tap: new delivery, but nothing left to confirm

    expect(w.orders).toHaveLength(1);
    expect(w.lastSent().body).toContain("already been placed"); // told so, rather than restarting checkout on an empty cart
    expect(w.orders[0].items).toEqual([["ps-1", 1]]);
    expect(w.carts.filter((c) => c.status === "CHECKED_OUT")).toHaveLength(1);
  });

  it("a plain-text search delivered twice replies once", async () => {
    const w = webhookWorld();
    await w.say("hi");
    const search = waMsg({ text: "pearl earrings", waMessageId: "wamid.SEARCH" });
    await Promise.all([w.deliver(search), w.deliver(search)]);
    expect(w.sent.filter((s) => s.kind === "list")).toHaveLength(1);
  });
});
