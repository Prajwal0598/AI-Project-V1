import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { CartService } from "../cart/cart.service";
import { OrderService } from "../orders/order.service";
import { toPublicImageUrl } from "../products/image-storage";
import { CustomerSignalService } from "../customer-signals/customer-signal.service";
import { logAiAction } from "../../common/ai-action-log.helper";
import { captureException } from "../../common/error-reporting.helper";
import { fmtMoney, formatVariantLabel, keywordAndClauses, parseSearchQuery, STORE_DISCOVERY_RE, type SearchFilters } from "../shopping-intelligence/search-utils";
import { nextContext, readShoppingContext, resolveOrdinalIndex, type ShoppingContext } from "../shopping-intelligence/shopping-context";
import { ShoppingInterpreterService } from "../shopping-intelligence/shopping-interpreter.service";
import { coreTermsOf, type ShoppingInterpretation } from "../shopping-intelligence/shopping-interpretation";
import { mergeTopic, type MergedTopic } from "../shopping-intelligence/shopping-topic";
import {
  applyHardConstraints, buildReason, cheaperCeiling, isInStock, offeredAttributes, rankProducts, selectDiverse, similarityScore, splitByAttributes, variantHasColor, variantHasSize,
  type Selected,
} from "../shopping-intelligence/shopping-ranking";

// the search helpers moved to shopping-intelligence/search-utils.ts (so the new intelligence layer can use them
// without a circular import) — re-exported here so every existing import of them keeps working unchanged
export { fmtMoney, formatVariantLabel, keywordAndClauses, parseSearchQuery, STORE_DISCOVERY_RE };

const MAX_LIST_ROWS = 10;
// "a small, curated set": a broad/occasion/alternatives answer is capped lower than a literal catalogue match
const CURATED_LIMIT = 6;

// active + in-stock + within-budget enforced IN the query (not after a take:30 cut), so a matching in-budget product can never be crowded out by out-of-budget ones
function hardVariantFilter(maxPrice?: number, minPrice?: number) {
  return {
    variants: {
      some: {
        active: true,
        OR: [{ inventory: null }, { inventory: { gt: 0 } }],
        ...(maxPrice !== undefined || minPrice !== undefined ? { price: { ...(minPrice !== undefined ? { gte: minPrice } : {}), ...(maxPrice !== undefined ? { lte: maxPrice } : {}) } } : {}),
      },
    },
  };
}

const SEARCH_INCLUDE = { variants: { where: { active: true }, orderBy: { createdAt: "asc" } }, category: true } as const;

// "anything in black" — a colour and nothing else to name a product type
const isColourOnly = (topic: MergedTopic) => !!topic.color && !topic.gender && topic.filters.keywords.length === 0;

type CatalogueRow = Prisma.ProductGetPayload<{ include: typeof SEARCH_INCLUDE }>;

type MatchQuality = "EXACT" | "ATTRIBUTE_UNAVAILABLE" | "PARTIAL" | "BUDGET_ONLY" | "NONE";
interface Retrieval {
  quality: MatchQuality;
  topic: MergedTopic;
  // already curated and hard-constraint-checked — every entry is a real catalogue record pinned to a variant that satisfies the constraints
  matches: Selected<CatalogueRow>[];
  totalMatches: number;
  // for ATTRIBUTE_UNAVAILABLE: what was asked for but isn't offered, and what the matching products genuinely do offer
  unmet?: { color?: string; size?: string };
  offered?: { colors: string[]; sizes: string[] };
  // for NONE with a budget: the lowest in-stock price among products excluded only for being above the ceiling
  cheapestAboveBudget?: number;
  currency?: string;
}

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

// "Do you have anything more premium?" / "Anything higher end?" / "Something nicer/fancier?" / "Can I upgrade?"
// — an UPSELL request relative to whatever was just shown, not a fresh (random) search for another coffee
// product; deliberately distinct from CHEAPER_RE's downgrade direction
const UPGRADE_RE = /\b(more premium|higher.?end|higher quality|better quality|nicer|fancier|upgrade|upscale|top.?of.?the.?line|more expensive|pricier|something better)\b/i;

// "What else would go well with this?" / "What goes well with it?" / "Anything to pair with this?" — asks for
// merchant-configured companions (ProductRelation) for the active product, not a fresh search for "else"/"well"
const CROSS_SELL_RE = /\b(?:what(?: else)? (?:would|should|could|do you recommend to)?\s*(?:go|pair)s?(?: well)? with (?:this|it)|goes? well with (?:this|it)|pairs? well with (?:this|it)|anything (?:else )?(?:that )?(?:goes|pairs|to go|to pair) with (?:this|it))\b/i;

// "Which one would you recommend?" / "Which one would you personally recommend?" — asks for a pick among
// whatever was just shown, not a fresh search; deliberately requires "which one/option" (not just "what would
// you recommend", which is an open-ended occasion-style request that should still run as a normal search — see
// Test 2's "going on vacation" case). A short gap is allowed between the modal phrase and the verb so an
// inserted adverb ("personally", "honestly") doesn't break the match.
const RECOMMEND_PICK_RE = /\bwhich (one|option)\b.{0,15}\b(would you|do you|should i)\b.{0,15}\b(recommend|choose|pick|go with)\b/i;

// "Give me your top 3 options" / "What are your top 3 picks?" — asks for the best N from whatever was just
// found, with reasoning, not a fresh (nonsensical) search for the literal words "top"/"options"
const TOP_N_RE = /\btop\s+(\d+|one|two|three|four|five)\b/i;

// "Compare X and Y" / "What's the difference between X and Y?" — a fresh comparison request naming two
// products; strips everything up to the trigger phrase, leaving "X and Y" to split and resolve by name
const COMPARISON_RE = /\b(compare|difference between)\b/i;
const STRIP_COMPARISON_PREFIX_RE = /^.*?\b(?:compare|difference between)\b/i;
const SPLIT_COMPARISON_SEGMENTS_RE = /\s+(?:and|vs\.?|versus)\s+/i;

// "Which is cheaper?" / "Which one is better for casual wear?" / "Which watch would make a better gift?" —
// a follow-up about whichever pair was JUST compared, not a fresh search for the word "cheaper"/"better"
const COMPARISON_FOLLOWUP_RE = /^\s*which\b.*\b(cheaper|better|nicer|suitable|affordable|gift|choice|value)\b/i;
const FOLLOWUP_CHEAPER_RE = /\b(cheap|afford|value|lower price)\w*\b/i;

// number words used throughout cart commands ("add TWO of them", "make that THREE", "remove ONE")
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function wordToNumber(word: string): number | null {
  const lower = word.toLowerCase();
  if (NUMBER_WORDS[lower] !== undefined) return NUMBER_WORDS[lower];
  const digits = Number(lower);
  return Number.isFinite(digits) && digits > 0 ? digits : null;
}

// "Add two of them" / "Add another one" / "Add another" — a quantity referring to whichever product was last
// touched in the cart, not a fresh product-name search (checked BEFORE the named-add pattern, which is more
// permissive). "another" has no trailing digit of its own, so a following "one"/"more" is optional and implies +1.
const ADD_QUANTITY_RE = /^\s*add\s+(?:(one|two|three|four|five|six|seven|eight|nine|ten|\d+)|another)\s*(?:one|more)?\s*(?:of\s+them|of\s+it|of\s+that)?[.!?]*\s*$/i;

// "Add the Premium Cotton T-Shirt to my cart" / "Add the Rose Gold Watch too" / "I want to buy the Rose Gold
// Watch" — adds a NAMED product (implicit qty 1); the optional "i want/i'd like/i would like to" prefix only
// applies before "buy/get" (a strong, unambiguous purchase-intent verb) — bare "I want X" without it must stay
// a SEARCH (see Test 2's occasion queries), not an accidental add-to-cart. The negative lookahead keeps this
// from swallowing "add two of them"-style quantity references.
const ADD_NAMED_RE = /^\s*(?:(?:i want|i'?d like|i would like) to )?(?:add|buy|get)\s+(?:the\s+)?(?!(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|another)\b)(.+?)\s*(?:to (?:my )?cart|too)?[.!?]*\s*$/i;

// "I want 2 Premium Cotton T-Shirts" / "I'd like 3 X" / "Can I get 2 X" / "I'll take 2 X" — a NAMED product
// with an EXPLICIT quantity stated up front, distinct from ADD_NAMED_RE's implicit quantity of 1
const ADD_NAMED_WITH_QTY_RE = /\b(?:i want|i'?d like|i would like|can i get|i'?ll take|i will take|get me)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(.+?)[.!?]*\s*$/i;

// "Actually make that three" / "Make it 3" / "No, just 3" / "Okay, give me 5" / "Can I get 10 instead?" — an
// ABSOLUTE quantity SET for the last-touched cart item, not an additive "add 3 more". The number can come
// before OR after the trigger word ("give me 5" vs "10 instead"), so the two orderings are separate
// alternatives with their own capture group.
const SET_QUANTITY_RE = /\b(?:make\s+(?:that|it)|just|give me)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+instead\b/i;

// "Remove one" (decrement the last-touched item's quantity) vs "Remove the watch" (drop a NAMED product
// entirely) — the captured text is inspected at runtime to tell the two apart
const REMOVE_RE = /^\s*remove\s+(.+?)\s*(?:from (?:my )?cart)?[.!?]*\s*$/i;

// "What's in my cart?" / "Show me my cart again" / "How much is everything?" — view the cart (its own listing
// already states the total, so both phrasings are handled the same way)
const VIEW_CART_RE = /\b(what'?s? in my cart|show (?:me )?my cart|view (?:my )?cart|see my cart|how much (?:is|for) everything|what'?s? my (?:cart )?total|total (?:cost|price))\b/i;

// "For men" / "Do you have this in white?" / "show me something else" — a customer changing their request
// while Relay is mid-way through a deterministic prompt (quantity/address), not answering it. Checked before
// blindly accepting raw text as that state's expected input, so the customer can naturally redirect instead
// of getting stuck on "please enter a valid quantity" (or, worse, having a shopping question silently stored
// as their shipping address).
const INTENT_INTERRUPTION_RE = /\?|\b(something else|anything else|different one|instead|actually|change my mind|for (men|women|him|her|kids|boys|girls)|do you have|show me|what about|never ?mind)\b/i;

const QUANTITY_NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PRONOUN_ONE_PREFIX = new Set(["the", "this", "that", "which", "another", "other", "same", "first", "second", "third", "fourth", "fifth", "last", "next", "any", "each"]);
const QUANTITY_FILLER = new Set([
  "x", "pcs", "pc", "piece", "pieces", "pair", "pairs", "unit", "units", "nos", "qty", "quantity", "of", "them", "it", "please", "pls", "thanks",
  "i", "ill", "id", "want", "need", "take", "get", "give", "me", "add", "make", "buy", "order", "like", "just", "only", "ok", "okay", "yes", "a", "an", "the", "to", "that", "is", "would", "can", "could", "have", "go", "with", "for", "and",
]);

/**
 * Reads a reply to "How many would you like?". It is a quantity only when the message really is one ("2", "three pairs",
 * "I'll take 3"). A message that merely CONTAINS a number — "pearl earrings under 1300", "size 8", "black one in 7" — is a
 * new shopping request, never a quantity of 1300 / 8 / 7.
 */
function readQuantityReply(text: string): { quantity: number | null; otherWords: number; hasBudget: boolean } {
  const parsed = parseSearchQuery(text);
  const hasBudget = parsed.maxPrice !== undefined || parsed.minPrice !== undefined;
  let quantity: number | null = null;
  let otherWords = 0;
  let previous = "";
  for (const token of text.toLowerCase().replace(/['’]/g, "").match(/[a-z]+|\d+/g) ?? []) {
    // "the second ONE" / "this one" refers to a product — only a bare "one" ("I'll take one") is a quantity
    const n = /^\d+$/.test(token) ? parseInt(token, 10) : token === "one" && PRONOUN_ONE_PREFIX.has(previous) ? undefined : QUANTITY_NUMBER_WORDS[token];
    if (n !== undefined && quantity === null) quantity = n;
    else if (!QUANTITY_FILLER.has(token)) otherWords += 1;
    previous = token;
  }
  return { quantity, otherWords, hasBudget };
}

// the single persisted shopping state (filters, slots, last/shown results, last cart item) — shared with
// AssistedBuyingService, see shopping-intelligence/shopping-context.ts. Accumulated across turns on
// Conversation.assistedBuyingContext so a multi-turn refinement ("I need a shirt" / "something casual" /
// "preferably blue" / "under 1500") combines into one search instead of each message overwriting the last,
// and "show me the first one" can resolve against whatever was last shown
type ShoppingSearchContext = ShoppingContext;

const OUT_OF_STOCK_SUFFIX = " · Out of stock";


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
    private readonly interpreter: ShoppingInterpreterService,
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

    if (actionId === "menu_shop") return this.showShop(conversationId, businessId, undefined, conversation.assistedBuyingContext);
    if (actionId === "menu_cart") return this.showCart(conversationId, businessId, conversation.customerId);
    if (actionId === "menu_orders") return this.showOrders(conversationId, businessId, conversation.customerId);
    if (actionId.startsWith("cat_")) return this.showProducts(conversationId, businessId, actionId.slice(4), conversation.assistedBuyingContext);
    if (actionId.startsWith("prod_")) return this.showProductDetail(conversationId, businessId, actionId.slice(5), conversation.customerId);
    if (actionId.startsWith("variant_")) return this.askQuantity(conversationId, businessId, actionId.slice(8));
    // Smart Reply Suggestion buttons (gated by Business.smartRepliesEnabled) — attached to AI/deterministic
    // product cards; routed here exactly like every other button tap, so tapping one from an AI-driven
    // conversation seamlessly hands off into this same deterministic cart/browsing machinery
    if (actionId.startsWith("quickadd_")) return this.quickAddToCart(conversationId, businessId, conversation.customerId, actionId.slice(9), conversation.assistedBuyingContext);
    if (actionId.startsWith("similar_")) return this.showSimilarProducts(conversationId, businessId, actionId.slice(8), conversation.assistedBuyingContext);
    if (actionId === "cart_checkout") return this.beginCheckout(conversationId, businessId, conversation.customerId);
    if (actionId === "cart_clear") return this.clearCart(conversationId, businessId, conversation.customerId);
    // "Keep Shopping" always returns to the top-level category list/full catalog, not the last-viewed
    // category — otherwise a customer who drilled into one category stays pinned there indefinitely
    if (actionId === "nav_continue") return this.showShop(conversationId, businessId, undefined, conversation.assistedBuyingContext);
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
      await this.search(conversationId, businessId, conversation.customerId, text, conversation.assistedBuyingContext, conversation.activeProductId ?? null);
      return true;
    }
    return false;
  }

  /** Resolves "show me the first one"/"the second one"/"the last one" etc. against the product list from the customer's own last search — checked before treating those words as (nonsensical) literal search keywords. */
  private resolveOrdinalReference(text: string, context: ShoppingSearchContext | null): { productId: string; variantId: string; name: string } | null {
    if (!context?.lastResults?.length) return null;
    const idx = resolveOrdinalIndex(text, context.lastResults.length);
    return idx === null ? null : context.lastResults[idx];
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
  private async tryCompareProducts(conversationId: string, businessId: string, text: string, existingContext: ShoppingSearchContext | null = null): Promise<boolean> {
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

    const context = nextContext(existingContext, {
      lastResults: withVariant.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })),
      comparedProductIds: withVariant.map((p) => p.id),
    });
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
  private async trySimilarButCheaper(conversationId: string, businessId: string, text: string, activeProductId: string | null, existingContext: ShoppingSearchContext | null = null): Promise<boolean> {
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
    const context = nextContext(existingContext, { lastResults: matches.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })) });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: product.categoryId, assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** "Do you have anything more premium?" — an UPSELL relative to whichever product is currently in view (or,
   * if the customer never tapped into one, the top result of the last search) — never just another random
   * product in the same category. Same-category alternatives priced ABOVE it, closest premium option first. */
  private async tryMorePremium(conversationId: string, businessId: string, text: string, context: ShoppingSearchContext | null, activeProductId: string | null): Promise<boolean> {
    if (!UPGRADE_RE.test(text.toLowerCase())) return false;
    const referenceId = activeProductId ?? context?.lastResults?.[0]?.productId;
    if (!referenceId) return false;

    const product = await this.prisma.product.findFirst({ where: { id: referenceId, businessId }, include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } } });
    if (!product?.variants.length || !product.categoryId) return false;
    const ownPrice = Number(product.variants[0].price);

    const alternatives = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", categoryId: product.categoryId, id: { not: product.id }, variants: { some: { active: true, price: { gt: ownPrice } } } },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } },
      take: MAX_LIST_ROWS,
    });
    const matches = alternatives.filter((p) => p.variants[0]).sort((a, b) => Number(a.variants[0].price) - Number(b.variants[0].price));

    if (!matches.length) {
      await this.conversations.sendMessage(conversationId, businessId, `That's actually our most premium option in that category right now — *${product.name}* is as good as it gets! 👌`);
      return true;
    }
    await this.conversations.sendList(conversationId, businessId, `✨ Here ${matches.length === 1 ? "is a more premium option" : "are some more premium options"}:`, "View", [
      { rows: matches.map((p) => ({ id: `prod_${p.id}`, title: p.name, description: fmtMoney(p.variants[0].price, p.variants[0].currency) })) },
    ]);
    const upgradedContext = nextContext(context, { lastResults: matches.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })) });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: product.categoryId, assistedBuyingContext: upgradedContext as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** "What else would go well with this?" — merchant-configured CROSS_SELL/UPSELL companions (ProductRelation)
   * for the active product, never an invented pairing. */
  private async tryCrossSell(conversationId: string, businessId: string, text: string, activeProductId: string | null, existingContext: ShoppingSearchContext | null = null): Promise<boolean> {
    if (!activeProductId || !CROSS_SELL_RE.test(text.toLowerCase())) return false;

    const product = await this.prisma.product.findFirst({ where: { id: activeProductId, businessId } });
    if (!product) return false;

    const relations = await this.prisma.productRelation.findMany({
      where: { businessId, productId: activeProductId },
      include: { relatedProduct: { include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 } } } },
      orderBy: { createdAt: "desc" },
    });
    const matches = relations.filter((r) => r.relatedProduct.status === "PUBLISHED" && r.relatedProduct.variants[0]).slice(0, MAX_LIST_ROWS);

    if (!matches.length) {
      await this.conversations.sendMessage(conversationId, businessId, `😕 I don't have specific pairing suggestions for *${product.name}* yet — let me know if you'd like to browse more of the store.`);
      return true;
    }
    await this.conversations.sendList(conversationId, businessId, `🤝 Goes well with *${product.name}*:`, "View", [
      { rows: matches.map((r) => ({ id: `prod_${r.relatedProduct.id}`, title: r.relatedProduct.name, description: fmtMoney(r.relatedProduct.variants[0].price, r.relatedProduct.variants[0].currency) })) },
    ]);
    const context = nextContext(existingContext, { lastResults: matches.map((r) => ({ productId: r.relatedProduct.id, variantId: r.relatedProduct.variants[0].id, name: r.relatedProduct.name })) });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** Explains WHY a product fits the customer's accumulated ask — grounded only in facts we actually have
   * (its real price vs. their stated budget, its real category vs. their stated interests), never an invented
   * spec. Falls back to a neutral line when there's nothing concrete to cite. */
  private explainFit(product: { category?: { name: string } | null }, variant: { price: number | string | { toString(): string }; currency: string }, filters: SearchFilters): string {
    const reasons: string[] = [];
    if (filters.maxPrice !== undefined) reasons.push(`fits within your ${fmtMoney(filters.maxPrice, variant.currency)} budget`);
    const categoryName = product.category?.name;
    const matchedKeywords = filters.keywords.filter((kw) => kw !== "gift" && categoryName?.toLowerCase().includes(kw));
    if (categoryName && matchedKeywords.length) reasons.push(`it's ${categoryName}, matching what you said she's into`);
    return reasons.length ? reasons.join(" and ") : `a popular pick at ${fmtMoney(variant.price, variant.currency)}`;
  }

  /** "Give me your top 3 options" — the best N from whatever was just found, each with a short reason grounded
   * in the accumulated budget/interests, instead of just a bare re-listing (or a meaningless fresh search for
   * the literal words "top"/"options"). Narrows lastResults to just these N, so a follow-up ("which one...")
   * picks among the ones actually shown here. */
  private async tryTopNRecommendations(conversationId: string, businessId: string, text: string, context: ShoppingSearchContext | null): Promise<boolean> {
    const match = text.match(TOP_N_RE);
    if (!match || !context?.lastResults?.length) return false;
    const n = Math.max(1, wordToNumber(match[1]) ?? 3);
    const picks = context.lastResults.slice(0, n);

    const products = await this.prisma.product.findMany({
      where: { id: { in: picks.map((p) => p.productId) }, businessId },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 }, category: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = picks.map((pick, i) => {
      const product = byId.get(pick.productId);
      const variant = product?.variants[0];
      if (!product || !variant) return `${i + 1}. *${pick.name}*`;
      return `${i + 1}. *${product.name}* — ${fmtMoney(variant.price, variant.currency)} — ${this.explainFit(product, variant, context.filters)}`;
    });
    await this.conversations.sendMessage(conversationId, businessId, `🏆 My top ${picks.length} pick${picks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);

    const narrowed = nextContext(context, { lastResults: picks });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { assistedBuyingContext: narrowed as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** "Which one would you recommend?" — picks from whatever was just shown (e.g. the similar-but-cheaper list)
   * rather than running a fresh, meaningless search for the literal word "one", and explains WHY that pick
   * fits rather than silently just showing it. */
  private async tryRecommendationPick(conversationId: string, businessId: string, customerId: string, text: string, context: ShoppingSearchContext | null, activeProductId: string | null): Promise<boolean> {
    if (!RECOMMEND_PICK_RE.test(text.toLowerCase())) return false;
    if (context?.lastResults?.length) {
      const top = context.lastResults[0];
      const product = await this.prisma.product.findFirst({ where: { id: top.productId, businessId }, include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 }, category: true } });
      const variant = product?.variants[0];
      if (product && variant) {
        await this.conversations.sendMessage(conversationId, businessId, `👍 I'd personally go with *${product.name}* — ${this.explainFit(product, variant, context.filters)}.`);
      }
      await this.showProductDetail(conversationId, businessId, top.productId, customerId);
      return true;
    }
    if (activeProductId) {
      await this.conversations.sendMessage(conversationId, businessId, "I'd go with the one you're already looking at — it's a great choice! 👍");
      return true;
    }
    return false;
  }

  /** Mutates the cart for a resolved product/variant, sends a confirmation grounded in the ACTUAL resulting
   * cart state, and remembers it as the "last cart item touched" for pronoun follow-ups ("add two of them",
   * "actually make that three", "remove one") — all without changing shoppingState away from a free-text-
   * routable state, so those follow-ups keep reaching search() on subsequent turns. */
  private async mutateCartItem(conversationId: string, businessId: string, customerId: string, item: { productId: string; variantId: string; name: string }, mode: "add" | "set", amount: number, prevContext: ShoppingSearchContext | null = null): Promise<boolean> {
    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, customerId);
    try {
      const updated = mode === "add"
        ? await this.cart.addItem(activeCart.id, businessId, item.variantId, amount)
        : await this.cart.updateItemQuantity(activeCart.id, businessId, item.variantId, amount);
      const { subtotal, currency } = this.cart.totals(updated);
      const newQuantity = updated.items.find((i) => i.variantId === item.variantId)?.quantity ?? 0;
      await this.conversations.sendButtons(conversationId, businessId, newQuantity > 0
        ? `✅ *${item.name}* — now ${newQuantity} in your cart.\n🛒 Cart total: *${fmtMoney(subtotal, currency)}*`
        : `✅ Removed *${item.name}* from your cart.\n🛒 Cart total: *${fmtMoney(subtotal, currency)}*`,
        [{ id: "nav_viewcart", title: "View Cart" }, { id: "cart_checkout", title: "Checkout" }]);
    } catch (error) {
      await this.conversations.sendMessage(conversationId, businessId, error instanceof Error ? error.message : "Could not update your cart.");
      // even though this attempt was rejected (e.g. a stock-limit error), still remember which product it was
      // about — otherwise a follow-up quantity-only correction ("okay, give me 5") has nothing to apply to
      const rejectedContext = nextContext(prevContext, { lastCartItem: item });
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeProductId: item.productId, assistedBuyingContext: rejectedContext as unknown as Prisma.InputJsonValue } });
      return true;
    }
    // the cart itself lives in CartService; only the search context is kept here — carried forward (not wiped)
    // so "the second one" / "under 1,500" / "other options" still work right after something was added
    const context = nextContext(prevContext, { lastCartItem: item });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeProductId: item.productId, assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** Smart Reply "🛒 Add to Cart" button — one tap adds qty 1 of the tapped variant, skipping the "how many
   * would you like?" text prompt that a normal `variant_<id>` tap still asks. Reuses mutateCartItem so the
   * confirmation message, cart totals, and follow-up "add two more"/"make it 3" free-text corrections all
   * behave identically to the existing AI free-text add-to-cart path — this is genuinely the same action, just
   * reached via a tap instead of typed text. */
  private async quickAddToCart(conversationId: string, businessId: string, customerId: string, variantId: string, rawContext: unknown = null) {
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId, active: true, product: { status: "PUBLISHED" } }, include: { product: true } });
    if (!variant) {
      await this.conversations.sendMessage(conversationId, businessId, "Sorry, that option is no longer available.");
      return;
    }
    if (variant.inventory === 0) {
      await this.conversations.sendMessage(conversationId, businessId, "😔 That option is currently out of stock.");
      return;
    }
    await this.mutateCartItem(conversationId, businessId, customerId, { productId: variant.productId, variantId: variant.id, name: variant.product.name }, "add", 1, readShoppingContext(rawContext));
  }

  /** Smart Reply "🔎 See Similar" button — other PUBLISHED products in the same category, excluding the
   * product itself. Deliberately a plain same-category listing (no price-direction filter) rather than
   * duplicating trySimilarButCheaper/tryMorePremium's free-text-triggered price-relative variants above. */
  private async showSimilarProducts(conversationId: string, businessId: string, productId: string, rawContext: unknown = null) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product?.categoryId) {
      await this.conversations.sendMessage(conversationId, businessId, "😕 I don't have similar products to suggest for that item.");
      return;
    }

    const alternatives = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", categoryId: product.categoryId, id: { not: productId } },
      include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      take: MAX_LIST_ROWS,
    });
    const matches = alternatives.filter((p) => p.variants[0]);
    if (!matches.length) {
      await this.conversations.sendMessage(conversationId, businessId, `😕 I don't have anything else similar to *${product.name}* right now.`);
      return;
    }

    await this.conversations.sendList(conversationId, businessId, `🔎 Similar to *${product.name}*:`, "View", [
      { rows: matches.map((p) => ({ id: `prod_${p.id}`, title: p.name, description: `${fmtMoney(p.variants[0].price, p.variants[0].currency)}${p.variants[0].inventory === 0 ? OUT_OF_STOCK_SUFFIX : ""}` })) },
    ]);
    const context = nextContext(readShoppingContext(rawContext), { lastResults: matches.map((p) => ({ productId: p.id, variantId: p.variants[0].id, name: p.name })) });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: product.categoryId, assistedBuyingContext: context as unknown as Prisma.InputJsonValue } });
  }

  /** "Add the Premium Cotton T-Shirt to my cart" (a NAMED product, implicit qty 1) / "I want 2 Premium Cotton
   * T-Shirts" (a NAMED product with an EXPLICIT quantity) / "Add two of them" / "Add another one" (a quantity
   * referring to whichever product was last added). All actually mutate the real cart — never just a
   * confirmation message with no underlying change. */
  private async tryCartAdd(conversationId: string, businessId: string, customerId: string, text: string, context: ShoppingSearchContext | null): Promise<boolean> {
    const qtyMatch = text.match(ADD_QUANTITY_RE);
    if (qtyMatch) {
      if (!context?.lastCartItem) return false;
      const qty = qtyMatch[1] ? (wordToNumber(qtyMatch[1]) ?? 1) : 1; // group 1 is unset when "another" (not a number word) matched — that always means +1
      return this.mutateCartItem(conversationId, businessId, customerId, context.lastCartItem, "add", qty, context);
    }

    const namedWithQtyMatch = text.match(ADD_NAMED_WITH_QTY_RE);
    const namedMatch = namedWithQtyMatch ?? text.match(ADD_NAMED_RE);
    if (!namedMatch) return false;
    const nameText = namedWithQtyMatch ? namedWithQtyMatch[2] : namedMatch[1];
    const explicitQty = namedWithQtyMatch ? wordToNumber(namedWithQtyMatch[1]) ?? 1 : 1;
    const { keywords } = parseSearchQuery(nameText);
    if (!keywords.length) return false;

    const candidates = await this.prisma.product.findMany({
      where: { businessId, status: "PUBLISHED", AND: keywordAndClauses(keywords) },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" }, take: 1 }, category: true },
      take: 5,
    });
    if (!candidates.length) return false;
    const product = this.bestKeywordMatch(candidates, keywords);
    if (!product.variants[0]) return false;

    return this.mutateCartItem(conversationId, businessId, customerId, { productId: product.id, variantId: product.variants[0].id, name: product.name }, "add", explicitQty, context);
  }

  /** "Actually make that three" / "No, just 3" / "Okay, give me 5" / "Can I get 10 instead?" — an ABSOLUTE
   * quantity SET for the last-touched cart item, not an additive "add 3 more" (which would silently
   * double-count against whatever the customer already added). */
  private async trySetCartQuantity(conversationId: string, businessId: string, customerId: string, text: string, context: ShoppingSearchContext | null): Promise<boolean> {
    const match = text.match(SET_QUANTITY_RE);
    if (!match || !context?.lastCartItem) return false;
    const qty = wordToNumber(match[1] ?? match[2]);
    if (qty === null) return false;
    return this.mutateCartItem(conversationId, businessId, customerId, context.lastCartItem, "set", qty, context);
  }

  /** "Remove one" (decrements the last-touched cart item's quantity) vs "Remove the watch" (drops a NAMED
   * product from the cart entirely, regardless of its quantity) — the captured text after "remove" decides
   * which behaviour applies. */
  private async tryRemoveFromCart(conversationId: string, businessId: string, customerId: string, text: string, context: ShoppingSearchContext | null): Promise<boolean> {
    const match = text.match(REMOVE_RE);
    if (!match) return false;
    const captured = match[1].replace(/^\s*the\s+/i, "").trim();

    const activeCart = await this.cart.findActiveForConversation(conversationId, businessId);
    if (!activeCart?.items.length) {
      await this.conversations.sendMessage(conversationId, businessId, "🛒 Your cart is already empty.");
      return true;
    }

    const asNumber = wordToNumber(captured);
    if (asNumber !== null) {
      if (!context?.lastCartItem) return false;
      const item = activeCart.items.find((i) => i.variantId === context.lastCartItem!.variantId);
      if (!item) return false;
      return this.mutateCartItem(conversationId, businessId, customerId, context.lastCartItem, "set", Math.max(0, item.quantity - asNumber), context);
    }

    // named removal — find the matching cart line by product name rather than requiring the exact string
    const lower = captured.toLowerCase();
    const item = activeCart.items.find((i) => i.variant.product.name.toLowerCase().includes(lower));
    if (!item) {
      await this.conversations.sendMessage(conversationId, businessId, `I couldn't find "${captured}" in your cart.`);
      return true;
    }
    return this.mutateCartItem(conversationId, businessId, customerId, { productId: item.variant.product.id, variantId: item.variantId, name: item.variant.product.name }, "set", 0, context);
  }

  /** "What's in my cart?" / "Show me my cart again" / "How much is everything?" — the existing cart summary
   * already states the grand total, so all three phrasings are answered the same way. */
  private async tryViewCart(conversationId: string, businessId: string, customerId: string, text: string): Promise<boolean> {
    if (!VIEW_CART_RE.test(text.toLowerCase())) return false;
    await this.showCart(conversationId, businessId, customerId);
    return true;
  }

  private async search(conversationId: string, businessId: string, customerId: string, text: string, rawContext: unknown, activeProductId: string | null = null) {
    // normalize whichever context shape is persisted (this engine's, or AssistedBuyingService's older one)
    const existingContext = readShoppingContext(rawContext);

    // an ordinal reference to a just-shown result ("show me the first one") takes priority over a fresh search —
    // otherwise "first"/"one" get treated as nonsensical literal search keywords and find nothing
    const referenced = this.resolveOrdinalReference(text, existingContext);
    if (referenced) return this.showProductDetail(conversationId, businessId, referenced.productId, customerId);

    // cart commands must actually mutate the real cart, not just talk about it — checked early since they're
    // fairly distinctive phrasings ("add"/"remove"/"cart"/"everything") unlikely to collide with anything else
    if (await this.tryCartAdd(conversationId, businessId, customerId, text, existingContext)) return;
    if (await this.trySetCartQuantity(conversationId, businessId, customerId, text, existingContext)) return;
    if (await this.tryRemoveFromCart(conversationId, businessId, customerId, text, existingContext)) return;
    if (await this.tryViewCart(conversationId, businessId, customerId, text)) return;

    if (await this.tryComparisonFollowUp(conversationId, businessId, text, existingContext)) return;
    if (await this.tryTopNRecommendations(conversationId, businessId, text, existingContext)) return;
    if (await this.tryRecommendationPick(conversationId, businessId, customerId, text, existingContext, activeProductId)) return;
    if (await this.tryProductDetailsByName(conversationId, businessId, customerId, text)) return;
    if (await this.tryCompareProducts(conversationId, businessId, text, existingContext)) return;
    if (await this.tryProductFollowUp(conversationId, businessId, text, activeProductId)) return;
    if (await this.trySimilarButCheaper(conversationId, businessId, text, activeProductId, existingContext)) return;
    if (await this.tryMorePremium(conversationId, businessId, text, existingContext, activeProductId)) return;
    if (await this.tryCrossSell(conversationId, businessId, text, activeProductId, existingContext)) return;

    // "What do you sell?" etc. is store/catalogue discovery, not a product search — answering it by searching
    // the catalogue for the literal words in the question just returns "No products matched that search."
    if (STORE_DISCOVERY_RE.test(text)) return this.showShop(conversationId, businessId, undefined, rawContext);

    try {
      await this.interpretAndSearch(conversationId, businessId, text, existingContext, activeProductId);
    } catch (err) {
      // a failed lookup is NOT "no match" — say so, keep the context and the cart untouched, never invent results
      this.logger.error(`Shopping search failed for conversation ${conversationId}`, err instanceof Error ? err.stack : String(err));
      captureException(err, { conversationId, businessId, flow: "shopping-search" });
      await this.conversations.sendMessage(conversationId, businessId, "Sorry — I'm having trouble searching our catalogue right now. Please try again in a moment; your cart is safe.");
    }
  }

  /** Reads the message against the persisted context, then routes: variant question, alternatives/similar, cheaper, clarification, or a (possibly refined) catalogue search. */
  private async interpretAndSearch(conversationId: string, businessId: string, text: string, existingContext: ShoppingSearchContext | null, activeProductId: string | null) {
    const interp = await this.interpreter.interpret({ conversationId, businessId, text, context: existingContext, activeProductId });

    if (interp.intent === "VARIANT_REQUEST" && activeProductId && (await this.tryVariantRequest(conversationId, businessId, interp, activeProductId))) return;
    if ((interp.intent === "ALTERNATIVES" || interp.intent === "SIMILAR") && (await this.tryAlternatives(conversationId, businessId, interp, existingContext, activeProductId))) return;
    if (interp.wantsCheaper && interp.terms.length === 0 && (await this.tryCheaper(conversationId, businessId, interp, existingContext, activeProductId))) return;

    if (interp.intent === "SELECT_PRODUCT") {
      await this.conversations.sendMessage(conversationId, businessId, "I don't have a list in front of us yet — tell me what you're looking for and I'll show you some options to pick from.");
      return;
    }
    // genuinely ambiguous: ask ONE useful question rather than guessing or dumping the catalogue
    if (interp.intent === "UNCLEAR") {
      await this.conversations.sendMessage(conversationId, businessId, interp.clarification ?? "What kind of product are you looking for?");
      return;
    }

    const merged = mergeTopic(existingContext, interp);
    // an ambiguous topic switch ("pearl earrings" right after "emerald saree", no explicit request words) that
    // finds nothing when combined with the old terms is retried as a fresh topic before any relaxation
    const recover = interp.ambiguousTopic && !merged.reset && existingContext ? mergeTopic(existingContext, { ...interp, topicRelation: "NEW_TOPIC" }) : undefined;
    const result = await this.retrieve(businessId, merged, interp, { recover });
    await this.presentResult(conversationId, businessId, result, existingContext, { clearActiveProduct: !!activeProductId });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Retrieval: structured hard filters (budget/stock enforced in the query AND re-checked on the fetched
  // records), keyword retrieval, model-proposed broadening terms, then a controlled relaxation ladder that only
  // ever loosens SOFT preferences — never the price ceiling or availability — and always says which it did.
  // ---------------------------------------------------------------------------------------------------------

  private curate(kept: Selected<CatalogueRow>[], topic: MergedTopic): Selected<CatalogueRow>[] {
    // a broad ask (budget/occasion only) should span the catalogue; a specific ask keeps pure relevance order
    return topic.filters.keywords.length === 0 ? selectDiverse(kept, CURATED_LIMIT) : kept.slice(0, CURATED_LIMIT);
  }

  /** Level 0 — every keyword (incl. colour/gender slots) AND-required, exactly as before, plus the hard variant filter. Null when nothing qualifies. */
  private async queryExact(businessId: string, topic: MergedTopic, excludeIds: string[] = []): Promise<Retrieval | null> {
    const { maxPrice, minPrice } = topic.filters;
    const rows = await this.prisma.product.findMany({
      where: {
        businessId, status: "PUBLISHED",
        // every keyword must independently match somewhere (AND across keywords) — a product matching only
        // "black" when "bag" was also required must not be returned
        ...(topic.effectiveKeywords.length ? { AND: keywordAndClauses(topic.effectiveKeywords) } : {}),
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
        ...hardVariantFilter(maxPrice, minPrice),
      },
      include: SEARCH_INCLUDE,
      take: 30,
    });
    const hard = applyHardConstraints(rows, { maxPrice, minPrice, gender: topic.gender });
    if (!hard.kept.length) return null;

    const ranked = rankProducts(hard.kept, topic.effectiveKeywords, topic.expandedTerms);
    if (topic.size) {
      const { matching } = splitByAttributes(ranked, { size: topic.size });
      if (!matching.length) {
        return { quality: "ATTRIBUTE_UNAVAILABLE", topic, matches: this.curate(ranked, topic), totalMatches: ranked.length, unmet: { size: topic.size }, offered: offeredAttributes(ranked.flatMap((s) => s.eligible)) };
      }
      return { quality: "EXACT", topic, matches: this.curate(matching, topic), totalMatches: matching.length };
    }
    return { quality: "EXACT", topic, matches: this.curate(ranked, topic), totalMatches: ranked.length };
  }

  /** The first, most precise attempt. A colour-only ask ("anything in black") reads real variant colours, which is a superset of the text match; everything else is the exact text query. */
  private queryPrimary(businessId: string, topic: MergedTopic, excludeIds: string[] = []): Promise<Retrieval | null> {
    return isColourOnly(topic) ? this.queryColour(businessId, topic, excludeIds) : this.queryExact(businessId, topic, excludeIds);
  }

  /**
   * Colour as a real attribute: colour usually lives on the VARIANT ("color": "black"), which the text query in
   * queryExact cannot see. Looks for the named product (or, for a colour-only ask like "anything in black", a wider
   * pool of the catalogue) and checks the real variant attributes. Null when nothing qualifies.
   */
  private async queryColour(businessId: string, topic: MergedTopic, excludeIds: string[] = []): Promise<Retrieval | null> {
    if (!topic.color) return null;
    const { maxPrice, minPrice } = topic.filters;
    const freeKeywords = [...topic.filters.keywords, ...(topic.gender ? [topic.gender] : [])];
    const colourOnly = freeKeywords.length === 0;
    const rows = await this.prisma.product.findMany({
      where: {
        businessId, status: "PUBLISHED",
        ...(colourOnly ? {} : { AND: keywordAndClauses(freeKeywords) }),
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
        ...hardVariantFilter(maxPrice, minPrice),
      },
      include: SEARCH_INCLUDE,
      take: colourOnly ? 100 : 30,
    });
    const hard = applyHardConstraints(rows ?? [], { maxPrice, minPrice, gender: topic.gender });
    if (!hard.kept.length) return null;
    const ranked = rankProducts(hard.kept, freeKeywords, topic.expandedTerms);
    const { matching } = splitByAttributes(ranked, { color: topic.color, size: topic.size });
    if (matching.length) return { quality: "EXACT", topic, matches: this.curate(matching, topic), totalMatches: matching.length };
    // a colour-only ask that nothing matches is a plain no-match — "it comes in other colours" only makes sense for a named product
    if (colourOnly) return null;
    return { quality: "ATTRIBUTE_UNAVAILABLE", topic, matches: this.curate(ranked, topic), totalMatches: ranked.length, unmet: { color: topic.color }, offered: offeredAttributes(ranked.flatMap((s) => s.eligible)) };
  }

  private async retrieve(businessId: string, topic: MergedTopic, interp: ShoppingInterpretation, opts: { recover?: MergedTopic; excludeIds?: string[] } = {}): Promise<Retrieval> {
    const exclude = opts.excludeIds ?? [];
    const { maxPrice, minPrice } = topic.filters;

    const exact = await this.queryPrimary(businessId, topic, exclude);
    if (exact) return exact;
    if (opts.recover) {
      const alt = await this.queryPrimary(businessId, opts.recover, exclude);
      if (alt) return alt;
    }

    // Level 1 — a requested colour is a soft attribute: look for the product itself and check the REAL variant
    // attributes (colour is often only on the variant, which the text query can't see). If the product exists
    // but not in that colour, say so and offer what it genuinely comes in.
    const byColour = isColourOnly(topic) ? null : await this.queryColour(businessId, topic, exclude);
    if (byColour) return byColour;

    // Level 2 — occasion/vibe asks rarely have one product literally containing every word: relax to products
    // matching AT LEAST ONE free keyword (or a model-proposed broadening term), ranked by overlap. Only the free
    // keywords are used — a lone colour/gender word must never pull in unrelated product types.
    const relaxedTerms = [...topic.filters.keywords, ...topic.expandedTerms];
    if (topic.filters.keywords.length > 1 || topic.expandedTerms.length > 0) {
      const rows = await this.prisma.product.findMany({
        where: { businessId, status: "PUBLISHED", OR: keywordAndClauses(relaxedTerms).flatMap((clause) => clause.OR), ...(exclude.length ? { id: { notIn: exclude } } : {}), ...hardVariantFilter(maxPrice, minPrice) },
        include: SEARCH_INCLUDE,
        take: 30,
      });
      const hard = applyHardConstraints(rows, { maxPrice, minPrice, gender: topic.gender });
      if (hard.kept.length) {
        const ranked = rankProducts(hard.kept, topic.filters.keywords, topic.expandedTerms);
        return { quality: "PARTIAL", topic, matches: this.curate(ranked, topic), totalMatches: ranked.length };
      }
    }

    // Level 3 — an occasion/vibe-only ask ("a gift under 3000") names no catalogue attribute at all, so failing
    // to literally match it shouldn't wipe out a useful budget: browse what's in budget, diversified. NEVER done
    // when the customer named a real product type ("pearl earrings under 1500") — that's an honest no-match.
    const hasBudget = maxPrice !== undefined || minPrice !== undefined;
    if (hasBudget && coreTermsOf(topic.filters.keywords).length === 0) {
      const rows = await this.prisma.product.findMany({
        where: { businessId, status: "PUBLISHED", ...(exclude.length ? { id: { notIn: exclude } } : {}), ...hardVariantFilter(maxPrice, minPrice) },
        include: SEARCH_INCLUDE,
        take: 30,
      });
      const hard = applyHardConstraints(rows, { maxPrice, minPrice, gender: topic.gender });
      if (hard.kept.length) {
        const ranked = rankProducts(hard.kept, topic.filters.keywords, topic.expandedTerms);
        return { quality: "BUDGET_ONLY", topic, matches: selectDiverse(ranked, CURATED_LIMIT), totalMatches: ranked.length };
      }
    }

    // Level 4 — honest no-match. When a budget was set, find out whether the product exists only ABOVE it, so the
    // reply can say "the lowest I have starts at X" without ever presenting an over-budget product as a result.
    let cheapestAboveBudget: number | undefined;
    let currency: string | undefined;
    if (maxPrice !== undefined && interp.intent !== "UNCLEAR") {
      const rows = await this.prisma.product.findMany({
        where: { businessId, status: "PUBLISHED", ...(topic.effectiveKeywords.length ? { AND: keywordAndClauses(topic.effectiveKeywords) } : {}), ...hardVariantFilter(undefined, undefined) },
        include: SEARCH_INCLUDE,
        take: 30,
      });
      const diag = applyHardConstraints(rows ?? [], { maxPrice });
      cheapestAboveBudget = diag.cheapestAboveBudget;
      currency = rows?.[0]?.variants?.[0]?.currency;
    }
    return { quality: "NONE", topic, matches: [], totalMatches: 0, cheapestAboveBudget, currency };
  }

  private rowDescription(s: Selected<CatalogueRow>, topic: MergedTopic): string {
    const reason = buildReason(s, { maxPrice: topic.filters.maxPrice, terms: topic.effectiveKeywords, color: topic.color });
    return `${fmtMoney(s.variant.price as never, s.variant.currency)}${reason ? ` · ${reason}` : ""}`;
  }

  private budgetNote(topic: MergedTopic, currency = "INR"): string {
    return topic.filters.maxPrice !== undefined ? ` within ${fmtMoney(topic.filters.maxPrice, currency)}` : "";
  }

  /** Sends the result with a header that states honestly what kind of match it is, and persists the merged topic + the exact products shown. */
  private async presentResult(conversationId: string, businessId: string, r: Retrieval, existing: ShoppingContext | null, opts: { clearActiveProduct?: boolean } = {}) {
    const topic = r.topic;
    const label = [...topic.filters.keywords, ...(topic.gender ? [topic.gender] : [])].join(" ");

    if (r.quality === "NONE") {
      const budget = topic.filters.maxPrice;
      const wanted = [...topic.filters.keywords, ...(topic.gender ? [topic.gender] : []), ...(topic.color ? [topic.color] : [])].join(" ") || "that";
      const body = r.cheapestAboveBudget !== undefined && budget !== undefined
        ? `I don't have anything for "${wanted}" within ${fmtMoney(budget, r.currency ?? "INR")}. The lowest-priced option I have starts at ${fmtMoney(r.cheapestAboveBudget, r.currency ?? "INR")} — want me to look at a higher budget?`
        : `I couldn't find anything matching "${wanted}"${budget !== undefined ? ` within ${fmtMoney(budget, r.currency ?? "INR")}` : ""} right now. Try a different product type, or browse by category.`;
      await this.conversations.sendButtons(conversationId, businessId, body, [{ id: "menu_shop", title: "🛍️ Shop" }]);
      // keep browsing state (so the customer can simply refine) and the previous context; only a brand-new topic's own
      // request is remembered, so "under 5000" can then loosen exactly that request
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null,
          ...(topic.reset ? { assistedBuyingContext: this.contextFor(existing, topic, [], r) as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      return;
    }

    const n = r.matches.length;
    const budget = this.budgetNote(topic, r.matches[0].variant.currency);
    const more = r.totalMatches > n ? ` (say "other options" to see more)` : "";
    let header: string;
    if (r.quality === "EXACT") {
      header = `${n === 1 ? "Yes! I found one option that matches what you're looking for" : `Yes! I found ${n} options that match what you're looking for`}${budget}${more}:`;
    } else if (r.quality === "ATTRIBUTE_UNAVAILABLE") {
      const colour = r.unmet?.color;
      const offered = colour ? r.offered?.colors : r.offered?.sizes;
      const what = colour ? `in ${colour}` : `in size ${r.unmet?.size}`;
      header = `Sorry, I don't have ${label || "that"} ${what} right now.${offered?.length ? ` It comes in: ${offered.join(", ")}.` : ""} Here ${n === 1 ? "is an option" : "are some options"} in other ${colour ? "colours" : "sizes"}${budget}:`;
    } else if (r.quality === "BUDGET_ONLY") {
      header = `Nothing matched exactly, but here ${n === 1 ? "is a pick" : "are a few picks"}${topic.occasion ? ` for a ${topic.occasion}` : ""}${budget}:`;
    } else {
      header = `Nothing matched exactly, but here ${n === 1 ? "is an option" : "are a few options"} that might work${budget}:`;
    }

    await this.conversations.sendList(conversationId, businessId, header, "View", [
      { rows: r.matches.map((s) => ({ id: `prod_${s.product.id}`, title: s.product.name, description: this.rowDescription(s, topic) })) },
    ]);

    const lastResults = r.matches.map((s) => ({ productId: s.product.id, variantId: s.variant.id, name: s.product.name }));
    await this.prisma.conversation.update({
      where: { id: conversationId },
      // a list means no single product is "in view" any more, so a stale activeProductId can't mis-anchor "similar ones"/"more premium"
      data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null, ...(opts.clearActiveProduct ? { activeProductId: null } : {}), assistedBuyingContext: this.contextFor(existing, topic, lastResults, r) as unknown as Prisma.InputJsonValue },
    });
  }

  /** Builds the context to persist for a merged topic: the topic's own fields (an unavailable colour/size is dropped, not remembered), what was shown, and — carried over — the last cart item. */
  private contextFor(existing: ShoppingContext | null, topic: MergedTopic, lastResults: ShoppingContext["lastResults"], r?: Retrieval): ShoppingContext {
    const base = topic.reset ? null : existing;
    const shown = Array.from(new Set([...(base?.shownProductIds ?? []), ...lastResults.map((x) => x.productId)]));
    return nextContext(existing, {
      filters: topic.filters,
      gender: topic.gender, color: r?.unmet?.color ? undefined : topic.color, size: r?.unmet?.size ? undefined : topic.size,
      occasion: topic.occasion, recipient: topic.recipient, style: topic.style, material: topic.material, expandedTerms: topic.expandedTerms,
      lastResults, shownProductIds: shown,
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Follow-up handlers driven by the structured interpretation
  // ---------------------------------------------------------------------------------------------------------

  /** "Do you have this in size L?" / "does it come in red?" — answered strictly from the viewed product's real variants. */
  private async tryVariantRequest(conversationId: string, businessId: string, interp: ShoppingInterpretation, activeProductId: string): Promise<boolean> {
    const product = await this.prisma.product.findFirst({ where: { id: activeProductId, businessId, status: "PUBLISHED" }, include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" } } } });
    if (!product?.variants.length) return false;

    const { color, size } = interp;
    // colour can also live in the product's own name/description (a single-variant "Black Strappy Heels") rather than a variant attribute
    const textHasColor = !!color && `${product.name} ${product.description ?? ""}`.toLowerCase().includes(color);
    const matches = product.variants.filter((v) => (!size || variantHasSize(v, size)) && (!color || textHasColor || variantHasColor(v, color)));
    const available = matches.filter(isInStock);
    const requested = [color, size ? `size ${size.toUpperCase()}` : null].filter(Boolean).join(", ");

    if (available.length === 1) {
      const v = available[0];
      const label = formatVariantLabel(v.attributes);
      await this.conversations.sendMessage(conversationId, businessId, `Yes — *${product.name}*${label ? ` (${label})` : ""} is available at ${fmtMoney(v.price, v.currency)}.\n\n🔢 How many would you like? Reply with a number.`);
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "AWAITING_QUANTITY", activeProductId: product.id, pendingVariantId: v.id } });
      return true;
    }
    if (available.length > 1) {
      await this.conversations.sendList(conversationId, businessId, `Yes — *${product.name}* is available in ${requested}. Choose an option:`, "Select", [
        { rows: available.map((v) => ({ id: `variant_${v.id}`, title: formatVariantLabel(v.attributes) ?? v.sku ?? "Option", description: fmtMoney(v.price, v.currency) })) },
      ]);
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "VIEWING_PRODUCT", activeProductId: product.id } });
      return true;
    }

    const inStock = product.variants.filter(isInStock);
    const options = Array.from(new Set(inStock.map((v) => formatVariantLabel(v.attributes)).filter((l): l is string => !!l)));
    // labels are themselves comma-joined ("7, black"), so list the options with a different separator
    const body = matches.length
      ? `*${product.name}* in ${requested} is currently out of stock.${options.length ? ` Still available: ${options.join(" | ")}.` : ""}`
      : `I don't have *${product.name}* in ${requested}.${options.length ? ` What I do have: ${options.join(" | ")}.` : " It comes in one standard option."}`;
    await this.conversations.sendMessage(conversationId, businessId, body);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "VIEWING_PRODUCT", activeProductId: product.id } });
    return true;
  }

  /** Same-category / name-overlap alternatives to a reference product, hard constraints enforced, closest first. */
  private async similarTo(businessId: string, reference: CatalogueRow, filters: SearchFilters, excludeIds: string[], diversify: boolean, gender?: string): Promise<Selected<CatalogueRow>[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        businessId, status: "PUBLISHED", id: { notIn: Array.from(new Set([reference.id, ...excludeIds])) },
        ...(reference.categoryId ? { categoryId: reference.categoryId } : {}),
        ...hardVariantFilter(filters.maxPrice, filters.minPrice),
      },
      include: SEARCH_INCLUDE,
      take: 30,
    });
    const hard = applyHardConstraints(rows, { maxPrice: filters.maxPrice, minPrice: filters.minPrice, gender });
    const scored = hard.kept
      .map((s, i) => ({ s: { ...s, score: similarityScore(reference, s.product) }, i }))
      .filter((x) => reference.categoryId || x.s.score > 0)
      .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
      .map((x) => x.s);
    return diversify ? selectDiverse(scored, CURATED_LIMIT) : scored.slice(0, CURATED_LIMIT);
  }

  /** "Do you have any other options?" / "show me similar ones" — anchored to the search in progress and/or the product in view, excluding what was already shown (for alternatives). */
  private async tryAlternatives(conversationId: string, businessId: string, interp: ShoppingInterpretation, existing: ShoppingContext | null, activeProductId: string | null): Promise<boolean> {
    const referenceId = activeProductId ?? existing?.lastResults[0]?.productId ?? null;
    const merged = mergeTopic(existing, { ...interp, topicRelation: "REFINEMENT" });
    // a colour/gender/size the customer asked for is part of the search too ("anything in black" has no product word at all)
    const hasSearch = merged.effectiveKeywords.length > 0 || !!merged.occasion;

    if (!referenceId && !hasSearch) {
      await this.conversations.sendMessage(conversationId, businessId, "Other options for what? Tell me what you're looking for and I'll show you some choices.");
      return true;
    }

    const isSimilar = interp.intent === "SIMILAR";
    const shown = Array.from(new Set([...(existing?.shownProductIds ?? []), ...(existing?.lastResults.map((r) => r.productId) ?? []), ...(referenceId ? [referenceId] : [])]));
    let picked: Selected<CatalogueRow>[] = [];

    // A) the same search again, minus everything the customer has already seen
    if (!isSimilar && hasSearch) {
      const again = (await this.queryPrimary(businessId, merged, shown)) ?? (isColourOnly(merged) ? null : await this.queryColour(businessId, merged, shown));
      picked = again?.quality === "EXACT" ? again.matches : [];
    }

    // B) otherwise, products like the one in view / the top result — but never for a colour-only ask ("anything in
    // black"): footwear "similar to" the first black item is not what that customer asked for, so we say we're out
    let reference: CatalogueRow | null = null;
    if (!picked.length && referenceId && !(hasSearch && !isSimilar && isColourOnly(merged))) {
      reference = await this.prisma.product.findFirst({ where: { id: referenceId, businessId, status: "PUBLISHED" }, include: SEARCH_INCLUDE });
      if (reference) picked = await this.similarTo(businessId, reference, merged.filters, isSimilar ? [] : shown, !isSimilar, merged.gender);
    }

    if (!picked.length) {
      await this.conversations.sendMessage(conversationId, businessId, isSimilar
        ? `I don't have anything else similar${reference ? ` to *${reference.name}*` : ""} that fits right now. Want to try a different product type or adjust your budget?`
        : "That's everything I have that fits what you've asked for right now. Want to adjust your budget or try a different product type?");
      return true;
    }

    const n = picked.length;
    const budget = this.budgetNote(merged, picked[0].variant.currency);
    const likeText = reference ? ` like *${reference.name}*` : "";
    await this.conversations.sendList(conversationId, businessId, isSimilar ? `Here ${n === 1 ? "is something" : "are some options"} similar${reference ? ` to *${reference.name}*` : ""}${budget}:` : `Here ${n === 1 ? "is another option" : "are some other options"}${likeText}${budget}:`, "View", [
      { rows: picked.map((s) => ({ id: `prod_${s.product.id}`, title: s.product.name, description: this.rowDescription(s, merged) })) },
    ]);
    const lastResults = picked.map((s) => ({ productId: s.product.id, variantId: s.variant.id, name: s.product.name }));
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: reference?.categoryId ?? null, activeProductId: null, assistedBuyingContext: this.contextFor(existing, { ...merged, reset: false }, lastResults) as unknown as Prisma.InputJsonValue },
    });
    return true;
  }

  /** "Show me something cheaper" — keeps the current search and tightens the budget to strictly below the product in view (or the median of what was shown). */
  private async tryCheaper(conversationId: string, businessId: string, interp: ShoppingInterpretation, existing: ShoppingContext | null, activeProductId: string | null): Promise<boolean> {
    const anchorIds = activeProductId ? [activeProductId] : (existing?.lastResults.map((r) => r.productId) ?? []);
    if (!anchorIds.length) {
      await this.conversations.sendMessage(conversationId, businessId, "Cheaper than what? Tell me what you're looking for, or a budget like \"under ₹1,500\", and I'll find options.");
      return true;
    }
    const rows = await this.prisma.product.findMany({ where: { id: { in: anchorIds }, businessId }, include: SEARCH_INCLUDE });
    const prices = (rows ?? []).flatMap((p) => { const ps = p.variants.filter(isInStock).map((v) => Number(String(v.price))); return ps.length ? [Math.min(...ps)] : []; });
    if (!prices.length) return false;

    const max = cheaperCeiling(prices, !!activeProductId, existing?.filters.maxPrice);
    if (max === null) {
      await this.conversations.sendMessage(conversationId, businessId, "That's already the lowest price I have in this range.");
      return true;
    }

    const refined: ShoppingInterpretation = { ...interp, topicRelation: "REFINEMENT", budget: { ...interp.budget, max } };
    const merged = mergeTopic(existing, refined);
    if (merged.filters.keywords.length || merged.occasion) {
      await this.presentResult(conversationId, businessId, await this.retrieve(businessId, merged, refined), existing, { clearActiveProduct: !!activeProductId });
      return true;
    }
    // no search to tighten (only a product in view) — look for cheaper products like it instead
    const reference0 = activeProductId ? rows.find((p) => p.id === activeProductId) : null;
    if (!reference0) return false;
    const picked = await this.similarTo(businessId, reference0, merged.filters, [reference0.id], false);
    if (!picked.length) {
      await this.conversations.sendMessage(conversationId, businessId, `I don't have anything similar to *${reference0.name}* for less right now.`);
      return true;
    }
    await this.conversations.sendList(conversationId, businessId, `Here ${picked.length === 1 ? "is a cheaper option" : "are some cheaper options"} like *${reference0.name}*${this.budgetNote(merged, picked[0].variant.currency)}:`, "View", [
      { rows: picked.map((s) => ({ id: `prod_${s.product.id}`, title: s.product.name, description: this.rowDescription(s, merged) })) },
    ]);
    const lastResults = picked.map((s) => ({ productId: s.product.id, variantId: s.variant.id, name: s.product.name }));
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { shoppingState: "BROWSING_PRODUCTS", activeProductId: null, assistedBuyingContext: this.contextFor(existing, { ...merged, reset: false }, lastResults) as unknown as Prisma.InputJsonValue },
    });
    return true;
  }

  private async showShop(conversationId: string, businessId: string, categoryId?: string, rawContext: unknown = null) {
    if (categoryId) return this.showProducts(conversationId, businessId, categoryId, rawContext);
    const categories = await this.prisma.category.findMany({ where: { businessId, active: true, parentId: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], take: MAX_LIST_ROWS });
    if (!categories.length) return this.showProducts(conversationId, businessId, null, rawContext);

    await this.conversations.sendList(conversationId, businessId, "🗂️ Choose a category to browse:", "Browse", [
      { rows: categories.map((c) => ({ id: `cat_${c.id}`, title: c.name })) },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_CATEGORIES", assistedBuyingContext: this.browsingContext(rawContext) } });
  }

  /** Category browsing starts a fresh topic (search filters are dropped), but the last cart item must survive so "make that 3" still works after "Keep Shopping". */
  private browsingContext(rawContext: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    const keep = readShoppingContext(rawContext)?.lastCartItem;
    return keep ? (nextContext(null, { lastCartItem: keep }) as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
  }

  private async showProducts(conversationId: string, businessId: string, categoryId: string | null, rawContext: unknown = null) {
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
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: categoryId, assistedBuyingContext: this.browsingContext(rawContext) } });
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

    // Smart Reply Suggestion buttons (opt-in, single-variant only — a fast tap-to-choose alternative alongside
    // the existing typed-quantity flow below, which still works unchanged if the customer types a number
    // instead of tapping). Falls back to the plain image/text send if Meta rejects the interactive payload.
    const business = isSingleVariant ? await this.prisma.business.findUnique({ where: { id: businessId }, select: { smartRepliesEnabled: true } }) : null;
    if (business?.smartRepliesEnabled) {
      const plainCaption = `*${product.name}*${product.description ? `\n_${product.description}_` : ""}\n💰 ${fmtMoney(first.price, first.currency)}`;
      const buttons = first.inventory === 0
        ? [{ id: `similar_${product.id}`, title: "🔎 See Similar" }]
        : [{ id: `quickadd_${first.id}`, title: "🛒 Add to Cart" }, { id: `similar_${product.id}`, title: "🔎 See Similar" }];
      try {
        await this.conversations.sendButtons(conversationId, businessId, plainCaption, buttons, product.imageUrl ? toPublicImageUrl(product.imageUrl) : undefined);
        await logAiAction(this.prisma, { businessId, customerId, conversationId, action: "SMART_REPLY_SHOWN", result: "success", reason: `product detail: ${product.name}` });
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { shoppingState: first.inventory === 0 ? "VIEWING_PRODUCT" : "AWAITING_QUANTITY", activeProductId: productId, pendingVariantId: first.inventory === 0 ? null : first.id },
        });
        return;
      } catch (error) {
        this.logger.warn(`Smart Reply buttons failed for product ${productId}, falling back to text — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

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
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId, active: true, product: { status: "PUBLISHED" } } });
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

  private async receiveQuantity(conversationId: string, businessId: string, conversation: { pendingVariantId: string | null; customerId: string; activeProductId?: string | null; assistedBuyingContext?: unknown }, text: string) {
    // a plain affirmative ("I'll take it", "yes", "sure") after being shown a single-variant product means
    // quantity 1 — customers confirming a purchase rarely type the number itself
    const isAffirmative = /^\s*(i'?ll take it|take it|i want it|yes|yeah|yep|sure|ok(ay)?|sounds good|perfect|great)\s*[!.]*\s*$/i.test(text);
    // a question/size/colour message that merely CONTAINS a digit ("what about size 8?"), or a pick from the list
    // ("I like the second one"), is a new request, never a quantity
    const isQuestionAboutProduct = /\?|\b(size|sz|colou?rs?|do you have|show me|what about)\b/i.test(text) || resolveOrdinalIndex(text, 9) !== null;
    const reply = readQuantityReply(text);
    // at most one stray word ("5 shirts", "2 pcs") is still a quantity; a budget phrase, a question or a longer sentence is not
    const isPlainQuantity = reply.quantity !== null && !reply.hasBudget && !isQuestionAboutProduct && reply.otherWords <= 1;
    const quantity = isAffirmative ? 1 : isPlainQuantity ? (reply.quantity as number) : Number.NaN;
    if (!conversation.pendingVariantId || !Number.isFinite(quantity) || quantity < 1) {
      // the customer changed their mind mid-prompt ("for men", "do you have this in white?", "pearl earrings under 1300")
      // rather than answering it — abandon the quantity prompt and treat this as a new shopping request instead of
      // repeatedly telling them to enter a number they were never going to enter
      if (INTENT_INTERRUPTION_RE.test(text) || isQuestionAboutProduct || reply.hasBudget || reply.otherWords >= 2) {
        await this.search(conversationId, businessId, conversation.customerId, text, conversation.assistedBuyingContext, conversation.activeProductId ?? null);
        return;
      }
      await this.conversations.sendMessage(conversationId, businessId, "No problem — if you meant something else, just tell me what you're looking for and I'll adjust. Otherwise, how many would you like?");
      return;
    }

    const variant = await this.prisma.variant.findFirst({ where: { id: conversation.pendingVariantId, businessId, active: true, product: { status: "PUBLISHED" } }, include: { product: true } });
    if (!variant) {
      // hidden or removed while the prompt was open — close the prompt so the next message isn't read as a quantity for a dead item
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", pendingVariantId: null } });
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
    // a shopping question/redirect mid-address ("do you have this in white?") must never be silently stored
    // as the shipping address — checkout state stays exactly as-is (still COLLECTING_ADDRESS) so the very next
    // reply is retried as the address, rather than routing through the full search pipeline here, which could
    // change shoppingState and derail an order that's already this close to being placed
    if (INTENT_INTERRUPTION_RE.test(text)) {
      await this.conversations.sendMessage(conversationId, businessId, "I'll help with that once your order is placed! For now, could you share your shipping address so I can continue checkout? Or type \"cancel\" to stop and keep browsing.");
      return;
    }
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
      // a repeated tap on "Confirm Order" after the order was placed has nothing left to confirm — never restart checkout over it
      const remaining = await this.cart.findActiveForConversation(conversationId, businessId);
      if (!remaining?.items.length) {
        await this.conversations.sendMessage(conversationId, businessId, "✅ Your order has already been placed — there's nothing more to confirm. We'll keep you posted here.");
        return;
      }
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
      // another confirmation for this same cart won the race and is already replying — don't contradict it
      if (error instanceof ConflictException) return;
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
