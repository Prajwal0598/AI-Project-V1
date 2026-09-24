import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { CartService } from "../cart/cart.service";
import { OrderService } from "../orders/order.service";
import { toPublicImageUrl } from "../products/image-storage";
import { CustomerSignalService } from "../customer-signals/customer-signal.service";

const MAX_LIST_ROWS = 10;

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
]);

// messages asking what the store carries at all, rather than searching for something specific — must be
// checked before running a keyword search, otherwise e.g. "What do you sell?" gets searched literally and
// returns "No products matched that search."
export const STORE_DISCOVERY_RE = /\b(what do you (sell|offer|have|stock)|what (products?|items?|categories?) do you (have|sell|offer|stock)|what (products?|items?|categories?) (are (available|there)|do you have)|show me (your|the) (products?|catalogue|catalog|store|items?)|what can i (buy|get|purchase)|what do you (guys )?have)\b/i;

interface SearchFilters { maxPrice?: number; minPrice?: number; keywords: string[] }

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
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "MAIN_MENU" } });
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
  async handleFreeText(conversationId: string, businessId: string, conversation: { shoppingState: string; pendingVariantId: string | null; customerId: string }, text: string): Promise<boolean> {
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
      await this.search(conversationId, businessId, text);
      return true;
    }
    return false;
  }

  private async search(conversationId: string, businessId: string, text: string) {
    // "What do you sell?" etc. is store/catalogue discovery, not a product search — answering it by searching
    // the catalogue for the literal words in the question just returns "No products matched that search."
    if (STORE_DISCOVERY_RE.test(text)) return this.showShop(conversationId, businessId);

    const filters = parseSearchQuery(text);
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
      // reset to IDLE so a dead-end search doesn't strand the customer outside the greeting/menu path
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "IDLE" } });
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
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: null } });
  }

  private async showShop(conversationId: string, businessId: string, categoryId?: string) {
    if (categoryId) return this.showProducts(conversationId, businessId, categoryId);
    const categories = await this.prisma.category.findMany({ where: { businessId, active: true, parentId: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], take: MAX_LIST_ROWS });
    if (!categories.length) return this.showProducts(conversationId, businessId, null);

    await this.conversations.sendList(conversationId, businessId, "🗂️ Choose a category to browse:", "Browse", [
      { rows: categories.map((c) => ({ id: `cat_${c.id}`, title: c.name })) },
    ]);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_CATEGORIES" } });
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
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { shoppingState: "BROWSING_PRODUCTS", activeCategoryId: categoryId } });
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
    const quantity = parseInt(text.match(/\d+/)?.[0] ?? "", 10);
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
