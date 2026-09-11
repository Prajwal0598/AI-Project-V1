import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { BadRequestException } from "@nestjs/common";

export type ImportSourceType = "CSV" | "XLSX";

export function detectSourceType(originalname: string, mimetype: string): ImportSourceType {
  const ext = originalname.split(".").pop()?.toLowerCase();
  if (ext === "csv" || mimetype === "text/csv") return "CSV";
  if (ext === "xlsx" || ext === "xls" || mimetype.includes("spreadsheet") || mimetype.includes("excel")) return "XLSX";
  throw new BadRequestException("Unsupported file type — please upload a .csv or .xlsx file.");
}

// defends against CSV/Excel "formula injection" if this data is ever re-exported into a spreadsheet later —
// skips plain numeric values (e.g. "-5") so legitimate negative numbers aren't corrupted into strings
function sanitizeCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** Parses an uploaded catalogue file into an array of raw header->value row objects. */
export function parseFile(buffer: Buffer, sourceType: ImportSourceType): Record<string, unknown>[] {
  if (sourceType === "CSV") {
    const records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, unknown>[];
    return records.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sanitizeCell(v)])));
  }

  // XLSX — parse only cell values (no formula evaluation, no macros); reads the first worksheet
  const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: false, bookVBA: false, cellHTML: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true }) as Record<string, unknown>[];
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sanitizeCell(v)])));
}
