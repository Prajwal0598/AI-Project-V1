// Larger 30-category offline benchmark for the AI Model Upgrade & A/B Testing feature.
// Reuses the exact same AiService prompt-building/budget-filter/matching functions and the exact same
// fixture catalogue as every prior evaluation this session — NOT a new parallel shopping architecture.
// STRICTLY OFFLINE w.r.t. Relay: no Postgres/Prisma, no Railway/production env vars touched, no deploy,
// no experiment flag flipped. Only network calls: direct OpenAI API calls via the local .env key.
//
// Run with: npx ts-node run-benchmark.ts   (from this directory)

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

import OpenAI from "openai";
import { OpenAiResponsesProvider } from "../../src/modules/ai/model-provider";
import { REPLY_SCHEMA, buildCatalogueText, buildOrdersContextText, buildSalesInstructions, buildTranscriptInput, matchCatalogueItems, filterCatalogueByBudget } from "../../src/modules/ai/ai.service";
import { parseSearchQuery } from "../../src/modules/shopping-flow/shopping-flow.service";
import { FIXTURE_CATALOGUE, FIXTURE_BUSINESS_NAME } from "./fixtures";
import { BENCHMARK_SCENARIOS, BenchmarkScenario } from "./benchmark-scenarios";

const CONTROL_MODEL = "gpt-4o";
const CANDIDATE_MODEL = "gpt-5.6-terra";
const RESAMPLE_COUNT = 3; // "at least 3 independent samples where practical" — applied to scenario.resample===true

// mirrors ai.service.ts's own private PAYMENT_CLAIM_RE / ORDER_STATUS_QUERY_RE exactly (kept in sync manually
// — this is eval-harness-only duplication, not a new guard implementation) so categories 23/24 correctly
// report "deterministically guarded in real Relay, never reaches the model" instead of asking either model
// something production would never actually let it answer.
const PAYMENT_CLAIM_RE = /\b(i(?:'ve| have)(?: already)? paid|i paid|payment(?:'s| is)? (?:done|complete|sent|made)|i(?:'ve| have) (?:sent|made|completed) (?:the |my )?payment|sent (?:the |my )?payment)\b/i;
const ORDER_STATUS_QUERY_RE = /\b(where(?:'s| is) my order|what'?s? my order status|order status|when will my order arrive|when (?:is|will) my order (?:arriving|coming|delivered)|track(?:ing)? my order|show (?:me )?my (?:recent )?orders?)\b/i;

// Control pricing as used throughout this evaluation session (not independently re-verified live — the
// Usage/Costs API is inaccessible with this project-scoped key, confirmed earlier). Candidate pricing is the
// figure explicitly provided for this run — used verbatim, never guessed.
const PRICING: Record<string, { inputPer1M: number; cachedInputPer1M?: number; outputPer1M: number; sourceNote: string }> = {
  [CONTROL_MODEL]: { inputPer1M: 2.5, outputPer1M: 10, sourceNote: "as used throughout this evaluation session; not independently re-verified against a live OpenAI billing source (Usage/Costs API inaccessible with this project-scoped key)" },
  [CANDIDATE_MODEL]: { inputPer1M: 2, cachedInputPer1M: 0.2, outputPer1M: 12, sourceNote: "as explicitly provided for this benchmark run" },
};

type ReplyPayload = {
  reply: string; items: { productName: string; quantity: number }[];
  shippingAddress: string | null; paymentMethod: string | null; orderConfirmed: boolean; cancelOrder: boolean;
  needsHumanReview: boolean; needsHumanReviewReason: string | null; showProductImages: string[];
};

// harness-only heuristic (NOT production logic) flagging a reply that sounds like it's describing a
// return/refund/cancellation/shipping/warranty policy without the honest "not available" fallback phrasing
// the new grounding instruction asks for — a cheap regression signal for future benchmark runs, nothing more.
const POLICY_SOUNDING_RE = /\b(return|refund|cancellation|cancel|shipping|warranty)\b.*\b(day|policy|window|period|guarantee)\b/i;
const HONEST_UNAVAILABLE_RE = /\b(don't have|do not have|not available|unable to (?:provide|share)|no (?:information|details) (?:on|about))\b/i;
function looksLikeUnsupportedPolicyClaim(reply: string | undefined): boolean {
  if (!reply) return false;
  return POLICY_SOUNDING_RE.test(reply) && !HONEST_UNAVAILABLE_RE.test(reply);
}

interface TurnResult {
  turnIndex: number;
  customerMessage: string;
  guarded: "payment" | "order_status" | null; // non-null when a deterministic guard intercepted this turn instead of the model
  success: boolean;
  error: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estimatedCostUsd: number | null;
  rawText: string | null;
  structuredOutputValid: boolean;
  parsed: ReplyPayload | null;
  hallucinatedNames: string[];
  candidateCatalogueNames: string[];
  overBudgetInCandidateSet: string[]; // sanity check: should always be empty by construction
  possibleUnsupportedPolicyClaim: boolean; // harness-only heuristic, see looksLikeUnsupportedPolicyClaim
}

interface ScenarioRun {
  modelId: string;
  sampleIndex: number;
  turns: TurnResult[];
}

interface ScenarioResult {
  scenario: BenchmarkScenario;
  controlRuns: ScenarioRun[];
  candidateRuns: ScenarioRun[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/s$/, "");
}

function findHallucinatedNames(names: string[]): string[] {
  return names.filter((n) => !FIXTURE_CATALOGUE.some((p) => normalize(p.name) === normalize(n) || normalize(p.name).includes(normalize(n)) || normalize(n).includes(normalize(p.name))));
}

function estimateCost(modelId: string, inputTokens?: number, outputTokens?: number, cachedInputTokens?: number): number | null {
  const pricing = PRICING[modelId];
  if (!pricing || inputTokens === undefined || outputTokens === undefined) return null;
  const billedInput = Math.max(0, inputTokens - (cachedInputTokens ?? 0));
  const cachedCost = pricing.cachedInputPer1M !== undefined ? ((cachedInputTokens ?? 0) / 1_000_000) * pricing.cachedInputPer1M : 0;
  return Number(((billedInput / 1_000_000) * pricing.inputPer1M + cachedCost + (outputTokens / 1_000_000) * pricing.outputPer1M).toFixed(6));
}

async function runTurn(provider: OpenAiResponsesProvider, modelId: string, transcript: string, turnIndex: number, customerMessage: string, guardApplicable: BenchmarkScenario["guardApplicable"]): Promise<{ turn: TurnResult; replyForTranscript: string }> {
  // deterministic guard check FIRST — exactly mirrors ai.service.ts's own ordering (guards run before the LLM turn)
  if (guardApplicable === "payment" && PAYMENT_CLAIM_RE.test(customerMessage)) {
    return {
      turn: { turnIndex, customerMessage, guarded: "payment", success: true, error: null, latencyMs: 0, estimatedCostUsd: 0, rawText: null, structuredOutputValid: true, parsed: null, hallucinatedNames: [], candidateCatalogueNames: [], overBudgetInCandidateSet: [], possibleUnsupportedPolicyClaim: false },
      replyForTranscript: "(answered deterministically from real order/payment status — never reached the model)",
    };
  }
  if (guardApplicable === "order_status" && ORDER_STATUS_QUERY_RE.test(customerMessage)) {
    return {
      turn: { turnIndex, customerMessage, guarded: "order_status", success: true, error: null, latencyMs: 0, estimatedCostUsd: 0, rawText: null, structuredOutputValid: true, parsed: null, hallucinatedNames: [], candidateCatalogueNames: [], overBudgetInCandidateSet: [], possibleUnsupportedPolicyClaim: false },
      replyForTranscript: "(answered deterministically from real order data — never reached the model)",
    };
  }

  const filteredCatalogue = filterCatalogueByBudget(FIXTURE_CATALOGUE as never, customerMessage);
  const candidateCatalogueNames = (filteredCatalogue as typeof FIXTURE_CATALOGUE).map((p) => p.name);
  // independent sanity re-check (same comma-normalization filterCatalogueByBudget itself applies): the filtered
  // candidate set should NEVER contain a product priced above any budget stated in this message — verified here
  // rather than assumed, so a future regression in the filter itself would surface as a reported leak.
  const normalizedForBudgetCheck = customerMessage.replace(/(\d),(\d)/g, "$1$2");
  const budgetMaxForCheck = parseSearchQuery(normalizedForBudgetCheck).maxPrice;
  const overBudgetInCandidateSet = budgetMaxForCheck !== undefined
    ? (filteredCatalogue as typeof FIXTURE_CATALOGUE).filter((p) => p.variants[0] && Number(p.variants[0].price) > budgetMaxForCheck).map((p) => p.name)
    : [];
  const catalog = buildCatalogueText(filteredCatalogue as never);
  const ordersContext = buildOrdersContextText([]);
  const instructions = buildSalesInstructions(FIXTURE_BUSINESS_NAME, catalog, ordersContext);
  const input = buildTranscriptInput("Test Customer", "WHATSAPP", transcript);
  const startedAt = Date.now();
  try {
    const result = await provider.generate({ modelId, instructions, input, schemaName: "sales_reply", schema: REPLY_SCHEMA });
    const latencyMs = Date.now() - startedAt;
    let parsed: ReplyPayload | null = null;
    let structuredOutputValid = false;
    try {
      parsed = JSON.parse(result.text) as ReplyPayload;
      structuredOutputValid = typeof parsed.reply === "string" && Array.isArray(parsed.items) && Array.isArray(parsed.showProductImages);
    } catch { structuredOutputValid = false; }

    const namesUsed = [...(parsed?.items?.map((i) => i.productName) ?? []), ...(parsed?.showProductImages ?? [])];
    const hallucinatedNames = findHallucinatedNames(namesUsed);
    return {
      turn: {
        turnIndex, customerMessage, guarded: null, success: true, error: null, latencyMs,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedInputTokens: result.cachedInputTokens,
        estimatedCostUsd: estimateCost(modelId, result.inputTokens, result.outputTokens, result.cachedInputTokens),
        rawText: result.text, structuredOutputValid, parsed, hallucinatedNames, candidateCatalogueNames, overBudgetInCandidateSet,
        possibleUnsupportedPolicyClaim: looksLikeUnsupportedPolicyClaim(parsed?.reply),
      },
      replyForTranscript: parsed?.reply ?? "(no reply — structured output was invalid)",
    };
  } catch (error) {
    return {
      turn: {
        turnIndex, customerMessage, guarded: null, success: false, error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt, estimatedCostUsd: null, rawText: null, structuredOutputValid: false, parsed: null,
        hallucinatedNames: [], candidateCatalogueNames, overBudgetInCandidateSet, possibleUnsupportedPolicyClaim: false,
      },
      replyForTranscript: "(model call failed)",
    };
  }
}

async function runScenarioSample(provider: OpenAiResponsesProvider, modelId: string, scenario: BenchmarkScenario, sampleIndex: number): Promise<ScenarioRun> {
  let transcript = "";
  const turns: TurnResult[] = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    transcript += (transcript ? "\n" : "") + `Customer: ${scenario.turns[i].customer}`;
    const { turn, replyForTranscript } = await runTurn(provider, modelId, transcript, i, scenario.turns[i].customer, scenario.guardApplicable);
    turns.push(turn);
    transcript += `\nBusiness: ${replyForTranscript}`;
  }
  return { modelId, sampleIndex, turns };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — aborting (no API calls made).");

  const totalConversationRuns = BENCHMARK_SCENARIOS.reduce((sum, s) => sum + (s.resample ? RESAMPLE_COUNT : 1), 0);
  const totalTurns = BENCHMARK_SCENARIOS.reduce((sum, s) => sum + s.turns.length * (s.resample ? RESAMPLE_COUNT : 1), 0);
  console.log(`Scenarios: ${BENCHMARK_SCENARIOS.length} categories, ${totalConversationRuns} total conversation-runs (with resampling)`);
  console.log(`Total turns: ${totalTurns} x 2 models = ${totalTurns * 2} real OpenAI API calls`);
  console.log(`Control: ${CONTROL_MODEL}, Candidate: ${CANDIDATE_MODEL}\n`);

  const client = new OpenAI({ apiKey });
  const provider = new OpenAiResponsesProvider(client);

  const results: ScenarioResult[] = [];
  for (const scenario of BENCHMARK_SCENARIOS) {
    const samples = scenario.resample ? RESAMPLE_COUNT : 1;
    console.log(`[RUNNING] ${scenario.id} — ${scenario.category}: ${scenario.name}${samples > 1 ? ` (${samples} samples)` : ""}`);
    const controlRuns: ScenarioRun[] = [];
    const candidateRuns: ScenarioRun[] = [];
    for (let s = 0; s < samples; s++) {
      controlRuns.push(await runScenarioSample(provider, CONTROL_MODEL, scenario, s));
      candidateRuns.push(await runScenarioSample(provider, CANDIDATE_MODEL, scenario, s));
    }
    results.push({ scenario, controlRuns, candidateRuns });
  }

  const outDir = path.join(__dirname, "results", `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });

  const categorySummary = buildCategorySummary(results);
  const aggregates = { control: buildAggregate(CONTROL_MODEL, results, (r) => r.controlRuns), candidate: buildAggregate(CANDIDATE_MODEL, results, (r) => r.candidateRuns) };

  const jsonOut = { generatedAt: new Date().toISOString(), controlModel: CONTROL_MODEL, candidateModel: CANDIDATE_MODEL, pricing: PRICING, aggregates, categorySummary, scenarios: results };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(jsonOut, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(jsonOut));

  console.log(`\nResults written to:\n  ${path.join(outDir, "results.json")}\n  ${path.join(outDir, "report.md")}\n`);
  console.log(`${CONTROL_MODEL} aggregate:`, aggregates.control);
  console.log(`${CANDIDATE_MODEL} aggregate:`, aggregates.candidate);
}

function turnsFlat(runs: ScenarioRun[]): TurnResult[] {
  return runs.flatMap((r) => r.turns);
}

function buildAggregate(modelId: string, results: ScenarioResult[], pick: (r: ScenarioResult) => ScenarioRun[]) {
  const allRuns = results.flatMap(pick);
  const allTurns = turnsFlat(allRuns).filter((t) => !t.guarded);
  const modelCalledTurns = allTurns; // guarded turns already excluded — those never reached the model
  const successfulTurns = modelCalledTurns.filter((t) => t.success);
  const callFailures = modelCalledTurns.filter((t) => !t.success).length;
  const hallucinationTurns = successfulTurns.filter((t) => t.hallucinatedNames.length > 0).length;
  const structuredFailures = successfulTurns.filter((t) => !t.structuredOutputValid).length;
  const overBudgetLeaks = successfulTurns.filter((t) => t.overBudgetInCandidateSet.length > 0).length;
  const possibleUnsupportedPolicyClaims = successfulTurns.filter((t) => t.possibleUnsupportedPolicyClaim).length;
  const avgLatency = successfulTurns.length ? Math.round(successfulTurns.reduce((s, t) => s + t.latencyMs, 0) / successfulTurns.length) : null;
  const totalInputTokens = successfulTurns.reduce((s, t) => s + (t.inputTokens ?? 0), 0);
  const totalOutputTokens = successfulTurns.reduce((s, t) => s + (t.outputTokens ?? 0), 0);
  const totalCachedInputTokens = successfulTurns.reduce((s, t) => s + (t.cachedInputTokens ?? 0), 0);
  const avgInputTokens = successfulTurns.length ? Math.round(totalInputTokens / successfulTurns.length) : null;
  const avgOutputTokens = successfulTurns.length ? Math.round(totalOutputTokens / successfulTurns.length) : null;
  const totalCost = successfulTurns.reduce((s, t) => s + (t.estimatedCostUsd ?? 0), 0);
  return {
    modelId, totalModelCalledTurns: modelCalledTurns.length, callFailures, hallucinationTurns, structuredFailures, overBudgetLeaks,
    possibleUnsupportedPolicyClaims,
    avgLatencyMs: avgLatency, avgInputTokens, avgOutputTokens, totalInputTokens, totalOutputTokens, totalCachedInputTokens,
    estimatedTotalCostUsd: Number(totalCost.toFixed(4)),
  };
}

function buildCategorySummary(results: ScenarioResult[]): Record<string, unknown>[] {
  return results.map((r) => {
    const controlTurns = turnsFlat(r.controlRuns).filter((t) => !t.guarded);
    const candidateTurns = turnsFlat(r.candidateRuns).filter((t) => !t.guarded);
    const controlHallucinations = controlTurns.filter((t) => t.hallucinatedNames.length > 0).length;
    const candidateHallucinations = candidateTurns.filter((t) => t.hallucinatedNames.length > 0).length;
    const controlEscalations = controlTurns.filter((t) => t.parsed?.needsHumanReview).length;
    const candidateEscalations = candidateTurns.filter((t) => t.parsed?.needsHumanReview).length;
    return {
      id: r.scenario.id, category: r.scenario.category, name: r.scenario.name,
      guarded: r.scenario.guardApplicable ?? null, samples: r.scenario.resample ? RESAMPLE_COUNT : 1,
      control: { calls: controlTurns.length, hallucinations: controlHallucinations, structuredFailures: controlTurns.filter((t) => t.success && !t.structuredOutputValid).length, escalations: controlEscalations },
      candidate: { calls: candidateTurns.length, hallucinations: candidateHallucinations, structuredFailures: candidateTurns.filter((t) => t.success && !t.structuredOutputValid).length, escalations: candidateEscalations },
    };
  });
}

function renderMarkdown(data: { generatedAt: string; controlModel: string; candidateModel: string; pricing: typeof PRICING; aggregates: { control: Record<string, unknown>; candidate: Record<string, unknown> }; categorySummary: Record<string, unknown>[]; scenarios: ScenarioResult[] }): string {
  const lines: string[] = [];
  lines.push(`# AI Model Benchmark — ${data.controlModel} vs ${data.candidateModel}`, "", `Generated: ${data.generatedAt}`, "");
  lines.push("## Pricing used", "");
  for (const [model, p] of Object.entries(data.pricing)) lines.push(`- **${model}**: $${p.inputPer1M}/1M input${p.cachedInputPer1M !== undefined ? `, $${p.cachedInputPer1M}/1M cached input` : ""}, $${p.outputPer1M}/1M output — _${p.sourceNote}_`);
  lines.push("");

  lines.push("## Aggregate comparison (metric-by-metric — no overall winner score)", "");
  lines.push(`| Metric | ${data.controlModel} | ${data.candidateModel} |`, "|---|---|---|");
  const keys = ["totalModelCalledTurns", "callFailures", "hallucinationTurns", "structuredFailures", "overBudgetLeaks", "possibleUnsupportedPolicyClaims", "avgLatencyMs", "avgInputTokens", "avgOutputTokens", "totalCachedInputTokens", "estimatedTotalCostUsd"];
  for (const k of keys) lines.push(`| ${k} | ${data.aggregates.control[k as never] ?? "n/a"} | ${data.aggregates.candidate[k as never] ?? "n/a"} |`);
  lines.push("");

  lines.push("## Category-level summary", "");
  lines.push("| # | Category | Samples | Guarded | GPT-4o calls/halluc/struct-fail/escal | Candidate calls/halluc/struct-fail/escal |", "|---|---|---|---|---|---|");
  for (const c of data.categorySummary as any[]) {
    lines.push(`| ${c.id} | ${c.category} | ${c.samples} | ${c.guarded ?? "-"} | ${c.control.calls}/${c.control.hallucinations}/${c.control.structuredFailures}/${c.control.escalations} | ${c.candidate.calls}/${c.candidate.hallucinations}/${c.candidate.structuredFailures}/${c.candidate.escalations} |`);
  }
  lines.push("");

  lines.push("## Per-test comparison", "");
  for (const r of data.scenarios) {
    lines.push(`### ${r.scenario.id} — ${r.scenario.category}: ${r.scenario.name}`, "");
    if (r.scenario.guardApplicable) {
      lines.push(`**Deterministically guarded in real Relay (${r.scenario.guardApplicable}) — never reaches the model.**`, "");
      continue;
    }
    for (let s = 0; s < r.controlRuns.length; s++) {
      const cRun = r.controlRuns[s]; const kRun = r.candidateRuns[s];
      if (r.controlRuns.length > 1) lines.push(`**Sample ${s + 1}:**`);
      lines.push(`- ${data.controlModel}: ${cRun.turns.map((t) => `[T${t.turnIndex + 1}] ${t.success ? (t.parsed?.reply ?? "(invalid structured output)") : `ERROR: ${t.error}`}`).join(" | ")}`);
      lines.push(`- ${data.candidateModel}: ${kRun.turns.map((t) => `[T${t.turnIndex + 1}] ${t.success ? (t.parsed?.reply ?? "(invalid structured output)") : `ERROR: ${t.error}`}`).join(" | ")}`);
      const cHalluc = cRun.turns.flatMap((t) => t.hallucinatedNames);
      const kHalluc = kRun.turns.flatMap((t) => t.hallucinatedNames);
      const cEscalated = cRun.turns.some((t) => t.parsed?.needsHumanReview);
      const kEscalated = kRun.turns.some((t) => t.parsed?.needsHumanReview);
      lines.push(`  - hallucinations: gpt-4o=[${cHalluc.join(", ")}] candidate=[${kHalluc.join(", ")}] | escalated: gpt-4o=${cEscalated} candidate=${kEscalated}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
