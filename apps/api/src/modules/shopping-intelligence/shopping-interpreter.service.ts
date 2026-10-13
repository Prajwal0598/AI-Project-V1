import { Injectable, Logger, Optional } from "@nestjs/common";
import { AiModelRouterService } from "../ai/ai-model-router.service";
import type { ShoppingContext } from "./shopping-context";
import {
  INTERPRETATION_SCHEMA, interpretDeterministically, mergeInterpretations, validateModelInterpretation,
  type ShoppingInterpretation,
} from "./shopping-interpretation";

const INSTRUCTIONS = `You read ONE WhatsApp message from a customer of an online shop and describe what they want, as structured data. You do not reply to the customer and you never see prices, stock or product IDs.
- topicRelation: NEW_TOPIC if they now ask for a different kind of product than the current search; REFINEMENT if they narrow or adjust it (cheaper, another colour, a budget); CONTINUATION if they keep going without changing it.
- intent: SEARCH (looking for something), REFINE (adjusting the current search), ALTERNATIVES ("other options"), SIMILAR ("similar ones"), SELECT_PRODUCT ("the second one"), UNCLEAR.
- productTerms: product TYPES they named, lowercase single words (e.g. saree, earrings).
- expandedTerms: ONLY for gift/occasion/vibe requests that name no product type — up to 6 related product TYPES a shop might stock (lowercase single words). Empty when the request is already specific.
- budgetMin/budgetMax: ONLY amounts the customer actually wrote in this message, otherwise null.
- clarificationQuestion: ONE short question, ONLY if the request is genuinely ambiguous; no numbers or prices. Otherwise null.`;

/**
 * Turns a customer message into a structured ShoppingInterpretation. The deterministic reading is always
 * produced first and is complete on its own; the existing AiModelRouterService (no new model or service) is
 * consulted only when that reading is unsure, its output is schema-validated and then merged without ever
 * overriding deterministic numbers, and any model failure/timeout silently falls back to the deterministic result.
 */
@Injectable()
export class ShoppingInterpreterService {
  private readonly logger = new Logger(ShoppingInterpreterService.name);

  constructor(@Optional() private readonly modelRouter?: AiModelRouterService) {}

  async interpret(params: {
    conversationId: string; businessId: string; text: string; context: ShoppingContext | null;
    activeProductId?: string | null; activeProductName?: string | null; shownNames?: string[];
  }): Promise<ShoppingInterpretation> {
    const base = interpretDeterministically(params.text, params.context, { activeProductId: params.activeProductId });
    if (!this.shouldConsultModel(base, params.text)) return base;

    try {
      const input = JSON.stringify({
        message: params.text,
        currentSearch: params.context ? {
          keywords: params.context.filters.keywords, occasion: params.context.occasion ?? null,
          color: params.context.color ?? null, maxPrice: params.context.filters.maxPrice ?? null,
        } : null,
        viewingProduct: params.activeProductName ?? null,
        lastShown: (params.shownNames ?? params.context?.lastResults.map((r) => r.name) ?? []).slice(0, 5),
      });
      const generation = await this.withTimeout(this.modelRouter!.generate({
        conversationId: params.conversationId, businessId: params.businessId,
        instructions: INSTRUCTIONS, input, schemaName: "shopping_interpretation", schema: INTERPRETATION_SCHEMA as unknown as Record<string, unknown>,
      }));
      const validated = validateModelInterpretation(JSON.parse(generation.text), params.text);
      if (!validated) {
        this.logger.warn("Shopping interpretation from the model failed validation — using the deterministic reading.");
        return base;
      }
      return mergeInterpretations(base, validated);
    } catch (err) {
      this.logger.warn(`Model-assisted shopping interpretation unavailable, using the deterministic reading — ${err instanceof Error ? err.message : String(err)}`);
      return base;
    }
  }

  private shouldConsultModel(base: ShoppingInterpretation, text: string): boolean {
    if (!this.modelRouter || process.env.SHOPPING_INTERPRETER_ENABLED === "false") return false;
    return base.confidence < 0.75 && text.trim().length >= 3;
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    const ms = Number(process.env.SHOPPING_INTERPRETER_TIMEOUT_MS ?? 5000) || 5000;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
}
