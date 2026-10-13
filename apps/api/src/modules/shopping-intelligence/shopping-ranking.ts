import { fmtMoney, normalizeSearchWord } from "./search-utils";

// Pure hard-constraint, ranking and diversity logic over ALREADY-FETCHED catalogue records. Nothing here (or
// anything an AI interpretation says) can introduce a product, price, variant or stock level — it only decides
// which real records to keep and in what order.

export interface RankVariant { id: string; price: unknown; currency: string; inventory?: number | null; attributes?: unknown }
export interface RankProduct {
  id: string; name: string;
  description?: string | null; brand?: string | null;
  categoryId?: string | null; category?: { name: string } | null;
  variants: RankVariant[];
}
export interface Selected<T extends RankProduct> {
  product: T;
  // the variant that is displayed/linked for this product — always one that satisfies every hard constraint
  variant: T["variants"][number];
  eligible: T["variants"];
  score: number;
}

const priceOf = (v: RankVariant) => Number(String(v.price));
export const isInStock = (v: RankVariant) => v.inventory === null || v.inventory === undefined || v.inventory > 0;

export interface HardConstraints { maxPrice?: number; minPrice?: number; requireStock?: boolean }
export interface HardResult<T extends RankProduct> {
  kept: Selected<T>[];
  excludedForBudget: number;
  excludedForStock: number;
  // the lowest price among in-stock variants that were only excluded for being ABOVE the ceiling — lets the caller say "nothing under X; the cheapest I have is Y" without ever offering the product
  cheapestAboveBudget?: number;
}

/** Applies price ceiling/floor and availability BEFORE any ranking, and pins each product to a variant that actually satisfies them. */
export function applyHardConstraints<T extends RankProduct>(products: T[], c: HardConstraints): HardResult<T> {
  const requireStock = c.requireStock ?? true;
  const kept: Selected<T>[] = [];
  let excludedForBudget = 0;
  let excludedForStock = 0;
  let cheapestAboveBudget: number | undefined;

  for (const product of products) {
    if (!product.variants.length) continue;
    const stocked = product.variants.filter((v) => !requireStock || isInStock(v)) as T["variants"];
    const eligible = stocked.filter((v) => {
      const p = priceOf(v);
      return (c.maxPrice === undefined || p <= c.maxPrice) && (c.minPrice === undefined || p >= c.minPrice);
    }) as T["variants"];
    if (eligible.length) { kept.push({ product, variant: eligible[0], eligible, score: 0 }); continue; }
    if (!stocked.length) { excludedForStock += 1; continue; }
    excludedForBudget += 1;
    if (c.maxPrice !== undefined) {
      const above = Math.min(...stocked.map(priceOf).filter((p) => p > c.maxPrice!));
      if (Number.isFinite(above) && (cheapestAboveBudget === undefined || above < cheapestAboveBudget)) cheapestAboveBudget = above;
    }
  }
  return { kept, excludedForBudget, excludedForStock, cheapestAboveBudget };
}

const attributeValues = (v: RankVariant): string[] =>
  v.attributes && typeof v.attributes === "object" ? Object.values(v.attributes as Record<string, unknown>).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()) : [];

const attributeValuesByKey = (v: RankVariant, keys: string[]): string[] => {
  if (!v.attributes || typeof v.attributes !== "object") return [];
  return Object.entries(v.attributes as Record<string, unknown>)
    .filter(([k, val]) => keys.includes(k.toLowerCase()) && typeof val === "string")
    .map(([, val]) => (val as string).trim().toLowerCase());
};

const productText = (p: RankProduct) => `${p.name} ${p.description ?? ""} ${p.brand ?? ""} ${p.category?.name ?? ""}`.toLowerCase();

export const variantHasColor = (v: RankVariant, color: string) => attributeValues(v).some((x) => x === color || x.split(/[\s/,&-]+/).includes(color));
export const variantHasSize = (v: RankVariant, size: string) => attributeValues(v).some((x) => x === size.toLowerCase());

/** Colours/sizes this product genuinely offers across the given variants — read straight from variant attributes, never inferred. */
export function offeredAttributes(variants: RankVariant[]): { colors: string[]; sizes: string[] } {
  const colors = new Set<string>();
  const sizes = new Set<string>();
  for (const v of variants) {
    attributeValuesByKey(v, ["color", "colour"]).forEach((x) => colors.add(x));
    attributeValuesByKey(v, ["size"]).forEach((x) => sizes.add(x));
  }
  return { colors: [...colors], sizes: [...sizes] };
}

/** Splits already hard-filtered products by whether they offer the requested colour/size (via a real variant attribute, or — for colour — the product's own text). Matching products are re-pinned to a matching variant. */
export function splitByAttributes<T extends RankProduct>(selected: Selected<T>[], want: { color?: string; size?: string }): { matching: Selected<T>[]; others: Selected<T>[] } {
  if (!want.color && !want.size) return { matching: selected, others: [] };
  const matching: Selected<T>[] = [];
  const others: Selected<T>[] = [];
  for (const s of selected) {
    const textColor = !!want.color && productText(s.product).includes(want.color);
    const ok = s.eligible.filter((v) => (!want.size || variantHasSize(v, want.size)) && (!want.color || textColor || variantHasColor(v, want.color))) as T["variants"];
    if (ok.length) matching.push({ ...s, variant: ok[0], eligible: ok });
    else others.push(s);
  }
  return { matching, others };
}

/** Term-overlap score (name > category > brand > description > variant attributes), plus a smaller weight for model-proposed broadening terms. Stable: ties keep the incoming (database) order. */
export function rankProducts<T extends RankProduct>(selected: Selected<T>[], terms: string[], expandedTerms: string[] = []): Selected<T>[] {
  const score = (s: Selected<T>) => {
    const name = s.product.name.toLowerCase();
    const category = (s.product.category?.name ?? "").toLowerCase();
    const brand = (s.product.brand ?? "").toLowerCase();
    const description = (s.product.description ?? "").toLowerCase();
    const attrs = s.eligible.flatMap(attributeValues).join(" ");
    let total = 0;
    for (const raw of terms) {
      const t = normalizeSearchWord(raw);
      total += name.includes(t) ? 3 : category.includes(t) ? 2 : brand.includes(t) ? 1.5 : description.includes(t) ? 1 : attrs.includes(t) ? 1 : 0;
    }
    for (const raw of expandedTerms) {
      const t = normalizeSearchWord(raw);
      if (name.includes(t) || category.includes(t) || description.includes(t)) total += 0.75;
    }
    return total;
  };
  return selected.map((s, i) => ({ s: { ...s, score: score(s) }, i })).sort((a, b) => b.s.score - a.s.score || a.i - b.i).map((x) => x.s);
}

/** Greedy diversity selection: each pick is penalised for repeating a category / near-identical price already chosen, so a "show me options" answer spans the catalogue instead of five variants of one thing. */
export function selectDiverse<T extends RankProduct>(ranked: Selected<T>[], limit: number): Selected<T>[] {
  const pool = [...ranked];
  const chosen: Selected<T>[] = [];
  while (chosen.length < limit && pool.length) {
    let best = 0;
    let bestScore = -Infinity;
    pool.forEach((s, i) => {
      const sameCategory = chosen.filter((c) => (c.product.categoryId && c.product.categoryId === s.product.categoryId) || (c.product.category?.name && c.product.category.name === s.product.category?.name)).length;
      const nearPrice = chosen.filter((c) => Math.abs(priceOf(c.variant) - priceOf(s.variant)) / Math.max(priceOf(c.variant), priceOf(s.variant), 1) < 0.1).length;
      const eff = s.score - sameCategory * 1 - nearPrice * 0.3;
      if (eff > bestScore) { bestScore = eff; best = i; }
    });
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen;
}

/** Up to two short, strictly factual reasons a product fits — only things true of the real record or the customer's own stated constraints. */
export function buildReason(s: Selected<RankProduct>, c: { maxPrice?: number; terms: string[]; color?: string }): string | null {
  const reasons: string[] = [];
  if (c.color && variantHasColor(s.variant, c.color)) reasons.push(`in ${c.color}`);
  const name = s.product.name.toLowerCase();
  const hit = c.terms.find((t) => name.includes(normalizeSearchWord(t)));
  if (hit) reasons.push(`matches "${hit}"`);
  if (c.maxPrice !== undefined) reasons.push(`within ${fmtMoney(c.maxPrice, s.variant.currency)}`);
  if (!reasons.length && s.product.category?.name) reasons.push(`from ${s.product.category.name}`);
  return reasons.length ? reasons.slice(0, 2).join(", ") : null;
}

/** Same-category / name-overlap affinity to a reference product — for "similar ones" and "other options" when there's no search to re-run. */export function similarityScore(reference: RankProduct, candidate: RankProduct): number {
  let score = 0;
  if (reference.categoryId && reference.categoryId === candidate.categoryId) score += 3;
  else if (reference.category?.name && reference.category.name === candidate.category?.name) score += 3;
  if (reference.brand && reference.brand === candidate.brand) score += 1;
  const refWords = new Set(reference.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(normalizeSearchWord));
  for (const w of candidate.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(normalizeSearchWord)) if (refWords.has(w)) score += 1;
  return score;
}

/**
 * "Something cheaper": a price ceiling strictly below the product the customer is looking at (`single`), or below
 * the median of the products they were just shown. Never exceeds an existing ceiling. Null when no lower price is possible.
 */
export function cheaperCeiling(prices: number[], single: boolean, currentMax?: number): number | null {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const reference = single ? sorted[0] : sorted[Math.floor((sorted.length - 1) / 2)];
  const ceiling = Math.ceil(reference) - 1;
  const max = currentMax !== undefined ? Math.min(currentMax, ceiling) : ceiling;
  return max > 0 ? max : null;
}
