import { Injectable, Logger } from "@nestjs/common";
import OpenAI from "openai";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationService } from "../conversations/conversation.service";
import { CartService } from "../cart/cart.service";
import { toPublicImageUrl } from "../products/image-storage";
import { parseSearchQuery, fmtMoney } from "../shopping-flow/shopping-flow.service";

// ordinal words a customer might use to refer back to a just-shown recommendation ("add the first one")
const ORDINAL_WORDS: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4,
};

// phrases that signal "compare these" rather than "add the first one" — checked before reference resolution
const COMPARISON_RE = /\b(compare|which is better|which one is better|vs\.?|versus|difference between|better one)\b/;

interface RecommendedItem { productId: string; variantId: string; name: string }
interface AssistedBuyingContext { recommendations: RecommendedItem[]; query: string }

/**
 * Natural-language product discovery for the free-text AI flow (Assisted Buying, V1) — deterministic retrieval
 * and reranking, no LLM call: reuses ShoppingFlowService's keyword/price parser to extract intent, queries the
 * catalogue directly, and composes a grounded (template, not model-generated) explanation from only the
 * retrieved records. Called from AiService before the normal conversational reply, only when the business has
 * opted in (Business.assistedBuyingEnabled) — returns false to let the caller fall through to the usual AI
 * reply whenever the message doesn't look like a shopping query or nothing matches.
 */
@Injectable()
export class AssistedBuyingService {
  private readonly logger = new Logger(AssistedBuyingService.name);
  // client is initialised lazily so the API starts without OPENAI_API_KEY configured — comparison falls back
  // to a plain templated summary when it's unavailable, since it's an enhancement, not the core capability
  private client: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly cart: CartService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.client = new OpenAI({ apiKey });
  }

  /** Returns true if this turn was fully handled (a reply was already sent); false to fall through to the normal AI flow. */
  async handle(conversationId: string, businessId: string, customerId: string, text: string): Promise<boolean> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId }, select: { assistedBuyingContext: true } });
    const context = conversation?.assistedBuyingContext as unknown as AssistedBuyingContext | null;

    // comparison ("which is better, the first or second?") is checked before treating ordinals as an add-to-cart reference
    if ((context?.recommendations?.length ?? 0) >= 2 && (await this.tryCompare(conversationId, businessId, text, context!))) {
      return true;
    }

    // an existing recommendation set takes priority — "add the first one" only makes sense right after showing options
    if (context?.recommendations?.length && (await this.tryResolveReference(conversationId, businessId, customerId, text, context))) {
      return true;
    }

    return this.tryRecommend(conversationId, businessId, text);
  }

  private async tryRecommend(conversationId: string, businessId: string, text: string): Promise<boolean> {
    const filters = parseSearchQuery(text);
    if (!filters.keywords.length && filters.minPrice == null && filters.maxPrice == null) return false; // doesn't look like a shopping query

    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { assistedBuyingMaxRecommendations: true } });
    const maxRecommendations = business?.assistedBuyingMaxRecommendations ?? 5;

    // exact match first; if nothing fits, progressively relax the constraint most likely to be too strict
    // (budget, then keywords) so the customer gets the closest valid alternatives instead of an empty result
    let candidates = await this.findCandidates(businessId, filters, 20);
    let isExactMatch = true;
    if (!candidates.length && filters.keywords.length && (filters.minPrice != null || filters.maxPrice != null)) {
      candidates = await this.findCandidates(businessId, { keywords: filters.keywords }, 20);
      isExactMatch = false;
    }
    if (!candidates.length && filters.keywords.length && (filters.minPrice != null || filters.maxPrice != null)) {
      candidates = await this.findCandidates(businessId, { keywords: [], minPrice: filters.minPrice, maxPrice: filters.maxPrice }, 20);
      isExactMatch = false;
    }
    if (!candidates.length) return false; // nothing fits even loosely — let the normal AI reply handle it conversationally

    // rerank against the ORIGINAL request (not the relaxed retrieval filters) so results stay ordered by
    // closeness to what the customer actually asked for, even when the match itself isn't exact
    const ranked = this.rerank(candidates, filters).slice(0, maxRecommendations);

    const label = filters.keywords.join(" ") || "your search";
    const budgetSuffix = filters.maxPrice != null ? ` under ${fmtMoney(filters.maxPrice, ranked[0].variant.currency)}` : "";
    const intro = isExactMatch
      ? `I found ${ranked.length} option${ranked.length === 1 ? "" : "s"} for "${label}"${budgetSuffix}:`
      : `I couldn't find an exact match for "${label}"${budgetSuffix}, but here ${ranked.length === 1 ? "is the closest option" : "are the closest options"} I have:`;
    await this.conversations.sendMessage(conversationId, businessId, intro);

    const recommendations: RecommendedItem[] = [];
    for (const { product, variant } of ranked) {
      const caption = `*${product.name}*\n💰 ${fmtMoney(variant.price, variant.currency)}${variant.inventory === 0 ? "\n😔 Out of stock" : ""}`;
      const buttons = [{ id: `variant_${variant.id}`, title: "🛒 Add to Cart" }, { id: "suggestion_dismiss", title: "Maybe Later" }];
      await this.conversations.sendButtons(conversationId, businessId, caption, buttons, product.imageUrl ? toPublicImageUrl(product.imageUrl) : undefined);
      recommendations.push({ productId: product.id, variantId: variant.id, name: product.name });
    }

    await this.prisma.conversation.update({ where: { id: conversationId }, data: { assistedBuyingContext: { recommendations, query: text } as unknown as Prisma.InputJsonValue } });
    return true;
  }

  private async tryCompare(conversationId: string, businessId: string, text: string, context: AssistedBuyingContext): Promise<boolean> {
    const lower = text.toLowerCase();
    if (!COMPARISON_RE.test(lower)) return false;

    // resolve which of the shown recommendations are being compared — by ordinal, by name, or generically ("compare these")
    const indices = new Set<number>();
    for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
      if (idx < context.recommendations.length && new RegExp(`\\b${word}\\b`).test(lower)) indices.add(idx);
    }
    context.recommendations.forEach((r, i) => { if (lower.includes(r.name.toLowerCase())) indices.add(i); });
    if (indices.size < 2 && /\b(these|them|both|all)\b/.test(lower)) {
      for (let i = 0; i < Math.min(3, context.recommendations.length); i++) indices.add(i);
    }
    if (indices.size < 2) return false; // not enough specific references to compare — let the caller try something else

    const picked = [...indices].slice(0, 3).map((i) => context.recommendations[i]);
    const products = await this.prisma.product.findMany({
      where: { id: { in: picked.map((p) => p.productId) }, businessId },
      include: { variants: { where: { active: true }, orderBy: { price: "asc" } } },
    });
    if (products.length < 2) return false;

    const reply = await this.composeComparison(text, products);
    await this.conversations.sendMessage(conversationId, businessId, reply);
    return true;
  }

  /** Grounded comparison from only the given products' authoritative fields — falls back to a plain templated
   * summary when OpenAI isn't configured or the call fails, since comparison is an enhancement, not core. */
  private async composeComparison(question: string, products: { name: string; description: string | null; variants: { price: unknown; currency: string; inventory: number | null }[] }[]): Promise<string> {
    const lines = products.map((p) => `*${p.name}* — ${fmtMoney(p.variants[0].price as never, p.variants[0].currency)}${p.variants[0].inventory === 0 ? " (out of stock)" : ""}`);
    const fallback = `Here's what I have:\n${lines.join("\n")}\n\nLet me know what matters most to you — price or availability — and I can help you decide.`;
    if (!this.client) return fallback;

    try {
      const facts = products.map((p) => `- ${p.name}: ${fmtMoney(p.variants[0].price as never, p.variants[0].currency)}, ${p.variants[0].inventory === 0 ? "out of stock" : "in stock"}${p.description ? `, ${p.description}` : ""}`).join("\n");
      const response = await this.client.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-4o",
        instructions: `Compare only the exact products/attributes given below for the customer's question — never invent specs, ratings, discounts, or claims not present in the facts. Keep the reply under 70 words and end with a conditional recommendation based on their likely priority (e.g. "If price matters most, ..."), not an unsupported claim that one is simply "better".\n\nProducts:\n${facts}`,
        input: question,
        store: false,
      });
      return response.output_text?.trim() || fallback;
    } catch (err) {
      this.logger.warn(`Comparison LLM call failed, using templated fallback: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  private async tryResolveReference(conversationId: string, businessId: string, customerId: string, text: string, context: AssistedBuyingContext): Promise<boolean> {
    const lower = text.toLowerCase();
    let index: number | null = null;
    for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) { index = idx; break; }
    }
    if (index === null) {
      const byName = context.recommendations.findIndex((r) => lower.includes(r.name.toLowerCase()));
      if (byName !== -1) index = byName;
    }
    if (index === null || index >= context.recommendations.length) return false;

    const picked = context.recommendations[index];
    const product = await this.prisma.product.findFirst({ where: { id: picked.productId, businessId }, include: { variants: { where: { active: true } } } });
    if (!product?.variants.length) return false;

    // if this product has multiple variants (size/color), prefer whichever one the customer's text mentions
    let variant = product.variants.find((v) => v.id === picked.variantId) ?? product.variants[0];
    if (product.variants.length > 1) {
      const mentioned = product.variants.find((v) => {
        const attrs = (v.attributes as Record<string, string> | null) ?? {};
        return Object.values(attrs).some((val) => !!val && lower.includes(String(val).toLowerCase()));
      });
      if (mentioned) variant = mentioned;
    }

    if (variant.inventory === 0) {
      await this.conversations.sendMessage(conversationId, businessId, `😔 Sorry, *${product.name}* is currently out of stock in that option.`);
      return true;
    }

    const activeCart = await this.cart.getOrCreateActive(conversationId, businessId, customerId);
    try {
      const updatedCart = await this.cart.addItem(activeCart.id, businessId, variant.id, 1);
      const { subtotal, currency } = this.cart.totals(updatedCart);
      await this.conversations.sendButtons(conversationId, businessId, `✅ Added *${product.name}* to your cart.\n🛒 Cart total: ${fmtMoney(subtotal, currency)}`, [
        { id: "nav_viewcart", title: "View Cart" },
        { id: "cart_checkout", title: "Checkout" },
      ]);
    } catch (error) {
      await this.conversations.sendMessage(conversationId, businessId, error instanceof Error ? error.message : "Could not add that to your cart.");
    }
    return true;
  }

  private async findCandidates(businessId: string, filters: { keywords: string[]; minPrice?: number; maxPrice?: number }, limit: number) {
    const priceFilter = filters.minPrice != null || filters.maxPrice != null
      ? { price: { ...(filters.minPrice != null ? { gte: filters.minPrice } : {}), ...(filters.maxPrice != null ? { lte: filters.maxPrice } : {}) } }
      : {};

    const products = await this.prisma.product.findMany({
      where: {
        businessId, status: "PUBLISHED",
        variants: { some: { active: true, ...priceFilter } },
        ...(filters.keywords.length ? {
          OR: filters.keywords.flatMap((kw) => [
            { name: { contains: kw, mode: "insensitive" as const } },
            { description: { contains: kw, mode: "insensitive" as const } },
            { brand: { contains: kw, mode: "insensitive" as const } },
            { category: { name: { contains: kw, mode: "insensitive" as const } } },
          ]),
        } : {}),
      },
      take: limit,
      include: { variants: { where: { active: true, ...priceFilter }, orderBy: { price: "asc" } }, category: true },
    });
    return products.filter((p) => p.variants.length > 0);
  }

  private rerank(products: Awaited<ReturnType<AssistedBuyingService["findCandidates"]>>, filters: { keywords: string[]; maxPrice?: number }) {
    return products
      .map((product) => {
        const variant = product.variants[0]; // cheapest matching variant, already sorted asc by findCandidates
        let score = 0;
        const haystack = `${product.name} ${product.description ?? ""} ${product.brand ?? ""} ${product.category?.name ?? ""}`.toLowerCase();
        for (const kw of filters.keywords) if (haystack.includes(kw)) score += 2;
        if (variant.inventory !== 0) score += 1; // in-stock bonus
        if (filters.maxPrice != null && filters.maxPrice > 0) score += 1 - Math.min(1, Number(variant.price) / filters.maxPrice); // closer to budget scores slightly higher
        return { product, variant, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}
