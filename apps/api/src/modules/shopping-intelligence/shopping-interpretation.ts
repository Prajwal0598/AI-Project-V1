import { extractAmounts, extractReplaceableSlots, parseSearchQuery } from "./search-utils";
import { freeKeywords, resolveOrdinalIndex, type ShoppingContext } from "./shopping-context";

export type ShoppingIntent = "SEARCH" | "REFINE" | "ALTERNATIVES" | "SIMILAR" | "SELECT_PRODUCT" | "VARIANT_REQUEST" | "UNCLEAR";
export type TopicRelation = "NEW_TOPIC" | "REFINEMENT" | "CONTINUATION";
export type RequestKind = "SEARCH" | "ALTERNATIVES" | "QUESTION" | "COMMERCE_ACTION";

/**
 * Structured reading of ONE customer message against the persisted ShoppingContext. Everything here is a
 * REQUEST/SIGNAL — never authoritative catalogue data: it carries no product IDs, prices, stock or order state.
 * The backend resolves it against the real catalogue and applies the hard constraints itself.
 */
export interface ShoppingInterpretation {
  intent: ShoppingIntent;
  confidence: number;
  topicRelation: TopicRelation;
  requestKind: RequestKind;
  // free keywords the customer named (colour/gender/size/budget/markers already removed) — occasion + descriptor words included, they're matched when the catalogue literally has them
  terms: string[];
  // terms that name WHAT is wanted (product type etc.), as opposed to descriptors/occasion words — drives new-topic detection and relaxation
  coreTerms: string[];
  color?: string;
  gender?: string;
  size?: string;
  occasion?: string;
  recipient?: string;
  style?: string;
  material?: string;
  budget: { min?: number; max?: number };
  // which constraints the retrieval must NEVER relax; everything else is a preference that may be relaxed, honestly
  hardConstraints: string[];
  reference?: { kind: "ORDINAL" | "PREVIOUS_PRODUCT"; index?: number };
  wantsCheaper: boolean;
  wantsAlternatives: boolean;
  wantsSimilar: boolean;
  // semantic broadening proposed by the model (related product types) — soft, only ever used to widen a failed search
  expandedTerms: string[];
  // set when the topic decision was a guess (no overlap, no explicit request frame) — lets the caller recover if the combined search finds nothing
  ambiguousTopic: boolean;
  clarification?: string;
  source: "deterministic" | "model+deterministic";
}

// words that steer the conversation but never name a product — kept out of the search terms so e.g. "other
// options", "something cheaper" or "do you have this in white?" aren't searched literally
const MARKER_WORDS = new Set([
  "other", "another", "different", "else", "alternatives", "alternative", "similar", "ones", "one", "more", "less",
  "cheaper", "cheap", "lower", "pricier", "pricey", "affordable", "expensive",
  "this", "that", "these", "those", "it", "them", "same", "size", "sizes", "colour", "colours", "color", "colors",
  "available", "stock", "variant", "kind", "type", "like", "could", "can", "let", "know", "tell", "just", "really",
  "pls", "plz", "thanks", "thank", "ok", "okay", "hi", "hello", "hey", "yes", "no", "yeah", "new", "latest",
  "actually", "maybe", "perhaps", "now", "anyway",
  // ordinal references to a shown list ("the SECOND one", "option 2") are handled as a selection, not searched
  "first", "second", "third", "fourth", "fifth", "1st", "2nd", "3rd", "4th", "5th", "last", "final", "number", "option",
]);

const STYLE_WORDS = new Set([
  "casual", "formal", "ethnic", "traditional", "modern", "minimal", "minimalist", "boho", "classic", "elegant", "sporty",
  "vintage", "classy", "trendy", "stylish", "comfortable", "comfy", "chic", "festive", "strappy", "slim", "relaxed", "premium", "luxury",
]);
const MATERIAL_WORDS = new Set(["cotton", "silk", "linen", "leather", "denim", "wool", "satin", "velvet", "pearl", "pearls", "gold", "silver", "steel", "wooden", "wood"]);
// generic nouns that describe a look rather than a product type ("party WEAR", "wedding OUTFIT")
const GENERIC_NOUNS = new Set(["wear", "outfit", "outfits", "clothes", "clothing", "look", "looks", "style", "styles", "stuff", "things", "thing", "gift", "gifts"]);

const OCCASIONS: [RegExp, string][] = [
  [/\bdate[\s-]*nights?\b|\bromantic (?:dinner|evening)\b/, "date night"],
  [/\bgift(?:s|ing)?\b/, "gift"],
  [/\bwedding|bridal|shaadi\b/, "wedding"],
  [/\bparty|cocktail\b/, "party"],
  [/\bbirthday\b/, "birthday"],
  [/\banniversary\b/, "anniversary"],
  [/\bvacation|holiday|honeymoon\b/, "vacation"],
  [/\boffice|workwear\b/, "office"],
  [/\bfestive|festival|diwali|eid|christmas\b/, "festive"],
];
const OCCASION_WORDS = new Set(["date", "night", "gift", "gifts", "gifting", "wedding", "bridal", "shaadi", "party", "cocktail", "birthday", "anniversary", "vacation", "holiday", "honeymoon", "office", "workwear", "festive", "festival", "diwali", "eid", "christmas", "weekend"]);

/** Terms that name WHAT is wanted (a product type), as opposed to a style/material/occasion descriptor or a generic noun like "outfit". */
export function coreTermsOf(terms: string[]): string[] {
  return terms.filter((w) => !STYLE_WORDS.has(w) && !MATERIAL_WORDS.has(w) && !OCCASION_WORDS.has(w) && !GENERIC_NOUNS.has(w));
}

const RECIPIENT_RE = /\bfor (?:my |a |an |the )?(girlfriend|boyfriend|wife|husband|mom|mother|dad|father|sister|brother|friend|son|daughter|kids?|him|her|girlfriend)\b/;
const ALTERNATIVES_RE = /\b(other|another|different|alternatives?|something else|anything else|any more|more options|more like)\b/;
const SIMILAR_RE = /\bsimilar\b|\blike (?:this|that|it)\b|\bsame (?:kind|type|style)\b/;
const CHEAPER_RE = /\b(cheaper|less expensive|lower price|lower budget|more affordable|budget[- ]friendly|cheap)\b/;
const CONTINUATION_RE = /\b(also|too|as well|plus|along with|in addition|and also)\b/;
const DEICTIC_RE = /\b(this|that|it|these|those|the same)\b/;
// an explicit "I'm asking for something" opener — a fresh ask rather than a bare refinement fragment
const REQUEST_FRAME_RE = /^\s*(?:(?:hi|hello|hey)\b[\s,!.]*)?(?:do you\b|have you\b|got any\b|show me\b|i(?:'d| would)? (?:like|want|need)\b|i'?m looking\b|looking for\b|can i (?:see|get|have)\b|is there\b|are there\b|any\b)/i;
const SIZE_RE = /\b(?:in\s+)?(?:size|sz)\s+([a-z0-9]{1,4})\b|\b(xxs|xs|xl|xxl|xxxl)\b/i;

const norm = (w: string) => w.toLowerCase().replace(/s$/, "");
const unique = <T>(xs: T[]) => Array.from(new Set(xs));

function detectOccasion(lower: string): string | undefined {
  for (const [re, label] of OCCASIONS) if (re.test(lower)) return label;
  return undefined;
}

/** Deterministic interpretation — complete and safe on its own; the model (when available) only refines it, see mergeInterpretations. */
export function interpretDeterministically(rawText: string, ctx: ShoppingContext | null, opts: { activeProductId?: string | null } = {}): ShoppingInterpretation {
  const lower = rawText.trim().toLowerCase();

  const sizeMatch = lower.match(SIZE_RE);
  const size = sizeMatch ? (sizeMatch[1] ?? sizeMatch[2]).toLowerCase() : undefined;
  const parsed = parseSearchQuery(sizeMatch ? lower.replace(sizeMatch[0], " ") : lower);
  const { gender, color, rest } = extractReplaceableSlots(parsed.keywords);
  const terms = unique(rest.filter((w) => !MARKER_WORDS.has(w) && !/^\d+$/.test(w)));
  const coreTerms = coreTermsOf(terms);

  const occasion = detectOccasion(lower);
  const recipient = lower.match(RECIPIENT_RE)?.[1];
  const style = terms.find((w) => STYLE_WORDS.has(w));
  const material = terms.find((w) => MATERIAL_WORDS.has(w));

  const wantsCheaper = CHEAPER_RE.test(lower);
  const wantsAlternatives = ALTERNATIVES_RE.test(lower);
  const wantsSimilar = SIMILAR_RE.test(lower);
  const ordinalIdx = resolveOrdinalIndex(lower, 10);
  const hasSlots = !!(color || gender || size || parsed.maxPrice !== undefined || parsed.minPrice !== undefined);

  // --- topic: continue/refine the existing search, or start a new one? ---
  const priorFree = freeKeywords(ctx);
  // a real product/occasion topic to switch AWAY from — as opposed to constraints alone (a budget, colour or gender
  // given before any product was named), which a later product request simply builds on
  const priorTopicful = priorFree.length > 0 || !!ctx?.occasion;
  const hasPriorConstraints = priorTopicful || ctx?.filters.maxPrice !== undefined || ctx?.filters.minPrice !== undefined || !!ctx?.color || !!ctx?.gender;
  const priorSet = new Set(priorFree.map(norm));
  const overlaps = terms.some((t) => priorSet.has(norm(t)));
  const frame = REQUEST_FRAME_RE.test(lower);
  const newOccasion = !!occasion && occasion !== ctx?.occasion;

  let topicRelation: TopicRelation;
  let ambiguousTopic = false;
  if (!hasPriorConstraints) topicRelation = "NEW_TOPIC";
  else if (!priorTopicful) topicRelation = "REFINEMENT";
  else if (terms.length === 0 && !occasion) topicRelation = hasSlots || wantsAlternatives || wantsSimilar || wantsCheaper ? "REFINEMENT" : "CONTINUATION";
  else if (overlaps || CONTINUATION_RE.test(lower)) topicRelation = "REFINEMENT";
  else if ((frame && coreTerms.length > 0) || (newOccasion && (frame || /\bgifts?\b/.test(lower) || !!ctx?.occasion))) topicRelation = "NEW_TOPIC";
  else { topicRelation = "REFINEMENT"; ambiguousTopic = true; }

  // --- intent ---
  let intent: ShoppingIntent;
  let confidence: number;
  if (ordinalIdx !== null && terms.length === 0) { intent = "SELECT_PRODUCT"; confidence = 0.9; }
  else if (wantsAlternatives && coreTerms.length === 0) { intent = "ALTERNATIVES"; confidence = 0.85; }
  else if (wantsSimilar && coreTerms.length === 0) { intent = "SIMILAR"; confidence = 0.85; }
  else if (!terms.length && !occasion && !hasSlots && !wantsCheaper) { intent = "UNCLEAR"; confidence = 0.3; }
  else if (!terms.length && !occasion) { intent = ctx ? "REFINE" : "SEARCH"; confidence = 0.85; }
  else if (coreTerms.length === 0) { intent = "SEARCH"; confidence = 0.55; } // occasion/vibe only — the model can usually say what that means
  else { intent = "SEARCH"; confidence = ambiguousTopic ? 0.6 : 0.85; }

  const asksForVariantOfCurrent = !!opts.activeProductId && terms.length === 0 && !occasion && (!!size || (!!color && DEICTIC_RE.test(lower)));
  if (asksForVariantOfCurrent) { intent = "VARIANT_REQUEST"; confidence = 0.85; }

  const requestKind: RequestKind = intent === "ALTERNATIVES" || intent === "SIMILAR" ? "ALTERNATIVES" : intent === "SELECT_PRODUCT" ? "COMMERCE_ACTION" : lower.includes("?") && terms.length === 0 ? "QUESTION" : "SEARCH";

  return {
    intent, confidence, topicRelation, requestKind, terms, coreTerms,
    color, gender, size, occasion, recipient, style, material,
    budget: { min: parsed.minPrice, max: parsed.maxPrice },
    // price ceiling/floor and availability are never relaxed; an explicitly named size on a specific product is a variant requirement too
    hardConstraints: ["budget", "availability", ...(size ? ["size"] : [])],
    reference: ordinalIdx !== null ? { kind: "ORDINAL", index: ordinalIdx } : (wantsSimilar || wantsAlternatives) ? { kind: "PREVIOUS_PRODUCT" } : undefined,
    wantsCheaper, wantsAlternatives, wantsSimilar,
    expandedTerms: [], ambiguousTopic,
    clarification: intent === "UNCLEAR" ? "What kind of product are you looking for — or who is it for? I'll narrow it down from there." : undefined,
    source: "deterministic",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Model-assisted interpretation: strict structured output + validation. The model can only ever PROPOSE; every
// field is checked here and discarded if it doesn't hold up, and nothing it says is authoritative about the catalogue.
// ---------------------------------------------------------------------------------------------------------------

export const INTERPRETATION_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["SEARCH", "REFINE", "ALTERNATIVES", "SIMILAR", "SELECT_PRODUCT", "UNCLEAR"] },
    confidence: { type: "number", description: "0 to 1: how sure you are about this reading of the message." },
    topicRelation: { type: "string", enum: ["NEW_TOPIC", "REFINEMENT", "CONTINUATION"], description: "NEW_TOPIC when the customer asks for a different kind of product than the current search; REFINEMENT when they narrow/adjust it; CONTINUATION when they continue it without changing it." },
    productTerms: { type: "array", items: { type: "string" }, description: "Product types the customer named, e.g. saree, earrings. Lowercase single words." },
    expandedTerms: { type: "array", items: { type: "string" }, description: "Up to 6 related product types a shop might stock that would satisfy this request (e.g. for a date night gift: perfume, earrings, clutch). Lowercase single words. Empty if the request is already specific." },
    occasion: { type: ["string", "null"] },
    recipient: { type: ["string", "null"] },
    style: { type: ["string", "null"] },
    material: { type: ["string", "null"] },
    budgetMin: { type: ["number", "null"], description: "Only if the customer stated a minimum price in their own words." },
    budgetMax: { type: ["number", "null"], description: "Only if the customer stated a maximum price in their own words." },
    clarificationQuestion: { type: ["string", "null"], description: "ONE short question, only if the request is genuinely ambiguous. Otherwise null." },
  },
  required: ["intent", "confidence", "topicRelation", "productTerms", "expandedTerms", "occasion", "recipient", "style", "material", "budgetMin", "budgetMax", "clarificationQuestion"],
  additionalProperties: false,
} as const;

export interface ModelInterpretation {
  intent: ShoppingIntent;
  confidence: number;
  topicRelation: TopicRelation;
  productTerms: string[];
  expandedTerms: string[];
  occasion?: string;
  recipient?: string;
  style?: string;
  material?: string;
  budgetMin?: number;
  budgetMax?: number;
  clarification?: string;
}

const INTENTS = new Set<string>(["SEARCH", "REFINE", "ALTERNATIVES", "SIMILAR", "SELECT_PRODUCT", "UNCLEAR"]);
const TOPICS = new Set<string>(["NEW_TOPIC", "REFINEMENT", "CONTINUATION"]);
const WORD_RE = /^[a-z][a-z'-]{1,24}$/;

function cleanWords(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return unique(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => WORD_RE.test(x))).slice(0, max);
}
const cleanLabel = (v: unknown): string | undefined => (typeof v === "string" && /^[a-z][a-z' -]{1,30}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined);

/** Parses + validates raw model output. Returns null (caller falls back to the deterministic reading) unless it is well-formed. A budget is accepted only if that exact amount appears in the customer's own message. */
export function validateModelInterpretation(raw: unknown, customerText: string): ModelInterpretation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.intent !== "string" || !INTENTS.has(r.intent)) return null;
  if (typeof r.topicRelation !== "string" || !TOPICS.has(r.topicRelation)) return null;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) return null;

  const stated = extractAmounts(customerText);
  const grounded = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && stated.some((s) => Math.abs(s - v) < 0.01) ? v : undefined);
  const clarification = typeof r.clarificationQuestion === "string" && r.clarificationQuestion.trim() && r.clarificationQuestion.length <= 160 && !/[0-9₹]/.test(r.clarificationQuestion) ? r.clarificationQuestion.trim() : undefined;

  return {
    intent: r.intent as ShoppingIntent,
    confidence: Math.min(1, Math.max(0, r.confidence)),
    topicRelation: r.topicRelation as TopicRelation,
    productTerms: cleanWords(r.productTerms, 6),
    expandedTerms: cleanWords(r.expandedTerms, 6),
    occasion: cleanLabel(r.occasion), recipient: cleanLabel(r.recipient), style: cleanLabel(r.style), material: cleanLabel(r.material),
    budgetMin: grounded(r.budgetMin), budgetMax: grounded(r.budgetMax),
    clarification,
  };
}

/** Folds a validated model reading into the deterministic one. Deterministic numbers/slots always win; the model fills gaps and settles topic/intent only where the deterministic reading was unsure. */
export function mergeInterpretations(det: ShoppingInterpretation, model: ModelInterpretation): ShoppingInterpretation {
  const useModelTopic = (det.ambiguousTopic || det.confidence < 0.75) && model.confidence >= 0.6;
  const intent = det.intent === "UNCLEAR" && model.confidence >= 0.6 && model.intent !== "SELECT_PRODUCT" ? model.intent : det.intent;
  const known = new Set([...det.terms, ...(det.color ? [det.color] : []), ...(det.gender ? [det.gender] : [])]);
  return {
    ...det,
    intent,
    confidence: Math.max(det.confidence, useModelTopic ? Math.min(0.85, model.confidence) : det.confidence),
    topicRelation: useModelTopic ? model.topicRelation : det.topicRelation,
    ambiguousTopic: useModelTopic ? false : det.ambiguousTopic,
    occasion: det.occasion ?? model.occasion,
    recipient: det.recipient ?? model.recipient,
    style: det.style ?? model.style,
    material: det.material ?? model.material,
    budget: { min: det.budget.min ?? model.budgetMin, max: det.budget.max ?? model.budgetMax },
    expandedTerms: model.expandedTerms.filter((t) => !known.has(t)),
    clarification: det.intent === "UNCLEAR" ? model.clarification ?? det.clarification : det.clarification,
    source: "model+deterministic",
  };
}
