import { AiModelRouterService } from "./ai-model-router.service";
import type { PrismaService } from "../../database/prisma.service";

const ORIGINAL_ENV = process.env;

describe("AiModelRouterService.assign", () => {
  let prisma: { aiModelInvocation: { create: jest.Mock } };
  let router: AiModelRouterService;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    prisma = { aiModelInvocation: { create: jest.fn() } };
    router = new AiModelRouterService(prisma as unknown as PrismaService);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("routes every conversation to control when the experiment is disabled (default)", () => {
    delete process.env.AI_MODEL_EXPERIMENT_ENABLED;
    const assignment = router.assign("conv-any");
    expect(assignment.variant).toBe("control");
    expect(assignment.tier).toBe("control");
    expect(assignment.experimentId).toBeNull();
    expect(assignment.modelId).toBe("gpt-4o"); // default control model, unchanged from pre-experiment behavior
  });

  it("routes every conversation to control when traffic percent is 0 even if the experiment flag is on", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "0";
    const assignment = router.assign("conv-any");
    expect(assignment.variant).toBe("control");
  });

  it("is deterministic — the SAME conversationId always gets the SAME variant/tier across repeated calls", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "50";
    const first = router.assign("conv-stable-123");
    const second = router.assign("conv-stable-123");
    const third = router.assign("conv-stable-123");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("at 100% traffic, every conversation is a candidate", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    for (const id of ["conv-a", "conv-b", "conv-c", "conv-d"]) {
      expect(router.assign(id).variant).toBe("candidate");
    }
  });

  it("respects configured model IDs per tier instead of hard-coded names", () => {
    process.env.AI_MODEL_CONTROL = "custom-control";
    process.env.AI_MODEL_EFFICIENT = "custom-efficient";
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const assignment = router.assign("conv-x", { messageLength: 5 });
    expect(assignment.tier).toBe("efficient");
    expect(assignment.modelId).toBe("custom-efficient");
    expect(assignment.controlModelId).toBe("custom-control");
  });

  it("picks the advanced tier for assisted-buying (complex, multi-constraint) conversations", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const assignment = router.assign("conv-x", { assistedBuyingEnabled: true });
    expect(assignment.tier).toBe("advanced");
  });

  it("picks the efficient tier for short/simple messages", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const assignment = router.assign("conv-x", { messageLength: 5 });
    expect(assignment.tier).toBe("efficient");
  });

  it("defaults to the balanced tier for normal-length conversational messages", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const assignment = router.assign("conv-x", { messageLength: 80 });
    expect(assignment.tier).toBe("balanced");
  });

  it("records the configured experimentId label on candidate assignments", () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    process.env.AI_MODEL_EXPERIMENT_ID = "my-experiment";
    expect(router.assign("conv-x").experimentId).toBe("my-experiment");
  });
});

describe("AiModelRouterService.generate", () => {
  let prisma: { aiModelInvocation: { create: jest.Mock } };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: "test-key" };
    prisma = { aiModelInvocation: { create: jest.fn() } };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const withMockProvider = (router: AiModelRouterService, generateImpl: jest.Mock) => {
    (router as unknown as { provider: { generate: jest.Mock } }).provider = { generate: generateImpl };
  };

  it("throws (never silently no-ops) when OPENAI_API_KEY is not configured", async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENAI_API_KEY;
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    await expect(router.generate({
      conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {},
    })).rejects.toThrow();
  });

  it("control variant: calls the provider once with the control model, no fallback", async () => {
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn().mockResolvedValue({ text: "{}", inputTokens: 10, outputTokens: 5 });
    withMockProvider(router, generate);

    const result = await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].modelId).toBe("gpt-4o");
    expect(result.fallbackUsed).toBe(false);
    expect(result.variant).toBe("control");
  });

  it("candidate variant: falls back to the control model exactly once when the candidate call fails, and the customer still gets a reply", async () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn()
      .mockRejectedValueOnce(new Error("candidate model unavailable"))
      .mockResolvedValueOnce({ text: "{\"ok\":true}", inputTokens: 10, outputTokens: 5 });
    withMockProvider(router, generate);

    const result = await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.fallbackUsed).toBe(true);
    expect(result.modelId).toBe("gpt-4o"); // fell back to control
    expect(result.text).toBe("{\"ok\":true}");
  });

  it("candidate variant: if BOTH the candidate and the control fallback fail, the error still propagates (no silent swallow)", async () => {
    process.env.AI_MODEL_EXPERIMENT_ENABLED = "true";
    process.env.AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT = "100";
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn().mockRejectedValue(new Error("provider down"));
    withMockProvider(router, generate);

    await expect(router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} })).rejects.toThrow("provider down");
    expect(generate).toHaveBeenCalledTimes(2); // one candidate attempt + one control fallback attempt, never more
  });

  it("records telemetry (never the prompt/reply content) for every attempt", async () => {
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn().mockResolvedValue({ text: "{}", inputTokens: 10, outputTokens: 5 });
    withMockProvider(router, generate);

    await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "secret prompt", input: "secret input", schemaName: "s", schema: {} });

    expect(prisma.aiModelInvocation.create).toHaveBeenCalledTimes(1);
    const data = prisma.aiModelInvocation.create.mock.calls[0][0].data;
    expect(data.businessId).toBe("biz1");
    expect(data.conversationId).toBe("conv1");
    expect(data.success).toBe(true);
    expect(data.inputTokens).toBe(10);
    expect(data.outputTokens).toBe(5);
    expect(JSON.stringify(data)).not.toContain("secret prompt");
    expect(JSON.stringify(data)).not.toContain("secret input");
  });

  it("a telemetry write failure never breaks the actual customer-facing reply", async () => {
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    prisma.aiModelInvocation.create.mockRejectedValue(new Error("db down"));
    const generate = jest.fn().mockResolvedValue({ text: "{\"ok\":true}", inputTokens: 1, outputTokens: 1 });
    withMockProvider(router, generate);

    const result = await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} });
    expect(result.text).toBe("{\"ok\":true}");
  });

  it("never guesses estimatedCost when no per-model pricing is configured", async () => {
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn().mockResolvedValue({ text: "{}", inputTokens: 1000, outputTokens: 500 });
    withMockProvider(router, generate);

    await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} });

    const data = prisma.aiModelInvocation.create.mock.calls[0][0].data;
    expect(data.estimatedCost).toBeNull();
  });

  it("computes estimatedCost when per-tier pricing IS configured", async () => {
    process.env.AI_MODEL_COST_INPUT_PER_1K_CONTROL = "0.005";
    process.env.AI_MODEL_COST_OUTPUT_PER_1K_CONTROL = "0.015";
    const router = new AiModelRouterService(prisma as unknown as PrismaService);
    const generate = jest.fn().mockResolvedValue({ text: "{}", inputTokens: 1000, outputTokens: 1000 });
    withMockProvider(router, generate);

    await router.generate({ conversationId: "conv1", businessId: "biz1", instructions: "x", input: "y", schemaName: "s", schema: {} });

    const data = prisma.aiModelInvocation.create.mock.calls[0][0].data;
    expect(data.estimatedCost).toBeCloseTo(0.02); // (1000/1000)*0.005 + (1000/1000)*0.015
  });
});
