import { extractReplaceableSlots, type SearchFilters } from "./search-utils";

export interface ShownProduct { productId: string; variantId: string; name: string }

/**
 * The single persisted shopping state, stored in Conversation.assistedBuyingContext. One shape for BOTH the
 * deterministic ShoppingFlowService and the free-text AssistedBuyingService, so a customer moving between
 * button browsing, natural-language search and cart actions never loses (or corrupts) what was established.
 * Reads tolerate the two older shapes already persisted in production — see readShoppingContext.
 */
export interface ShoppingContext {
  filters: SearchFilters;
  // gender/color are "replaceable" slots (a later "actually, black" REPLACES white rather than AND-ing both)
  gender?: string;
  color?: string;
  size?: string;
  occasion?: string;
  recipient?: string;
  style?: string;
  material?: string;
  // semantic broadening terms proposed by the interpreter for the CURRENT topic only — soft, never required
  expandedTerms?: string[];
  lastResults: ShownProduct[];
  // every product shown since the topic began, so "other options" can exclude what the customer already saw
  shownProductIds?: string[];
  comparedProductIds?: string[];
  lastCartItem?: ShownProduct;
  // legacy AssistedBuyingService shape — still written (alongside lastResults) so an older reader/rollback keeps working
  recommendations?: ShownProduct[];
  query?: string;
}

const isShown = (v: unknown): v is ShownProduct =>
  !!v && typeof v === "object" && typeof (v as ShownProduct).productId === "string" && typeof (v as ShownProduct).name === "string";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const optString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Normalizes whatever is stored in Conversation.assistedBuyingContext (either legacy shape, or this one) into a ShoppingContext, or null when there's nothing usable. */
export function readShoppingContext(raw: unknown): ShoppingContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const filters = (r.filters && typeof r.filters === "object" ? r.filters : {}) as Partial<SearchFilters>;
  const lastResults = (Array.isArray(r.lastResults) ? r.lastResults : Array.isArray(r.recommendations) ? r.recommendations : []).filter(isShown);
  return {
    filters: {
      keywords: strings(filters.keywords),
      ...(typeof filters.maxPrice === "number" ? { maxPrice: filters.maxPrice } : {}),
      ...(typeof filters.minPrice === "number" ? { minPrice: filters.minPrice } : {}),
    },
    gender: optString(r.gender), color: optString(r.color), size: optString(r.size),
    occasion: optString(r.occasion), recipient: optString(r.recipient), style: optString(r.style), material: optString(r.material),
    expandedTerms: strings(r.expandedTerms),
    lastResults,
    shownProductIds: strings(r.shownProductIds),
    comparedProductIds: Array.isArray(r.comparedProductIds) ? strings(r.comparedProductIds) : undefined,
    lastCartItem: isShown(r.lastCartItem) ? r.lastCartItem : undefined,
    query: optString(r.query),
  };
}

/**
 * Builds the next persisted context from the previous one plus a patch. The TOPIC (filters, slots, shown
 * history) and the last cart item carry forward unless the patch replaces them — so a handler that only wants
 * to change `lastResults` (similar/premium/cross-sell lists) or `lastCartItem` (add-to-cart) can never
 * accidentally wipe the budget/colour/occasion the customer already gave.
 */
export function nextContext(prev: ShoppingContext | null, patch: Partial<ShoppingContext> = {}): ShoppingContext {
  const lastResults = patch.lastResults ?? prev?.lastResults ?? [];
  const shownProductIds = patch.shownProductIds ?? Array.from(new Set([...(prev?.shownProductIds ?? []), ...(patch.lastResults ?? []).map((r) => r.productId)]));
  return {
    filters: patch.filters ?? prev?.filters ?? { keywords: [] },
    gender: "gender" in patch ? patch.gender : prev?.gender,
    color: "color" in patch ? patch.color : prev?.color,
    size: "size" in patch ? patch.size : prev?.size,
    occasion: "occasion" in patch ? patch.occasion : prev?.occasion,
    recipient: "recipient" in patch ? patch.recipient : prev?.recipient,
    style: "style" in patch ? patch.style : prev?.style,
    material: "material" in patch ? patch.material : prev?.material,
    expandedTerms: "expandedTerms" in patch ? patch.expandedTerms : prev?.expandedTerms,
    lastResults,
    shownProductIds,
    comparedProductIds: "comparedProductIds" in patch ? patch.comparedProductIds : undefined,
    lastCartItem: "lastCartItem" in patch ? patch.lastCartItem : prev?.lastCartItem,
    query: "query" in patch ? patch.query : prev?.query,
  };
}

/** Free (non-slot) keywords of a context — what the customer actually named, minus colour/gender which live in their own replaceable slots. */
export function freeKeywords(ctx: ShoppingContext | null): string[] {
  return ctx ? extractReplaceableSlots(ctx.filters.keywords).rest : [];
}

/** Resolves "the second one" / "the last one" / "number 2" against a shown list; null if there's no list or the index is out of range. */
export function resolveOrdinalIndex(text: string, count: number): number | null {
  if (count <= 0) return null;
  const lower = text.toLowerCase();
  const words: [RegExp, number][] = [
    [/\b(?:first|1st)\b/, 0], [/\b(?:second|2nd)\b/, 1], [/\b(?:third|3rd)\b/, 2], [/\b(?:fourth|4th)\b/, 3], [/\b(?:fifth|5th)\b/, 4],
  ];
  for (const [re, idx] of words) if (re.test(lower) && idx < count) return idx;
  if (/\b(?:last|final)\s+(?:one|option|product)\b/.test(lower)) return count - 1;
  const numbered = lower.match(/\b(?:number|no\.?|option|#)\s*(\d)\b/);
  if (numbered) { const idx = Number(numbered[1]) - 1; if (idx >= 0 && idx < count) return idx; }
  return null;
}
