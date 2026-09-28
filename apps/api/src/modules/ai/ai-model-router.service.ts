import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { PrismaService } from "../../database/prisma.service";
import { AiModelProvider, OpenAiResponsesProvider } from "./model-provider";

export type AiModelTier = "control" | "efficient" | "balanced" | "advanced";
export type AiModelVariant = "control" | "candidate";

export interface AiModelAssignment {
  experimentId: string | null;
  variant: AiModelVariant;
  tier: AiModelTier;
  modelId: string;
  controlModelId: string;
}

export interface AiComplexityHint {
  messageLength?: number;
  assistedBuyingEnabled?: boolean;
}

export interface AiGenerationResult {
  text: string;
  modelId: string;
  variant: AiModelVariant;
  tier: AiModelTier;
  experimentId: string | null;
  fallbackUsed: boolean;
}

/**
 * Model abstraction + deterministic A/B routing + fallback + telemetry for AiService's LLM turn.
 * AiService itself never knows a model name — it only calls generate() and gets back reply text.
 *
 * Env config (all optional, safe production defaults):
 *  AI_MODEL_CONTROL / AI_MODEL_EFFICIENT / AI_MODEL_BALANCED / AI_MODEL_ADVANCED — model IDs per tier.
 *  AI_MODEL_EXPERIMENT_ENABLED ("true" to turn on candidate routing at all; default off).
 *  AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT (0-100, share of conversations routed to a candidate tier).
 *  AI_MODEL_EXPERIMENT_ID (label recorded on telemetry rows).
 *  AI_MODEL_REASONING_EFFORT_<TIER> (optional "low"|"medium"|"high", only sent if set).
 *  AI_MODEL_COST_INPUT_PER_1K_<TIER> / AI_MODEL_COST_OUTPUT_PER_1K_<TIER> (optional — estimatedCost stays
 *  null/unknown unless real pricing is configured; never guesses a price for a model we don't actually know the cost of).
 */
@Injectable()
export class AiModelRouterService {
  private readonly logger = new Logger(AiModelRouterService.name);
  // lazily initialised so the API starts without OPENAI_API_KEY configured, same pattern AiService used before this moved here
  private provider: AiModelProvider | null = null;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) this.provider = new OpenAiResponsesProvider(new OpenAI({ apiKey }));
    else this.logger.warn("OPENAI_API_KEY is not set — AI model routing will be unavailable.");
  }

  private getProvider(): AiModelProvider {
    if (!this.provider) throw new ServiceUnavailableException("OPENAI_API_KEY is not configured on the API server.");
    return this.provider;
  }

  /** Deterministic per-conversation control/candidate assignment, hashed so the SAME conversation never flips
   * variant mid-thread and stays stable across process restarts without needing a persisted assignment row. */
  assign(conversationId: string, complexity?: AiComplexityHint): AiModelAssignment {
    const controlModelId = process.env.AI_MODEL_CONTROL || process.env.OPENAI_MODEL || "gpt-4o";
    const experimentEnabled = process.env.AI_MODEL_EXPERIMENT_ENABLED === "true";
    const trafficPercent = Math.min(100, Math.max(0, Number(process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT ?? 0) || 0));
    const experimentId = experimentEnabled ? process.env.AI_MODEL_EXPERIMENT_ID || "model-upgrade-v1" : null;

    if (!experimentEnabled || trafficPercent <= 0 || this.bucketFor(conversationId) >= trafficPercent) {
      return { experimentId, variant: "control", tier: "control", modelId: controlModelId, controlModelId };
    }

    const tier = this.pickTier(complexity);
    return { experimentId, variant: "candidate", tier, modelId: this.modelForTier(tier, controlModelId), controlModelId };
  }

  /** Simple, deterministic complexity heuristic per the spec's routing table — not itself a model call, so it adds no latency/cost. */
  private pickTier(complexity?: AiComplexityHint): AiModelTier {
    if (complexity?.assistedBuyingEnabled) return "advanced"; // multi-constraint assisted buying = "complex assisted buying"
    if ((complexity?.messageLength ?? 0) <= 20) return "efficient"; // short message = greeting/simple question
    return "balanced"; // default: normal conversational shopping
  }

  private modelForTier(tier: AiModelTier, controlModelId: string): string {
    switch (tier) {
      case "efficient": return process.env.AI_MODEL_EFFICIENT || "gpt-5.6-luna";
      case "balanced": return process.env.AI_MODEL_BALANCED || "gpt-5.6-terra";
      case "advanced": return process.env.AI_MODEL_ADVANCED || "gpt-5.6-sol";
      default: return controlModelId;
    }
  }

  private reasoningEffortForTier(tier: AiModelTier): string | undefined {
    return process.env[`AI_MODEL_REASONING_EFFORT_${tier.toUpperCase()}`] || undefined;
  }

  private bucketFor(conversationId: string): number {
    const hash = createHash("sha256").update(conversationId).digest();
    return hash.readUInt32BE(0) % 100;
  }

  /** Runs one AI turn on the assigned model. If the candidate tier fails or returns an invalid/empty response,
   * transparently retries once on the control model — the customer never sees a candidate-model failure. */
  async generate(params: {
    conversationId: string; businessId: string; instructions: string; input: string;
    schemaName: string; schema: Record<string, unknown>; complexityHint?: AiComplexityHint;
  }): Promise<AiGenerationResult> {
    const provider = this.getProvider();
    const assignment = this.assign(params.conversationId, params.complexityHint);

    const attempt = async (modelId: string, tier: AiModelTier, fallbackUsed: boolean) => {
      const startedAt = Date.now();
      try {
        const result = await provider.generate({
          modelId, instructions: params.instructions, input: params.input,
          schemaName: params.schemaName, schema: params.schema, reasoningEffort: this.reasoningEffortForTier(tier),
        });
        await this.recordInvocation({
          businessId: params.businessId, conversationId: params.conversationId, experimentId: assignment.experimentId,
          variant: assignment.variant, tier, modelId, latencyMs: Date.now() - startedAt,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens, success: true, fallbackUsed,
        });
        return result.text;
      } catch (error) {
        await this.recordInvocation({
          businessId: params.businessId, conversationId: params.conversationId, experimentId: assignment.experimentId,
          variant: assignment.variant, tier, modelId, latencyMs: Date.now() - startedAt, success: false, fallbackUsed,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    if (assignment.variant === "control") {
      const text = await attempt(assignment.modelId, assignment.tier, false);
      return { text, modelId: assignment.modelId, variant: assignment.variant, tier: assignment.tier, experimentId: assignment.experimentId, fallbackUsed: false };
    }

    try {
      const text = await attempt(assignment.modelId, assignment.tier, false);
      return { text, modelId: assignment.modelId, variant: assignment.variant, tier: assignment.tier, experimentId: assignment.experimentId, fallbackUsed: false };
    } catch (error) {
      this.logger.warn(`Candidate model "${assignment.modelId}" (tier ${assignment.tier}) failed, falling back to control "${assignment.controlModelId}" — ${error instanceof Error ? error.message : String(error)}`);
      const text = await attempt(assignment.controlModelId, "control", true);
      return { text, modelId: assignment.controlModelId, variant: assignment.variant, tier: assignment.tier, experimentId: assignment.experimentId, fallbackUsed: true };
    }
  }

  /** Telemetry only — a failed write here must never break the actual customer-facing reply (unlike logAiAction's
   * audit trail for consequential actions, this is model-quality measurement data, safe to lose occasionally). */
  private async recordInvocation(params: {
    businessId: string; conversationId: string; experimentId: string | null; variant: AiModelVariant; tier: AiModelTier;
    modelId: string; latencyMs: number; success: boolean; fallbackUsed: boolean;
    inputTokens?: number; outputTokens?: number; errorMessage?: string;
  }): Promise<void> {
    try {
      await this.prisma.aiModelInvocation.create({
        data: {
          businessId: params.businessId, conversationId: params.conversationId, experimentId: params.experimentId,
          variant: params.variant, tier: params.tier, modelId: params.modelId, latencyMs: params.latencyMs,
          success: params.success, fallbackUsed: params.fallbackUsed,
          inputTokens: params.inputTokens ?? null, outputTokens: params.outputTokens ?? null,
          estimatedCost: this.estimateCost(params.tier, params.inputTokens, params.outputTokens),
          errorMessage: params.errorMessage ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record AI model telemetry (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Null (unknown) unless real per-1K-token pricing has been configured for this tier — never invents a price for a model we don't actually know the cost of. */
  private estimateCost(tier: AiModelTier, inputTokens?: number, outputTokens?: number): number | null {
    if (inputTokens === undefined || outputTokens === undefined) return null;
    const inputCostPer1k = Number(process.env[`AI_MODEL_COST_INPUT_PER_1K_${tier.toUpperCase()}`]) || 0;
    const outputCostPer1k = Number(process.env[`AI_MODEL_COST_OUTPUT_PER_1K_${tier.toUpperCase()}`]) || 0;
    if (!inputCostPer1k && !outputCostPer1k) return null;
    return Number(((inputTokens / 1000) * inputCostPer1k + (outputTokens / 1000) * outputCostPer1k).toFixed(6));
  }
}
