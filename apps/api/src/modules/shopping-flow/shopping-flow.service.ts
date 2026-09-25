import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { CartService } from "../cart/cart.service";
import { OrderService } from "../orders/order.service";
import { toPublicImageUrl } from "../products/image-storage";
import { CustomerSignalService } from "../customer-signals/customer-signal.service";

const MAX_LIST_ROWS = 10;

// ordinal words a customer might use to refer back to a just-shown result list ("show me the first one")
const ORDINAL_WORDS: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4,
};

// stopwords stripped before matching search keywords against product name/description/category — includes
// vague filler words ("something", "anything", "nice", "good") so e.g. "show me something under 1500" is
// treated as a budget-only query instead of literally searching the catalogue for the word "something";
// generic catalogue nouns/question words ("what", "which", "products", "items") so e.g. "What fashion products
// do you have?" extracts just the real constraint ("fashion"); and pure grammar words (prepositions, modal
// verbs, relative pronouns, conjunctions) that occasion-style questions are full of ("I'm going ON vacation,
// WHAT WOULD you recommend?", "classy BUT NOT TOO expensive", "someone WHO loves coffee") but that are never
// themselves a searchable product attribute
const SEARCH_STOPWORDS = new Set([
  "show", "me", "i", "want", "need", "looking", "for", "a", "an", "the", "do", "you", "have", "any", "some",
  "please", "find", "search", "got", "is", "are", "there", "something", "anything", "nice", "good",
  "what", "which", "products", "product", "items", "item",
  "on", "in", "would", "who", "someone", "but", "not", "too", "going", "recommend", "attending", "suitable", "loves",
  "preferably", "prefer", "ideally",
]);

// messages asking what the store carries at all, rather than searching for something specific — must be
// checked before running a keyword search, otherwise e.g. "What do you sell?" gets searched literally and
// returns "No products matched that search."
export const STORE_DISCOVERY_RE = /\b(what do you (sell|offer|have|stock)|what (products?|items?|categories?) do you (have|sell|offer|stock)|what (products?|items?|categories?) (are (available|there)|do you have)|show me (your|the) (products?|catalogue|catalog|store|items?)|what can i (buy|get|purchase)|what do you (guys )?have)\b/i;

// "Tell me more about X" / "More details on X" — asks about ONE specific product by name, not a general
// search; the captured group is the product name/reference text to resolve against the catalogue
const PRODUCT_DETAILS_RE = /\b(?:tell me (?:more )?about|more (?:details|info(?:rmation)?) (?:on|about)|details (?:on|about))\s+(.+)/i;

// pronoun follow-ups ("How much IS IT?", "IS IT available?", "what colours do you have?") that only make sense
// anchored to whichever product the customer is already looking at (Conversation.activeProductId)
const PRICE_FOLLOWUP_RE = /\b(how much (is|does it cost|for it)|what('?s| is) the price|price\??)\b/i;
const AVAILABILITY_FOLLOWUP_RE = /\b(is it available|in stock|do you have (it|this) in stock|is (it|this) in stock)\b/i;
const OPTIONS_FOLLOWUP_RE = /\b(what colou?rs?|which colou?rs?|colou?r options|what sizes|which sizes|size options|what options|available options)\b/i;

// "Is there anything similar but cheaper?" — a recommendation relative to whichever product is currently in view
const SIMILAR_RE = /\bsimilar\b/i;
const CHEAPER_RE = /\b(cheaper|less expensive|lower price|budget|affordable)\b/i;

// "Which one would you recommend?" — asks for a pick among whatever was just shown, not a fresh search;
// deliberately requires "which one/option" (not just "what would you recommend", which is an open-ended
// occasion-style request that should still run as a normal search — see Test 2's "going on vacation" case)
const RECOMMEND_PICK_RE = /\bwhich (one|option) (would you|do you|should i) (recommend|choose|pick|go with)\b/i;

// "Compare X and Y" / "What's the difference between X and Y?" — a fresh comparison request naming two
// products; strips everything up to the trigger phrase, leaving "X and Y" to split and resolve by name
const COMPARISON_RE = /\b(compare|difference between)\b/i;
const STRIP_COMPARISON_PREFIX_RE = /^.*?\b(?:compare|difference between)\b/i;
const SPLIT_COMPARISON_SEGMENTS_RE = /\s+(?:and|vs\.?|versus)\s+/i;

// "Which is cheaper?" / "Which one is better for casual wear?" / "Which watch would make a better gift?" —
// a follow-up about whichever pair was JUST compared, not a fresh search for the word "cheaper"/"better"
const COMPARISON_FOLLOWUP_RE = /^\s*which\b.*\b(cheaper|better|nicer|suitable|affordable|gift|choice|value)\b/i;
const FOLLOWUP_CHEAPER_RE = /\b(cheap|afford|value|lower price)\w*\b/i;

interface SearchFilters { maxPrice?: number; minPrice?: number; keywords: string[] }

// accumulated across turns on Conversation.assistedBuyingContext (reused across services since only one of
// ShoppingFlowService/AssistedBuyingService is ever active per conversation, gated by shoppingState) so a
// multi-turn refinement ("I need a shirt" / "something casual" / "preferably blue" / "under 1500") combines
// into one search instead of each message overwriting the last, and "show me the first one" can resolve
// against whatever was last shown
interface ShoppingSearchContext {
  filters: SearchFilters;
  lastResults: { productId: string; variantId: string; name: string }[];
  comparedProductIds?: string[];
}

/** Deterministic (non-LLM) parsing for queries like "black shoes under 2500" or "jackets above 1000". */
export function parseSearchQuery(text: string): SearchFilters {
  let remaining = text.toLowerCase();
  let maxPrice: number | undefined;
  let minPrice: number | undefined;

  const under = remaining.match(/(?:under|below|less than|cheaper than|within)\s*(?:rs\.?|inr|₹)?\s*(\d+)/);
  if (under) { maxPrice = Number(under[1]); remaining = remaining.replace(under[0], " "); }
  const over = remaining.match(/(?:over|above|more than)\s*(?:rs\.?|inr|₹)?\s*(\d+)/);
  if (over) { minPrice = Number(over[1]); remaining = remaining.replace(over[0], " "); }

  const keywords = remaining.split(/[^a-z0-9]+/).map((w) => w.trim()).filter((w) => w.length > 1 && !SEARCH_STOPWORDS.has(w));
  return { maxPrice, minPrice, keywords };
}

// crude singular/plural normalization ("bags" <-> "bag") so a keyword also matches a product literally named
// with the other form (e.g. a search for "shirts" still matches a product named "Black Premium Shirt") without
// needing a real stemming library for this deterministic V1
function normalizeSearchWord(word: string): string {
  return word.toLowerCase().replace(/s$/, "");
}

/**
 * One AND-clause per keyword (each independently required — this is what fixes "black bag" matching a "Black
 * Premium Shirt": the shirt satisfies the "black" clause but has no "bag" anywhere, so the AND across both
 * keywords correctly excludes it). Each keyword is OR'd across name/description/brand/category-name, trying
 * both its literal form and its singular-normalized form, since Prisma's `contains` has no stemming.
 *
 * Deliberately does NOT hard-filter by resolving a keyword to a categoryId: a business's actual product→category
 * assignment can't be trusted to match what a customer calls something in conversation (e.g. a black shirt
 * filed under a generic "Fashion" category rather than "Shirts") — a hard filter would silently exclude a real
 * match instead of just deprioritizing it, which is worse than the original bug this replaced.
 */
export function keywordAndClauses(keywords: string[]) {
  return keywords.map((kw) => {
    const variants = Array.from(new Set([kw, normalizeSearchWord(kw)]));
    return {
      OR: variants.flatMap((v) => [
        { name: { contains: v, mode: "insensitive" as const } },
        { description: { contains: v, mode: "insensitive" as const } },
        { brand: { contains: v, mode: "insensitive" as const } },
        { category: { name: { contains: v, mode: "insensitive" as const } } },
      ]),
    };
  });
}

// thousands-grouped price string (WhatsApp text/captions render *bold*/_italic_ markdown, but list row titles/descriptions do not)
// accepts Prisma's Decimal (product/variant prices) as well as plain number/string
export function fmtMoney(amount: number | string | { toString(): string }, currency: string): string {
  const n = Number(amount.toString());
  return `${currency} ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

const OUT_OF_STOCK_SUFFIX = " · Out of stock";

export function formatVariantLabel(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const values = Object.values(attributes as Record<string, string>).filter(Boolean);
  return values.length ? values.join(", ") : null;
}

/**
 * Deterministic WhatsApp shopping flow (menu → categories → products → variant → quantity → cart → checkout),
 * driven entirely by button/list taps plus a few plain-text replies (quantity, address) — no LLM calls, since
 * navigation doesn't need one. Free-text questions/search still fall through to the existing AI assistant.
 */
@Injectable()
export class ShoppingFlowService {
  private readonly logger = new Logger(ShoppingFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly cart: CartService,
    private readonly orders: OrderService,
    private readonly signals: CustomerSignalService,
  ) {}

  async sendMainMenu(conversationId: string, businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    await this.conversations.sendButtons(conversationId, businessId, `Hi there! 👋\nWelcome to *${business?.name ?? "our store"}*.\nWhat would you like to do today?`, [
      { id: "menu_shop", title: "🛍️ Shop" },
      { id: "menu_cart", title: "🛒 View Cart" },
      { id: "menu_orders", title: "📦 My Orders" },
    ]);
    // fresh greeting -> drop any search filters/results gathered in an earlier session so they can't silently bleed into a new one
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "MAIN_MENU", assistedBuyingContext: Prisma.JsonNull } });
  }

  async handleInteractive(conversationId: string, businessId: string, actionId: string) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId } });
    if (!conversation || conversation.escalated) return;

    if (actionId === "menu_shop") return this.showShop(conversationId, businessId);
    if (actionId === "menu_cart") return this.showCart(conversationId, businessId, conversation.customerId);
    if (actionId === "menu_orders") return this.showOrders(conversationId, businessId, conversation.customerId);
    if (actionId.startsWith("cat_")) return this.showProducts(conversationId, businessId, actionId.slice(4));
    if (actionId.startsWith("prod_")) return this.showProductDetail(conversationId, businessId, actionId.slice(5), conversation.customerId);
    if (actionId.startsWith("variant_")) return this.askQuantity(conversationId, businessId, actionId.slice(8));
    if (actionId === "cart_checkout") return this.beginCheckout(conversationId, businessId, conversation.customerId);
    if (actionId === "cart_clear") return this.clearCart(conversationId, businessId, conversation.customerId);
    // "Keep Shopping" always returns to the top-level category list/full catalog, not the last-viewed
    // category — otherwise a customer who drilled into one category stays pinned there indefinitely
    if (actionId === "nav_continue") return this.showShop(conversationId, businessId);
    if (actionId === "nav_viewcart") return this.showCart(conversationId, businessId, conversation.customerId);
    if (actionId === "pay_upi") return this.setPaymentMethod(conversationId, businessId, "UPI");
    if (actionId === "pay_cod") return this.setPaymentMethod(conversationId, businessId, "COD");
    if (actionId === "pay_card") return this.setPaymentMethod(conversationId, businessId, "CARD");
    if (actionId === "order_confirm") return this.confirmOrder(conversationId, businessId, conversation);
    if (actionId === "order_cancel") return this.cancelCheckout(conversationId, businessId);
    // "Maybe Later" on a proactive product suggestion (back-in-stock/cross-sell/upsell) — just a polite acknowledgement, no state change
    if (actionId === "suggestion_dismiss") return this.conversations.sendMessage(conversationId, businessId, "No worries! We'll keep it in mind — let us know whenever you're ready 🙂");
  }

  /** Called for plain-text replies; returns true if this state consumed the text (caller should not also run the AI). */
  async handleFreeText(conversationId: string, businessId: string, conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown }, text: string): Promise<boolean> {
    if (conversation.shoppingState === "AWAITING_QUANTITY") {
      await this.receiveQuantity(conversationId, businessId, conversation, text);
      return true;
    }
    if (conversation.shoppingState === "COLLECTING_ADDRESS") {
      await this.receiveAddress(conversationId, businessId, text);
      return true;
    }
    if (conversation.shoppingState === "COLLECTING_PAYMENT" || conversation.shoppingState === "ORDER_CONFIRMATION") {
      if (/^\s*cancel\s*$/i.test(text)) { await this.cancelCheckout(conversationId, businessId); return true; }
      await this.conversations.sendMessage(conversationId, businessId, 'Please tap one of the buttons above to continue, or type "cancel" to stop checkout.');
      return true;
    }
    // browsing states (nothing in the order yet) treat free text as a product search; CART_REVIEW (and IDLE)
    // fall through to the free-text AI assistant instead, so a customer can still describe what else they want
    // in natural language once they have items in their cart — the AI flow merges those cart items back in
    if (["MAIN_MENU", "BROWSING_CATEGORIES", "BROWSING_PRODUCTS", "VIEWING_PRODUCT"].includes(conversation.shoppingState)) {
      const context = conversation.assistedBuyingContext as unknown as ShoppingSearchContext | null;
      await this.search(conversationId, businessId, conversation.customerId, text, context, conversation.activeProductId ?? null);
      return true;
    }
    return false;
  }

  /** Resolves "show me the first one"/"the second one" etc. against the product list from the customer's own last search — checked before treating those words as (nonsensical) literal search keywords. */
  private resolveOrdinalReference(text: string, context: ShoppingSearchContext | null): { productId: string; variantId: string; name: string } | null {
    if (!context?.lastResults?.length) return null;
    const lower = text.toLowerCase();
    for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
      if (idx < context.lastResults.length && new RegExp(`\\b${word}\\b`).test(lower)) return context.lastResults[idx];
    }
    return null;
  }

  /** Best-matching product among candidates that share some keyword overlap — used whenever a customer's own
   * phrasing (not an exact name) needs to resolve to a single, most-likely product. */
  private bestKeywordMatch<T extends { name: string; description: string | null; brand: string | null; category?: { name: string } | null }>(candidates: T[], keywords: string[]): T {
    const hits = (p: T) => {
      const haystack = `${p.name} ${p.description ?? ""} ${p.brand ?? ""} ${p.category?.name ?? ""}`.toLowerCase();
      return keywords.filter((kw) => haystack.includes(kw)).length;
    };
    return candidates.length === 1 ? candidates[0] : [...candidates].sort((a, b) => hits(b) - hits(a))[0];
  }

  /** "Tell me more about the Premium Cotton T-Shirt" — resolves the referenced product BY NAME and shows its
   * detail view directly, instead of running it as a generic catalogue search (which would treat "tell"/"more"/
   * "about" as literal, meaningless search keywords). Returns false (falls through to a normal search) if the
   * phrasing doesn't match, or if nothing in the catalogue matches the referenced name at all. */
  private async tryProductDetailsByName(conversationId: string, businessId: string, customerId: string, text: string): Promise<boolean> {
    const match = text.match(PRODUCT_DETAILS_RE);
    if (!match) return false;
    const { keywords } = parseSearchQuery(match[1].replace(/[?!.]+$/, ""));
    if (!keywords.length) return false;

    const candidates = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", AND: keywordAndClauses(keywords) },
      include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 }, category: true },
      take: 5,
    });
    if (!candidates.length) return false;

    await this.showProductDetail(conversationId, businessId, this.bestKeywordMatch(candidates, keywords).id, customerId);
    return true;
  }

  /** "Compare the Rose Gold Watch and Minimal Silver Watch" / "What's the difference between X and Y?" —
   * resolves BOTH named products and sends a grounded, template-only summary of their real catalogue facts
   * (name/price/stock/description) — never an invented claim about specs the catalogue doesn't have. Stores
   * the compared set so a follow-up ("Which is cheaper?") can resolve against it. */
  private async tryCompareProducts(conversationId: string, businessId: string, text: string): Promise<boolean> {
    if (!COMPARISON_RE.test(text)) return false;
    const remainder = text.replace(STRIP_COMPARISON_PREFIX_RE, "").replace(/[?!.]+$/, "").trim();
    const segments = remainder.split(SPLIT_COMPARISON_SEGMENTS_RE).map((s) => s.replace(/^\s*the\s+/i, "").trim()).filter(Boolean);
    if (segments.length < 2) return false;

    const resolved: { id: string; name: string; description: string | null; variants: { id: string; price: unknown; currency: string; inventory: number | null }[] }[] = [];
    for (const segment of segments.slice(0, 3)) {
      const { keywords } = parseSearchQuery(segment);
      if (!keywords.length) continue;
      const candidates = await this.prisma.product.findMany({
        where: { businessId, status: "PUBLISHED", AND: keywordAndClauses(keywords) },
        include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 }, category: true },
        take: 5,
      });
      if (candidates.length) resolved.push(this.bestKeywordMatch(candidates, keywords));
    }
    const withVariant = resolved.filter((p) => p.variants[0]);
    if (withVariant.length < 2) return false;

    const lines = withVariant.map((p) => `*${p.name}* — ${fmtMoney(p.variants[0].price as never, p.variants[0].currency)}${p.variants[0].inventory === 0 ? " (out of stock)" : ""}${p.description ? `\n_${p.description}_` : ""}`);
    await this.conversations.sendMessage(conversationId, businessId, lines.join("\n\n"));

    const context: ShoppingSearchContext = {
      filters: { keywords: [] },
      lastResults: withVariant.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })),
      comparedProductIds: withVariant.map((p) => p.id),
    };
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** "Which is cheaper?" / "Which one is better for casual wear?" / "Which watch would make a better gift?" —
   * a follow-up about whichever pair was just compared. Price is a real catalogue fact, so a "cheaper"
   * question gets a confident, grounded answer; subjective/occasion criteria (style, gifting) have no
   * catalogue signal at all, so rather than inventing one, restate the real facts instead. */
  private async tryComparisonFollowUp(conversationId: string, businessId: string, text: string, context: ShoppingSearchContext | null): Promise<boolean> {
    if (!COMPARISON_FOLLOWUP_RE.test(text.toLowerCase()) || !context?.comparedProductIds || context.comparedProductIds.length < 2) return false;

    const products = await this.prisma.product.findMany({
      where: { id: { in: context.comparedProductIds }, businessId },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } },
    });
    const withVariant = products.filter((p) => p.variants[0]);
    if (withVariant.length < 2) return false;

    if (FOLLOWUP_CHEAPER_RE.test(text)) {
      const [cheapest, next] = [...withVariant].sort((a, b) => Number(a.variants[0].price) - Number(b.variants[0].price));
      const diff = Number(next.variants[0].price) - Number(cheapest.variants[0].price);
      await this.conversations.sendMessage(conversationId, businessId, `*${cheapest.name}* is cheaper — ${fmtMoney(cheapest.variants[0].price, cheapest.variants[0].currency)} vs ${fmtMoney(next.variants[0].price, next.variants[0].currency)} (${fmtMoney(diff, cheapest.variants[0].currency)} less).`);
      return true;
    }

    const lines = withVariant.map((p) => `*${p.name}* — ${fmtMoney(p.variants[0].price, p.variants[0].currency)}${p.variants[0].inventory === 0 ? " (out of stock)" : ""}`);
    await this.conversations.sendMessage(conversationId, businessId, `I don't have enough detail in our catalogue to say which is definitively better for that — here's what I can confirm:\n\n${lines.join("\n\n")}\n\nLet me know if price or availability should be the deciding factor!`);
    return true;
  }

  /** Pronoun follow-ups ("How much IS IT?", "IS IT available?", "what colours do you have?") that only make
   * sense anchored to whichever product the customer is already looking at. */
  private async tryProductFollowUp(conversationId: string, businessId: string, text: string, activeProductId: string | null): Promise<boolean> {
    if (!activeProductId) return false;
    const lower = text.toLowerCase();
    if (!PRICE_FOLLOWUP_RE.test(lower) && !AVAILABILITY_FOLLOWUP_RE.test(lower) && !OPTIONS_FOLLOWUP_RE.test(lower)) return false;

    const product = await this.prisma.product.findFirst({ where: { id: activeProductId, businessId, status: "PUBLISHED" }, include: { variants: { where: { active: true } } } });
    if (!product?.variants.length) return false;

    if (PRICE_FOLLOWUP_RE.test(lower)) {
      const prices = product.variants.map((v) => Number(v.price));
      const currency = product.variants[0].currency;
      const priceText = Math.min(...prices) === Math.max(...prices)
        ? fmtMoney(prices[0], currency)
        : `${fmtMoney(Math.min(...prices), currency)} – ${fmtMoney(Math.max(...prices), currency)}`;
      await this.conversations.sendMessage(conversationId, businessId, `*${product.name}* is ${priceText}.`);
      return true;
    }
    if (AVAILABILITY_FOLLOWUP_RE.test(lower)) {
      const inStock = product.variants.some((v) => v.inventory === null || v.inventory > 0);
      await this.conversations.sendMessage(conversationId, businessId, inStock ? `Yes, *${product.name}* is currently in stock! 🎉` : `😔 Sorry, *${product.name}* is currently out of stock.`);
      return true;
    }
    // OPTIONS_FOLLOWUP_RE
    const options = Array.from(new Set(product.variants.map((v) => formatVariantLabel(v.attributes)).filter((label): label is string => !!label)));
    await this.conversations.sendMessage(conversationId, businessId, options.length
      ? `*${product.name}* is available in: ${options.join(", ")}.`
      : `*${product.name}* comes in one standard option — no size/colour variants.`);
    return true;
  }

  /** "Is there anything similar but cheaper?" — finds other PUBLISHED products in the same category as the
   * active product, priced below it, ordered closest-to-original-price first. */
  private async trySimilarButCheaper(conversationId: string, businessId: string, text: string, activeProductId: string | null): Promise<boolean> {
    if (!activeProductId || !SIMILAR_RE.test(text) || !CHEAPER_RE.test(text)) return false;

    const product = await this.prisma.product.findFirst({ where: { id: activeProductId, businessId }, include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } } });
    if (!product?.variants.length || !product.categoryId) return false;
    const ownPrice = Number(product.variants[0].price);

    const alternatives = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", categoryId: product.categoryId, id: { not: product.id }, variants: { some: { active: true, price: { lt: ownPrice } } } },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } },
      take: MAX_LIST_ROWS,
    });
    const matches = alternatives.filter((p) => p.variants[0]).sort((a, b) => Number(b.variants[0].price) - Number(a.variants[0].price));

    if (!matches.length) {
      await this.conversations.sendMessage(conversationId, businessId, `😕 I don't have anything cheaper than *${product.name}* in the same category right now.`);
      return true;
    }
    await this.conversations.sendList(conversationId, businessId, `Here ${matches.length === 1 ? "is a similar option" : "are some similar options"} that cost less:`, "View", [
      { rows: matches.map((p) => ({ id: `prod_${p.id}`, title: p.name, description: fmtMoney(p.variants[0].price, p.variants[0].currency) })) },
    ]);
    const context: ShoppingSearchContext = { filters: { keywords: [] }, lastResults: matches.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })) };
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: product.categoryId, assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** "Which one would you recommend?" — picks from whatever was just shown (e.g. the similar-but-cheaper list)
   * rather than running a fresh, meaningless search for the literal word "one". */
  private async tryRecommendationPick(conversationId: string, businessId: string, customerId: string, text: string, context: ShoppingSearchContext | null, activeProductId: string | null): Promise<boolean> {
    if (!RECOMMEND_PICK_RE.test(text.toLowerCase())) return false;
    if (context?.lastResults?.length) {
      await this.showProductDetail(conversationId, businessId, context.lastResults[0].productId, customerId);
      return true;
    }
    if (activeProductId) {
      await this.conversations.sendMessage(conversationId, businessId, "I'd go with the one you're already looking at — it's a great choice! 👍");
      return true;
    }
    return false;
  }

  private async search(conversationId: string, businessId: string, customerId: string, text: string, existingContext: ShoppingSearchContext | null, activeProductId: string | null = null) {
    // an ordinal reference to a just-shown result ("show me the first one") takes priority over a fresh search —
    // otherwise "first"/"one" get treated as nonsensical literal search keywords and find nothing
    const referenced = this.resolveOrdinalReference(text, existingContext);
    if (referenced) return this.showProductDetail(conversationId, businessId, referenced.productId, customerId);

    if (await this.tryComparisonFollowUp(conversationId, businessId, text, existingContext)) return;
    if (await this.tryRecommendationPick(conversationId, businessId, customerId, text, existingContext, activeProductId)) return;
    if (await this.tryProductDetailsByName(conversationId, businessId, customerId, text)) return;
    if (await this.tryCompareProducts(conversationId, businessId, text)) return;
    if (await this.tryProductFollowUp(conversationId, businessId, text, activeProductId)) return;
    if (await this.trySimilarButCheaper(conversationId, businessId, text, activeProductId)) return;

    // "What do you sell?" etc. is store/catalogue discovery, not a product search — answering it by searching
    // the catalogue for the literal words in the question just returns "No products matched that search."
    if (STORE_DISCOVERY_RE.test(text)) return this.showShop(conversationId, businessId);

    const parsed = parseSearchQuery(text);
    // merge this turn's constraints onto whatever's already been gathered this conversation — a customer
    // refining a search across several messages ("I need a shirt" / "something casual" / "preferably blue" /
    // "under 1500") means all four together, not four independent, mutually-forgetful searches
    const priorFilters = existingContext?.filters;
    const filters: SearchFilters = {
      keywords: Array.from(new Set([...(priorFilters?.keywords ?? []), ...parsed.keywords])),
      maxPrice: parsed.maxPrice ?? priorFilters?.maxPrice,
      minPrice: parsed.minPrice ?? priorFilters?.minPrice,
    };

    const products = await this.prisma.product.findMany({
      where: {
        businessId, status: "PUBLISHED",
        // every keyword must independently match somewhere (AND across keywords) — a product matching only
        // "black" when "bag" was also required must not be returned
        ...(filters.keywords.length ? { AND: keywordAndClauses(filters.keywords) } : {}),
      },
      include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      take: 30,
    });

    let matches = products.filter((p) => p.variants[0]);
    if (filters.maxPrice !== undefined) matches = matches.filter((p) => Number(p.variants[0].price) <= filters.maxPrice!);
    if (filters.minPrice !== undefined) matches = matches.filter((p) => Number(p.variants[0].price) >= filters.minPrice!);

    // nothing satisfied every keyword — common for occasion/vibe questions ("something for a wedding") where
    // no single product literally contains every word. Relax to whichever products match AT LEAST ONE keyword,
    // ranked by how many they match, instead of a dead "no products matched" end — but only when there were
    // multiple keywords to begin with, so a genuine single-attribute miss (e.g. a color nobody stocks) still
    // correctly reports no match rather than surfacing unrelated products
    let isExactMatch = true;
    if (!matches.length && filters.keywords.length > 1) {
      const relaxed = await this.prisma.product.findMany({
        where: { businessId, status: "PUBLISHED", OR: keywordAndClauses(filters.keywords).flatMap((clause) => clause.OR) },
        include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 }, category: true },
        take: 30,
      });
      let relaxedMatches = relaxed.filter((p) => p.variants[0]);
      if (filters.maxPrice !== undefined) relaxedMatches = relaxedMatches.filter((p) => Number(p.variants[0].price) <= filters.maxPrice!);
      if (filters.minPrice !== undefined) relaxedMatches = relaxedMatches.filter((p) => Number(p.variants[0].price) >= filters.minPrice!);
      if (relaxedMatches.length) {
        const keywordHits = (p: (typeof relaxedMatches)[number]) => {
          const haystack = `${p.name} ${p.description ?? ""} ${p.brand ?? ""} ${p.category?.name ?? ""}`.toLowerCase();
          return filters.keywords.filter((kw) => haystack.includes(kw)).length;
        };
        matches = relaxedMatches.sort((a, b) => keywordHits(b) - keywordHits(a));
        isExactMatch = false;
      }
    }
    matches = matches.slice(0, MAX_LIST_ROWS);

    if (!matches.length) {
      await this.conversations.sendButtons(conversationId, businessId, "😕 No products matched that search.", [{ id: "menu_shop", title: "🛍️ Shop" }]);
      // reset to IDLE (and drop the accumulated context) so a dead-end search doesn't strand the customer, or
      // silently keep filtering later turns by constraints that just proved to match nothing
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "IDLE", assistedBuyingContext: Prisma.JsonNull } });
      return;
    }

    const header = isExactMatch
      ? `🔍 Found ${matches.length} matching product${matches.length === 1 ? "" : "s"}:`
      : `🔍 Nothing matched exactly, but here ${matches.length === 1 ? "is an option" : "are some options"} that might work:`;
    await this.conversations.sendList(conversationId, businessId, header, "View", [
      { rows: matches.map((p) => {
        const v = p.variants[0];
        return { id: `prod_${p.id}`, title: p.name, description: `${fmtMoney(v.price, v.currency)}${v.inventory === 0 ? OUT_OF_STOCK_SUFFIX : ""}` };
      }) },
    ]);
    const context: ShoppingSearchContext = { filters, lastResults: matches.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })) };
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null, assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
  }

  private async showShop(conversationId: string, businessId: string, categoryId?: string) {
    if (categoryId) return this.showProducts(conversationId, businessId, categoryId);
    const categories = await this.prisma.category.findMany({ where: { businessId, active: true, parentId: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], take: MAX_LIST_ROWS });
    if (!categories.length) return this.showProducts(conversationId, businessId, null);

    await this.conversations.sendList(conversationId, businessId, "🗂️ Choose a category to browse:", "Browse", [
      { rows: categories.map((c) => ({ id: `cat_${c.id}`, title: c.name })) },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_CATEGORIES", assistedBuyingContext: Prisma.JsonNull } });
  }

  private async showProducts(conversationId: string, businessId: string, categoryId: string | null) {
    const products = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", ...(categoryId ? { categoryId } : {}) },
      include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      take: MAX_LIST_ROWS,
    });
    const available = products.filter((p) => p.variants[0]);
    if (!available.length) {
      await this.conversations.sendButtons(conversationId, businessId, "😕 No products are available here right now.", [{ id: "menu_shop", title: "🛍️ Shop" }]);
      // reset to IDLE so this dead-end doesn't strand the customer outside the greeting/menu path
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "IDLE" } });
      return;
    }

    await this.conversations.sendList(conversationId, businessId, "🛍️ Here's what we have — tap one to view details:", "View products", [
      { rows: available.map((p) => {
        const v = p.variants[0];
        const stock = v.inventory === 0 ? OUT_OF_STOCK_SUFFIX : "";
        return { id: `prod_${p.id}`, title: p.name, description: `${fmtMoney(v.price, v.currency)}${stock}` };
      }) },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: categoryId, assistedBuyingContext: Prisma.JsonNull } });
  }

  private async showProductDetail(conversationId: string, businessId: string, productId: string, customerId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId, status: "PUBLISHED" },
      include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!product || !product.variants.length) {
      await this.conversations.sendMessage(conversationId, businessId, "Sorry, that product is no longer available.");
      return;
    }

    await this.signals.record(businessId, customerId, "PRODUCT_VIEWED", { productId });

    const first = product.variants[0];
    const isSingleVariant = product.variants.length === 1;
    // for a single variant, fold the quantity/stock prompt into the SAME message as the product photo/caption
    // instead of a separate follow-up — two separate outbound messages can arrive out of order on WhatsApp
    // (image delivery is fetched asynchronously by Meta, so a plain-text follow-up can render first)
    const followUp = isSingleVariant ? (first.inventory === 0 ? "\n\n😔 This item is currently out of stock." : "\n\n🔢 How many would you like? Reply with a number.") : "";
    const caption = `*${product.name}*${product.description ? `\n_${product.description}_` : ""}\n💰 ${fmtMoney(first.price, first.currency)}${followUp}`;
    if (product.imageUrl) {
      await this.conversations.sendImage(conversationId, businessId, toPublicImageUrl(product.imageUrl), caption);
    } else {
      await this.conversations.sendMessage(conversationId, businessId, caption);
    }

    if (isSingleVariant) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { shoppingState: first.inventory === 0 ? "VIEWING_PRODUCT" : "AWAITING_QUANTITY", activeProductId: productId, pendingVariantId: first.inventory === 0 ? null : first.id },
      });
      return;
    }

    await this.conversations.sendList(conversationId, businessId, "Choose an option:", "Select", [
      { rows: product.variants.map((v) => ({
        id: `variant_${v.id}`,
        title: formatVariantLabel(v.attributes) ?? v.sku ?? "Option",
        description: `${fmtMoney(v.price, v.currency)}${v.inventory === 0 ? OUT_OF_STOCK_SUFFIX : ""}`,
      })) },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "VIEWING_PRODUCT", activeProductId: productId } });
  }

  private async askQuantity(conversationId: string, businessId: string, variantId: string) {
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId, active: true } });
    if (!variant) {
      await this.conversations.sendMessage(conversationId, businessId, "Sorry, that option is no longer available.");
      return;
    }
    if (variant.inventory === 0) {
      await this.conversations.sendMessage(conversationId, businessId, "😔 That option is currently out of stock.");
      return;
    }
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "AWAITING_QUANTITY", pendingVariantId: variantId } });
    await this.conversations.sendMessage(conversationId, businessId, "🔢 How many would you like? Reply with a number.");
  }

  private async receiveQuantity(conversationId: string, businessId: string, conversation: { pendingVariantId: string | null; customerId: string }, text: string) {
    // a plain affirmative ("I'll take it", "yes", "sure") after being shown a single-variant product means
    // quantity 1 — customers confirming a purchase rarely type the number itself
    const isAffirmative = /^\s*(i'?ll take it|take it|i want it|yes|yeah|yep|sure|ok(ay)?|sounds good|perfect|great)\s*[!.]*\s*$/i.test(text);
    const quantity = isAffirmative ? 1 : parseInt(text.match(/\d+/)?.[0] ?? "", 10);
    if (!conversation.pendingVariantId || !Number.isFinite(quantity) || quantity < 1) {
      await this.conversations.sendMessage(conversationId, businessId, "Please reply with a valid quantity, e.g. 2.");
      return;
    }

    const variant = await this.prisma.variant.findFirst({ where: { id: conversation.pendingVariantId, businessId }, include: { product: true } });
    if (!variant) {
      await this.conversations.sendMessage(conversationId, businessId, "Sorry, that item is no longer available.");
      return;
    }

    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, conversation.customerId);
    try {
      const updatedCart = await this.cart.addItem(activeCart.id, businessId, variant.id, quantity);
      const { subtotal, currency } = this.cart.totals(updatedCart);
      await this.conversations.sendButtons(conversationId, businessId, `✅ Added *${quantity} × ${variant.product.name}*\n🛒 Cart total: *${fmtMoney(subtotal, currency)}*`, [
        { id: "nav_continue", title: "Keep Shopping" },
        { id: "nav_viewcart", title: "View Cart" },
        { id: "cart_checkout", title: "Checkout" },
      ]);
    } catch (error) {
      await this.conversations.sendMessage(conversationId, businessId, error instanceof Error ? error.message : "Could not add that to your cart.");
      return;
    }
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "CART_REVIEW", pendingVariantId: null } });
  }

  private async showCart(conversationId: string, businessId: string, customerId: string) {
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, customerId);
    if (!activeCart.items.length) {
      await this.conversations.sendButtons(conversationId, businessId, "🛒 Your cart is empty.", [{ id: "menu_shop", title: "🛍️ Shop" }]);
      return;
    }
    const { subtotal, currency } = this.cart.totals(activeCart);
    const lines = activeCart.items.map((item, i) => {
      const label = formatVariantLabel(item.variant.attributes);
      return `${i + 1}. *${item.variant.product.name}*${label ? ` (${label})` : ""}\n   Qty: ${item.quantity} — ${fmtMoney(Number(item.variant.price) * item.quantity, item.variant.currency)}`;
    });
    await this.conversations.sendMessage(conversationId, businessId, `🛒 *Your Cart*\n\n${lines.join("\n\n")}\n\n*Total: ${fmtMoney(subtotal, currency)}*`);
    await this.conversations.sendButtons(conversationId, businessId, "What next?", [
      { id: "cart_checkout", title: "Checkout" },
      { id: "nav_continue", title: "Keep Shopping" },
      { id: "cart_clear", title: "Clear Cart" },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "CART_REVIEW" } });
  }

  private async clearCart(conversationId: string, businessId: string, customerId: string) {
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, customerId);
    await this.cart.clear(activeCart.id, businessId);
    await this.conversations.sendButtons(conversationId, businessId, "🗑️ Your cart has been cleared.", [{ id: "menu_shop", title: "🛍️ Shop" }]);
  }

  private async beginCheckout(conversationId: string, businessId: string, customerId: string) {
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, customerId);
    if (!activeCart.items.length) return this.showCart(conversationId, businessId, customerId);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "COLLECTING_ADDRESS" } });
    await this.conversations.sendMessage(conversationId, businessId, "📍 Great! What's your shipping address?");
  }

  private async receiveAddress(conversationId: string, businessId: string, text: string) {
    const address = text.trim();
    if (address.length < 8) {
      await this.conversations.sendMessage(conversationId, businessId, "Please share your complete shipping address so we can deliver your order 📦");
      return;
    }
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { pendingAddress: address, shoppingState: "COLLECTING_PAYMENT" } });
    await this.conversations.sendButtons(conversationId, businessId, "💳 How would you like to pay?", [
      { id: "pay_card", title: "💳 Card" },
      { id: "pay_upi", title: "📱 UPI" },
      { id: "pay_cod", title: "💵 COD" },
    ]);
  }

  private async setPaymentMethod(conversationId: string, businessId: string, method: "UPI" | "COD" | "CARD") {
    const conversation = await this.prisma.conversation.update({ where: { id: conversationId }, data: { pendingPaymentMethod: method, shoppingState: "ORDER_CONFIRMATION" } });
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, conversation.customerId);
    const { subtotal, currency } = this.cart.totals(activeCart);
    const lines = activeCart.items.map((item) => `${item.quantity} × *${item.variant.product.name}* — ${fmtMoney(Number(item.variant.price) * item.quantity, item.variant.currency)}`);
    const paymentLabel = method === "COD" ? "Cash on Delivery" : method === "CARD" ? "Card" : "UPI";
    await this.conversations.sendMessage(conversationId, businessId,
      `📋 *Order Summary*\n\n${lines.join("\n")}\n\n*Total: ${fmtMoney(subtotal, currency)}*\n📍 Shipping to: ${conversation.pendingAddress}\n💳 Payment: ${paymentLabel}`);
    await this.conversations.sendButtons(conversationId, businessId, "✅ Shall I go ahead and place this order?", [
      { id: "order_confirm", title: "Confirm Order" },
      { id: "order_cancel", title: "Cancel" },
    ]);
  }

  private async confirmOrder(conversationId: string, businessId: string, conversation: { customerId: string; pendingAddress: string | null; pendingPaymentMethod: string | null }) {
    if (!conversation.pendingAddress || !conversation.pendingPaymentMethod) {
      await this.conversations.sendMessage(conversationId, businessId, "Let's start checkout again — what's your shipping address?");
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "COLLECTING_ADDRESS" } });
      return;
    }
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, conversation.customerId);

    let order;
    try {
      order = await this.cart.checkout(activeCart.id, businessId, {
        shippingAddress: conversation.pendingAddress,
        paymentMethod: conversation.pendingPaymentMethod as "UPI" | "COD" | "CARD",
      });
    } catch (error) {
      await this.conversations.sendMessage(conversationId, businessId, error instanceof Error ? error.message : "We couldn't place that order — please try again.");
      return;
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { shoppingState: "IDLE", pendingAddress: null, pendingPaymentMethod: null, activeCategoryId: null, activeProductId: null, pendingVariantId: null, activeOrderId: order.id },
    });

    if (order.status === "AWAITING_APPROVAL") {
      await this.conversations.sendMessage(conversationId, businessId, `Thanks! 🙏 Your order total is *${fmtMoney(order.total, order.currency)}*, which needs a quick review from our team before we can proceed — we'll confirm shortly.`);
      return;
    }
    if (conversation.pendingPaymentMethod === "UPI" || conversation.pendingPaymentMethod === "CARD") {
      await this.conversations.sendMessage(conversationId, businessId, "Thanks! 💳 Please complete your payment using the link below — your order will be confirmed once payment is received.");
      await this.conversations.sendMessage(conversationId, businessId, order.razorpayPaymentLinkUrl ?? `https://pay.relay-dummy.app/checkout/${order.id}`);
    } else {
      await this.conversations.sendMessage(conversationId, businessId, `🎉 Your order has been placed and will be delivered soon — payment collected on delivery.\nOrder ref: *#${order.id.slice(-8).toUpperCase()}*`);
    }
  }

  private async cancelCheckout(conversationId: string, businessId: string) {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "CART_REVIEW", pendingAddress: null, pendingPaymentMethod: null } });
    await this.conversations.sendMessage(conversationId, businessId, "👍 No problem — your cart is still saved. Tap *Checkout* anytime to continue.");
  }

  private async showOrders(conversationId: string, businessId: string, customerId: string) {
    const recentOrders = await this.orders.getRecentForCustomer(customerId, businessId, 5);
    if (!recentOrders.length) {
      await this.conversations.sendMessage(conversationId, businessId, "📦 You haven't placed any orders yet.");
      return;
    }
    const lines = recentOrders.map((o) => `*#${o.id.slice(-8).toUpperCase()}* — ${fmtMoney(o.total, o.currency)} — ${o.status.replace(/_/g, " ")}`);
    await this.conversations.sendMessage(conversationId, businessId, `📦 *Your Recent Orders*\n\n${lines.join("\n\n")}`);
  }
}
