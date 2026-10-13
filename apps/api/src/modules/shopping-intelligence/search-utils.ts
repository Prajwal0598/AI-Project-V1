// Pure, dependency-free search helpers shared by ShoppingFlowService, AssistedBuyingService and AiService.
// Lives outside shopping-flow.service.ts so the new shopping-intelligence layer can use them without a
// circular import (ShoppingFlowService depends on that layer); shopping-flow.service.ts re-exports the public ones.

export interface SearchFilters { maxPrice?: number; minPrice?: number; keywords: string[] }

// ordinal words a customer might use to refer back to a just-shown result list ("show me the first one")
export const ORDINAL_WORDS: Record<string, number> = {
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
export const SEARCH_STOPWORDS = new Set([
  "show", "me", "i", "want", "need", "looking", "for", "a", "an", "the", "do", "you", "have", "any", "some",
  "please", "find", "search", "got", "is", "are", "there", "something", "anything", "nice", "good",
  "what", "which", "products", "product", "items", "item", "options",
  "on", "in", "would", "who", "someone", "but", "not", "too", "going", "recommend", "attending", "suitable", "loves",
  "preferably", "prefer", "ideally", "instead",
  // pronouns/grammar/filler that show up heavily in multi-turn gift-recommendation chatter ("She ALSO likes
  // accessories", "which one would you PERSONALLY recommend") plus gift-recipient words ("for MY GIRLFRIEND")
  // that describe who the product is for, not an attribute of the product itself
  "my", "her", "him", "she", "he", "also", "likes", "give", "your", "personally",
  "girlfriend", "boyfriend", "wife", "husband", "mom", "mother", "dad", "father", "sister", "brother", "son", "daughter",
  // currency words left behind once the amount itself has been consumed by the budget parser
  "rs", "inr", "rupee", "rupees",
  // function words that were being AND-required as literal keywords ("black AND white shirt", "something TO wear"),
  // which both matches unrelated products by substring ("and" inside "Sandals") and breaks genuine matches
  "and", "with", "of", "to", "at", "as", "by", "or", "if", "so", "we", "us", "am", "be", "ll", "ve", "re", "than", "then",
  // question/verb filler that is never a product attribute ("what ABOUT size 8?", "HOW do I ...", "can I SEE ...", "I want to BUY ...")
  "about", "how", "when", "where", "why", "does", "did", "will", "should", "may", "might", "from", "into", "very", "much",
  "many", "most", "all", "see", "buy", "purchase", "get", "let", "lets", "know", "think", "check", "wondering",
]);

// messages asking what the store carries at all, rather than searching for something specific — must be
// checked before running a keyword search, otherwise e.g. "What do you sell?" gets searched literally and
// returns "No products matched that search."
export const STORE_DISCOVERY_RE = /\b(what do you (sell|offer|have|stock)|what (products?|items?|categories?) do you (have|sell|offer|stock)|what (products?|items?|categories?) (are (available|there)|do you have)|show me (your|the) (products?|catalogue|catalog|store|items?)|what can i (buy|get|purchase)|what do you (guys )?have)\b/i;

// a later mention of one of these should REPLACE the earlier one in persisted context, not accumulate
// alongside it — see extractReplaceableSlots. Deliberately a small, hand-picked list (not exhaustive) since a
// false miss just falls back to ordinary keyword accumulation, which is safe, whereas a false hit would
// silently drop a word from a genuine product-name/description match.
export const GENDER_WORDS: Record<string, string> = {
  men: "men", man: "men", mens: "men", male: "men", boys: "men", boy: "men",
  women: "women", woman: "women", womens: "women", female: "women", girls: "women", girl: "women",
  unisex: "unisex", kids: "kids", kid: "kids", children: "kids",
};
export const COLOR_WORDS = new Set([
  "white", "black", "red", "blue", "green", "yellow", "pink", "purple", "orange", "brown",
  "grey", "gray", "navy", "beige", "gold", "silver", "maroon", "cream", "tan", "olive", "turquoise", "magenta",
]);

export function extractReplaceableSlots(keywords: string[]): { gender?: string; color?: string; rest: string[] } {
  let gender: string | undefined;
  let color: string | undefined;
  const rest: string[] = [];
  for (const kw of keywords) {
    if (!gender && GENDER_WORDS[kw]) { gender = GENDER_WORDS[kw]; continue; }
    if (!color && COLOR_WORDS.has(kw)) { color = kw; continue; }
    rest.push(kw);
  }
  return { gender, color, rest };
}

// "1,500" / "1,50,000" (Indian grouping) / "2999" / "2.5k" — the amount group of every budget phrase below
const CURRENCY = "(?:rs\\.?|inr|₹|rupees?)?";
const AMOUNT = "(\\d{1,3}(?:,\\d{2,3})+|\\d+)(\\.\\d+)?\\s*(k\\b)?";
const MAX_RE = new RegExp(`(?:under|below|less than|cheaper than|within|upto|up to|at most|not more than|no more than|maximum(?: of)?|max(?: of)?|budget(?: of| is)?)\\s*${CURRENCY}\\s*${AMOUNT}`);
const MIN_RE = new RegExp(`(?:over|above|more than|at least|minimum(?: of)?|min(?: of)?)\\s*${CURRENCY}\\s*${AMOUNT}`);

function toAmount(match: RegExpMatchArray): number {
  const whole = match[1].replace(/,/g, "");
  const value = Number(`${whole}${match[2] ?? ""}`) * (match[3] ? 1000 : 1);
  return Math.round(value * 100) / 100;
}

/** Every number a customer could plausibly have meant as an amount in `text` ("1,500", "3k", "2999") — used to verify that a model-provided budget actually appears in the customer's own words. */
export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(new RegExp(AMOUNT, "g"))) out.push(toAmount(m));
  return out;
}

/** Deterministic (non-LLM) parsing for queries like "black shoes under 2500", "gift under ₹1,500" or "jackets above 1k". */
export function parseSearchQuery(text: string): SearchFilters {
  let remaining = text.toLowerCase();
  let maxPrice: number | undefined;
  let minPrice: number | undefined;

  // MAX is matched first and removed so "not more than 2000" is never re-read as a MIN ("more than 2000")
  const under = remaining.match(MAX_RE);
  if (under) { maxPrice = toAmount(under); remaining = remaining.replace(under[0], " "); }
  const over = remaining.match(MIN_RE);
  if (over) { minPrice = toAmount(over); remaining = remaining.replace(over[0], " "); }

  const keywords = remaining.split(/[^a-z0-9]+/).map((w) => w.trim()).filter((w) => w.length > 1 && !SEARCH_STOPWORDS.has(w));
  return { maxPrice, minPrice, keywords };
}

// crude singular/plural normalization ("bags" <-> "bag") so a keyword also matches a product literally named
// with the other form (e.g. a search for "shirts" still matches a product named "Black Premium Shirt") without
// needing a real stemming library for this deterministic V1
export function normalizeSearchWord(word: string): string {
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

export function formatVariantLabel(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const values = Object.values(attributes as Record<string, string>).filter(Boolean);
  return values.length ? values.join(", ") : null;
}
