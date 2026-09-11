// canonical product fields an uploaded catalogue row can be mapped onto
export interface NormalizedRow {
  name?: string;
  sku?: string;
  price?: number;
  currency?: string;
  compareAtPrice?: number;
  costPrice?: number;
  inventory?: number;
  category?: string;
  description?: string;
  brand?: string;
  barcode?: string;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  color?: string;
  size?: string;
}

export type CanonicalField = keyof NormalizedRow;

// deterministic header aliases (Phase 1 — no AI fallback yet; unrecognized headers are simply left unmapped).
// Order matters: more specific fields are listed first so e.g. "Cost Price" is matched before generic "Price".
const FIELD_ALIASES: [CanonicalField, string[]][] = [
  ["sku", ["sku", "code", "item code", "product code"]],
  ["barcode", ["barcode", "upc", "ean"]],
  ["compareAtPrice", ["mrp", "compare at price", "original price", "list price"]],
  ["costPrice", ["cost", "cost price", "purchase price"]],
  ["price", ["price", "selling price", "sp", "sale price", "unit price", "rate"]],
  ["inventory", ["inventory", "stock", "qty", "quantity", "stock qty", "available", "available qty", "inventory quantity"]],
  ["weight", ["weight", "weight kg"]],
  ["length", ["length", "package length", "length cm"]],
  ["width", ["width", "package width", "width cm"]],
  ["height", ["height", "package height", "height cm"]],
  ["color", ["color", "colour"]],
  ["size", ["size", "variant size"]],
  ["category", ["category", "type", "product type"]],
  ["brand", ["brand", "manufacturer"]],
  ["currency", ["currency"]],
  ["description", ["description", "desc", "details"]],
  ["name", ["name", "product", "product name", "item", "item name", "title"]],
];

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// currency/unit annotations that commonly ride along in a header (e.g. "MRP (INR)", "Weight (kg)") and
// should be ignored for matching purposes, but aren't meaningfully distinct extra words like "URL"/"Code"
const NOISE_WORDS = new Set(["inr", "usd", "rs", "rupees", "dollars", "kg", "kgs", "g", "cm", "mm", "in", "lb", "lbs"]);

function significantWords(header: string): Set<string> {
  const words = normalizeHeader(header).split(" ").filter(Boolean);
  const filtered = words.filter((w) => !NOISE_WORDS.has(w));
  return new Set(filtered.length ? filtered : words); // don't strip down to nothing if the header is ONLY a unit
}

/**
 * Maps each source column header to a canonical field, tolerating extra words (units, currency codes,
 * parenthetical annotations) around a known alias — e.g. "Selling Price (INR)" still matches "selling price".
 * When multiple fields' aliases are contained in a header, the alias with the most words wins (most specific).
 * Single-word aliases (e.g. "name", "product") must match the ENTIRE header exactly — otherwise generic
 * words like "product" would false-positive against unrelated headers like "Product URL".
 */
export function detectColumnMapping(headers: string[]): Record<string, CanonicalField | null> {
  const mapping: Record<string, CanonicalField | null> = {};
  for (const header of headers) {
    const headerWords = significantWords(header);
    let matched: CanonicalField | null = null;
    let matchedWordCount = 0;
    for (const [field, aliases] of FIELD_ALIASES) {
      for (const alias of aliases) {
        const aliasWords = alias.split(" ").filter(Boolean);
        if (aliasWords.length <= matchedWordCount) continue; // already found an equal-or-better match
        const isMatch = aliasWords.length === 1 ? headerWords.size === 1 && headerWords.has(aliasWords[0]) : aliasWords.every((w) => headerWords.has(w));
        if (isMatch) { matched = field; matchedWordCount = aliasWords.length; }
      }
    }
    mapping[header] = matched;
  }
  return mapping;
}

const NUMERIC_FIELDS = new Set<CanonicalField>(["price", "compareAtPrice", "costPrice", "inventory", "weight", "length", "width", "height"]);

/** Applies a column mapping to one raw source row, producing a canonical (but not yet validated) row. */
export function normalizeRawRow(raw: Record<string, unknown>, mapping: Record<string, CanonicalField | null>): NormalizedRow {
  const normalized: NormalizedRow = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (!field) continue;
    const value = raw[header];
    if (value === undefined || value === null || value === "") continue;
    if (NUMERIC_FIELDS.has(field)) {
      const num = typeof value === "number" ? value : Number(String(value).replace(/[,₹$]/g, "").trim());
      (normalized as Record<string, unknown>)[field] = Number.isNaN(num) ? String(value) : num; // keep the raw string when unparsable so validation can flag it
    } else {
      (normalized as Record<string, unknown>)[field] = String(value).trim();
    }
  }
  return normalized;
}

