import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import OpenAI from "openai";
import { NormalizedRow } from "./field-mapping";

const MAX_ROWS_PER_CALL = 150; // keeps a single suggestion request within a safe token budget

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      description: "One entry per input row, matched back by rowNumber.",
      items: {
        type: "object",
        properties: {
          rowNumber: { type: "integer" },
          category: { type: ["string", "null"], description: "A short category name for this product. Prefer reusing one of the business's existing categories when it fits; otherwise propose a sensible new one. Null if a category cannot be reasonably inferred." },
          description: { type: ["string", "null"], description: "A one-sentence, factual customer-facing product description based only on the given name/brand/category — never invent specs, materials, or claims not implied by the name. Null if nothing reasonable can be written." },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "How confident you are in the category suggestion specifically." },
        },
        required: ["rowNumber", "category", "description", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

interface RowSuggestion {
  category: string | null;
  description: string | null;
  confidence: "high" | "medium" | "low";
}

export interface AiSuggestionResult {
  rowNumber: number;
  category?: { value: string; confidence: "high" | "medium" | "low" };
  description?: { value: string; confidence: "high" | "medium" | "low" };
}

@Injectable()
export class ImportAiService {
  private readonly logger = new Logger(ImportAiService.name);
  private client: OpenAI | null = null;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.client = new OpenAI({ apiKey });
    else this.logger.warn("OPENAI_API_KEY is not set — catalogue import AI suggestions will be unavailable.");
  }

  get maxRowsPerCall(): number {
    return MAX_ROWS_PER_CALL;
  }

  /**
   * Suggests a category and/or description for rows missing one, grounded in the row's own name/brand/price
   * and the business's existing category names (to encourage reuse over inventing near-duplicate categories).
   * Only asks for whichever field(s) each row actually lacks — never overwrites data the merchant/file already provided.
   */
  async suggest(rows: { rowNumber: number; data: NormalizedRow }[], existingCategoryNames: string[]): Promise<AiSuggestionResult[]> {
    if (!this.client) throw new ServiceUnavailableException("OPENAI_API_KEY is not configured on the API server.");
    if (!rows.length) return [];

    const rowsText = rows.map(({ rowNumber, data }) => {
      const needs: string[] = [];
      if (!data.category) needs.push("category");
      if (!data.description) needs.push("description");
      const facts = [
        `name: ${data.name ?? "(unknown)"}`,
        data.brand ? `brand: ${data.brand}` : null,
        data.price !== undefined ? `price: ${data.price}` : null,
        data.category ? `existing category: ${data.category}` : null,
      ].filter(Boolean).join(", ");
      return `Row ${rowNumber} [needs: ${needs.join(", ")}] — ${facts}`;
    }).join("\n");

    const instructions = `You help an online merchant fill in gaps in a product catalogue upload. For each row, propose ONLY the field(s) listed in its "needs" bracket — still return both keys per the schema, but set the one not needed to null. Never invent specific technical claims (fabric, capacity, ingredients, etc.) that aren't implied by the name/brand. Keep descriptions to one short sentence.`;
    const input = `Existing categories for this business (reuse one of these when it clearly fits, instead of proposing a near-duplicate):\n${existingCategoryNames.length ? existingCategoryNames.join(", ") : "(none yet)"}\n\nRows:\n${rowsText}`;

    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    const response = await this.client.responses.create({
      model, instructions, input, store: false,
      text: { format: { type: "json_schema", name: "import_suggestions", schema: SUGGESTIONS_SCHEMA, strict: true } },
    });

    const raw = response.output_text?.trim();
    if (!raw) throw new ServiceUnavailableException("The AI service returned an empty response.");
    const parsed = JSON.parse(raw) as { suggestions: (RowSuggestion & { rowNumber: number })[] };

    const byRowNumber = new Map(rows.map((r) => [r.rowNumber, r.data]));
    const results: AiSuggestionResult[] = [];
    for (const s of parsed.suggestions) {
      const data = byRowNumber.get(s.rowNumber);
      if (!data) continue; // ignore anything the model echoed back that we didn't actually ask about
      const result: AiSuggestionResult = { rowNumber: s.rowNumber };
      if (!data.category && s.category) result.category = { value: s.category, confidence: s.confidence };
      if (!data.description && s.description) result.description = { value: s.description, confidence: s.confidence };
      if (result.category || result.description) results.push(result);
    }
    return results;
  }
}
