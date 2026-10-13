import { extractReplaceableSlots, type SearchFilters } from "./search-utils";
import { freeKeywords, type ShoppingContext } from "./shopping-context";
import type { ShoppingInterpretation } from "./shopping-interpretation";

export interface MergedTopic {
  filters: SearchFilters;
  gender?: string;
  color?: string;
  size?: string;
  occasion?: string;
  recipient?: string;
  style?: string;
  material?: string;
  expandedTerms: string[];
  // every keyword that must be matched for an EXACT result: free keywords + the current colour/gender slot values
  effectiveKeywords: string[];
  // true when the previous topic's constraints were intentionally dropped (new topic)
  reset: boolean;
}

/**
 * Merges this turn's interpretation onto the persisted context. A NEW_TOPIC starts from nothing — so a saree's
 * colour/budget never leak into a later "pearl earrings" request — while a refinement keeps accumulating free
 * keywords and lets a newly stated colour/gender/size/budget REPLACE the old one (never AND both).
 */
export function mergeTopic(prev: ShoppingContext | null, interp: ShoppingInterpretation): MergedTopic {
  const reset = interp.topicRelation === "NEW_TOPIC";
  const base = reset ? null : prev;
  const priorFree = freeKeywords(base);

  const filters: SearchFilters = {
    keywords: Array.from(new Set([...priorFree, ...interp.terms])),
    maxPrice: interp.budget.max ?? base?.filters.maxPrice,
    minPrice: interp.budget.min ?? base?.filters.minPrice,
  };
  const gender = interp.gender ?? base?.gender;
  const color = interp.color ?? base?.color;
  return {
    filters, gender, color,
    size: interp.size ?? base?.size,
    occasion: interp.occasion ?? base?.occasion,
    recipient: interp.recipient ?? base?.recipient,
    style: interp.style ?? base?.style,
    material: interp.material ?? base?.material,
    expandedTerms: interp.expandedTerms.length ? interp.expandedTerms : reset ? [] : base?.expandedTerms ?? [],
    effectiveKeywords: [...filters.keywords, ...(gender ? [gender] : []), ...(color ? [color] : [])],
    reset,
  };
}

/** Re-derives the free keywords of already-merged filters (colour/gender live in their own slots) — used when a handler narrows a previous result set. */
export function splitKeywords(keywords: string[]): string[] {
  return extractReplaceableSlots(keywords).rest;
}
