import type { NormalizedRow } from "./field-mapping";

export interface RowValidationResult {
  status: "READY" | "WARNING" | "ERROR";
  errors: string[];
  matchedProductId: string | null;
  action: "CREATE" | "UPDATE" | "SKIP";
}

export interface ExistingVariantRef {
  sku: string;
  productId: string;
}

/**
 * Validates one normalized row against the catalogue import rules (spec section 9).
 * `duplicateSkuInFile` — true if this row's SKU appears more than once in the same upload.
 * `existingBySku` — lowercased-SKU -> existing product, for detecting SKU-already-exists rows.
 * `existingNamesLower` — lowercased names of products already in the business, for duplicate-name warnings.
 */
export function validateRow(
  row: NormalizedRow,
  opts: { duplicateSkuInFile: boolean; existingBySku: Map<string, ExistingVariantRef>; existingNamesLower: Set<string> }
): RowValidationResult {
  const errors: string[] = [];

  if (!row.name || !row.name.trim()) errors.push("Product name is required.");
  if (row.price === undefined || row.price === null || row.price === "" as unknown) errors.push("Price is required.");
  else if (typeof row.price !== "number" || Number.isNaN(row.price)) errors.push("Price must be a number.");
  else if (row.price < 0) errors.push("Price cannot be negative.");

  if (row.inventory !== undefined) {
    if (typeof row.inventory !== "number" || Number.isNaN(row.inventory) || !Number.isInteger(row.inventory)) errors.push("Inventory must be a whole number.");
    else if (row.inventory < 0) errors.push("Inventory cannot be negative.");
  }
  if (row.compareAtPrice !== undefined && (typeof row.compareAtPrice !== "number" || Number.isNaN(row.compareAtPrice))) errors.push("Compare-at price must be a number.");
  if (row.costPrice !== undefined && (typeof row.costPrice !== "number" || Number.isNaN(row.costPrice))) errors.push("Cost price must be a number.");
  if (row.weight !== undefined && (typeof row.weight !== "number" || Number.isNaN(row.weight))) errors.push("Weight must be a number.");
  if (row.length !== undefined && (typeof row.length !== "number" || Number.isNaN(row.length))) errors.push("Length must be a number.");
  if (row.width !== undefined && (typeof row.width !== "number" || Number.isNaN(row.width))) errors.push("Width must be a number.");
  if (row.height !== undefined && (typeof row.height !== "number" || Number.isNaN(row.height))) errors.push("Height must be a number.");

  if (row.sku && opts.duplicateSkuInFile) errors.push("Duplicate SKU within this file.");

  if (errors.length) return { status: "ERROR", errors, matchedProductId: null, action: "SKIP" };

  const warnings: string[] = [];
  let matchedProductId: string | null = null;
  let action: "CREATE" | "UPDATE" | "SKIP" = "CREATE";

  const existing = row.sku ? opts.existingBySku.get(row.sku.toLowerCase()) : undefined;
  if (existing) {
    matchedProductId = existing.productId;
    action = "UPDATE";
    warnings.push("SKU already exists — will update the existing product.");
  } else if (row.name && opts.existingNamesLower.has(row.name.trim().toLowerCase())) {
    warnings.push("Another product with this name already exists — review before importing as a new product.");
  }

  return { status: warnings.length ? "WARNING" : "READY", errors: warnings, matchedProductId, action };
}
