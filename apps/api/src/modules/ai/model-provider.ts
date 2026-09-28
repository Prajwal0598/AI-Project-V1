import OpenAI from "openai";

// swappable behind AiModelRouterService so a future non-OpenAI backend (Azure OpenAI, Anthropic, etc.) could
// implement this same interface without AiService or AiModelRouterService changing at all. Deliberately ONE
// implementation parameterized by modelId rather than one class per tier — every tier calls the exact same
// Responses API surface and only the model/reasoning-effort differ, so per-tier subclasses would just be
// duplicate boilerplate.
export interface AiModelProvider {
  generate(params: {
    modelId: string;
    instructions: string;
    input: string;
    schemaName: string;
    schema: Record<string, unknown>;
    reasoningEffort?: string;
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

export class OpenAiResponsesProvider implements AiModelProvider {
  constructor(private readonly client: OpenAI) {}

  async generate(params: {
    modelId: string;
    instructions: string;
    input: string;
    schemaName: string;
    schema: Record<string, unknown>;
    reasoningEffort?: string;
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
    const response = await this.client.responses.create({
      model: params.modelId,
      instructions: params.instructions,
      input: params.input,
      store: false,
      text: { format: { type: "json_schema", name: params.schemaName, schema: params.schema, strict: true } },
      ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort as "low" | "medium" | "high" } } : {}),
    });
    const text = response.output_text?.trim();
    if (!text) throw new Error("Model returned an empty response.");
    return { text, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens };
  }
}
