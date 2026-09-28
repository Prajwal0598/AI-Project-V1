// Offline model-comparison harness for the AI Model Upgrade & A/B Testing feature.
// STRICTLY OFFLINE w.r.t. Relay itself: no Postgres/Prisma access, no production env vars touched, no
// deploy, no experiment flag flipped. The ONLY network calls made are direct OpenAI API calls using the
// LOCAL .env's OPENAI_API_KEY, for comparison purposes only.
//
// Run with: npx ts-node run-eval.ts   (from this directory)

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

import OpenAI from "openai";
import { OpenAiResponsesProvider } from "../../src/modules/ai/model-provider";
import { REPLY_SCHEMA, buildCatalogueText, buildOrdersContextText, buildSalesInstructions, buildTranscriptInput, matchCatalogueItems, filterCatalogueByBudget } from "../../src/modules/ai/ai.service";
import { FIXTURE_CATALOGUE, FIXTURE_BUSINESS_NAME, SCENARIOS, Scenario } from "./fixtures";

const CONTROL_MODEL = "gpt-4o";
const CANDIDATE_MODEL = "gpt-5.6-terra"; // == default AI_MODEL_BALANCED, per explicit instruction this run

// public GPT-4o pricing as of this codebase's last known reference point — used ONLY to estimate the control
// side's cost; gpt-5.6-terra has no published pricing I have any confidence in, so its cost is reported as
// "unknown" rather than guessed (same principle as AiModelRouterService.estimateCost never inventing a price).
const GPT_4O_INPUT_COST_PER_1K = 0.0025;
const GPT_4O_OUTPUT_COST_PER_1K = 0.01;

type ReplyPayload = {
  reply: string; items: { productName: string; quantity: number }[];
  shippingAddress: string | null; paymentMethod: string | null; orderConfirmed: boolean; cancelOrder: boolean;
  needsHumanReview: boolean; needsHumanReviewReason: string | null; showProductImages: string[];
};

interface TurnResult {
  turnIndex: number;
  customerMessage: string;
  success: boolean;
  error: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  rawText: string | null;
  structuredOutputValid: boolean;
  parsed: ReplyPayload | null;
  hallucinatedNames: string[]; // names in items/showProductImages that don't match any real catalogue product
  candidateCatalogueNames: string[]; // exactly what this turn's filterCatalogueByBudget()-filtered catalogue contained (what the model COULD see)
}

interface ScenarioModelRun {
  modelId: string;
  turns: TurnResult[];
}

interface ScenarioResult {
  scenario: Scenario;
  control: ScenarioModelRun | null; // null when llmApplicable is false
  candidate: ScenarioModelRun | null;
  verdict: {
    control: Record<string, unknown>;
    candidate: Record<string, unknown>;
  } | null;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/s$/, "");
}

function findHallucinatedNames(names: string[]): string[] {
  return names.filter((n) => !FIXTURE_CATALOGUE.some((p) => normalize(p.name) === normalize(n) || normalize(p.name).includes(normalize(n)) || normalize(n).includes(normalize(p.name))));
}

async function runTurn(provider: OpenAiResponsesProvider, modelId: string, transcript: string, turnIndex: number, customerMessage: string): Promise<{ turn: TurnResult; replyForTranscript: string }> {
  // mirrors AiService.generateAndSendReply() exactly: the candidate catalogue is filtered by budgetMax parsed
  // from the CURRENT turn's customer message, rebuilt fresh every turn (never cached/reused across turns).
  const filteredCatalogue = filterCatalogueByBudget(FIXTURE_CATALOGUE as never, customerMessage);
  const candidateCatalogueNames = (filteredCatalogue as typeof FIXTURE_CATALOGUE).map((p) => p.name);
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
    } catch {
      structuredOutputValid = false;
    }
    const namesUsed = [...(parsed?.items?.map((i) => i.productName) ?? []), ...(parsed?.showProductImages ?? [])];
    const hallucinatedNames = findHallucinatedNames(namesUsed);
    return {
      turn: {
        turnIndex, customerMessage, success: true, error: null, latencyMs,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        rawText: result.text, structuredOutputValid, parsed, hallucinatedNames, candidateCatalogueNames,
      },
      replyForTranscript: parsed?.reply ?? "(no reply — structured output was invalid)",
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      turn: {
        turnIndex, customerMessage, success: false, error: error instanceof Error ? error.message : String(error), latencyMs,
        rawText: null, structuredOutputValid: false, parsed: null, hallucinatedNames: [], candidateCatalogueNames,
      },
      replyForTranscript: "(model call failed)",
    };
  }
}

async function runScenarioForModel(provider: OpenAiResponsesProvider, modelId: string, scenario: Scenario): Promise<ScenarioModelRun> {
  let transcript = "";
  const turns: TurnResult[] = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    transcript += (transcript ? "\n" : "") + `Customer: ${scenario.turns[i].customer}`;
    const { turn, replyForTranscript } = await runTurn(provider, modelId, transcript, i, scenario.turns[i].customer);
    turns.push(turn);
    transcript += `\nBusiness: ${replyForTranscript}`;
  }
  return { modelId, turns };
}

// per-scenario automated heuristic checks — deliberately conservative: anything genuinely subjective
// (naturalness, tone) is left as "requires human review" rather than faked with a keyword score.
function evaluateRun(scenario: Scenario, run: ScenarioModelRun): Record<string, unknown> {
  const anyHallucination = run.turns.some((t) => t.hallucinatedNames.length > 0);
  const anyStructuredFailure = run.turns.some((t) => t.success && !t.structuredOutputValid);
  const anyCallFailure = run.turns.some((t) => !t.success);
  const lastTurn = run.turns[run.turns.length - 1];
  const lastReply = lastTurn?.parsed?.reply?.toLowerCase() ?? "";

  const base = {
    callFailure: anyCallFailure,
    structuredOutputValid: !anyStructuredFailure && !anyCallFailure,
    hallucination: anyHallucination,
    hallucinatedNames: run.turns.flatMap((t) => t.hallucinatedNames),
  };

  switch (scenario.id) {
    case "1": {
      const shown = lastTurn?.parsed?.showProductImages ?? [];
      const shirtsShown = shown.filter((n) => /shirt/i.test(n));
      return { ...base, productCorrectness: shirtsShown.length > 0, notes: `showProductImages=${JSON.stringify(shown)}` };
    }
    case "4": {
      const shown = [...(lastTurn?.parsed?.showProductImages ?? []), ...(lastTurn?.parsed?.items?.map((i) => i.productName) ?? [])];
      const matched = matchCatalogueItems(FIXTURE_CATALOGUE as never, shown.map((n) => ({ productName: n, quantity: 1 })));
      const overBudget = matched.matched.filter((m) => m.price > 3000);
      const candidateCatalogueNames = lastTurn?.candidateCatalogueNames ?? [];
      const sareeInCandidateSet = candidateCatalogueNames.some((n) => normalize(n) === normalize("Women's Silk Saree"));
      const suitInCandidateSet = candidateCatalogueNames.some((n) => normalize(n) === normalize("Men's Wedding Suit"));
      return {
        ...base, constraintAdherence: overBudget.length === 0, overBudgetItems: overBudget.map((m) => `${m.name} (₹${m.price})`),
        candidateCatalogueNames, sareeInCandidateSet, suitInCandidateSet, fullCatalogueDumped: candidateCatalogueNames.length === FIXTURE_CATALOGUE.length,
        notes: `recommended=${JSON.stringify(shown)}`,
      };
    }
    case "6": {
      const mentionsCorrectPrice = /1,?499/.test(lastReply);
      const mentionsWrongPrice = /₹\s?\d{3,5}/.test(lastReply) && !mentionsCorrectPrice;
      return { ...base, productCorrectness: mentionsCorrectPrice, priceHallucination: mentionsWrongPrice, notes: `reply="${lastTurn?.parsed?.reply}"` };
    }
    case "7": {
      const saysUnavailable = /(out of stock|not available|unavailable|sold out|no longer available)/.test(lastReply);
      const saysAvailable = /(in stock|available|yes.*have)/.test(lastReply) && !saysUnavailable;
      return { ...base, inventoryCorrectness: saysUnavailable, falseAvailabilityClaim: saysAvailable, notes: `reply="${lastTurn?.parsed?.reply}"` };
    }
    case "8": {
      const turn1Shown = run.turns[0]?.parsed?.showProductImages ?? [];
      const expectedSecond = turn1Shown[1] ?? null;
      const turn2Item = run.turns[1]?.parsed?.items?.[0]?.productName ?? null;
      const productIdCorrectness = expectedSecond !== null && turn2Item !== null && normalize(expectedSecond) === normalize(turn2Item);
      return { ...base, productIdCorrectness, notes: `turn1 shown=${JSON.stringify(turn1Shown)}, expected "second"="${expectedSecond}", turn2 item="${turn2Item}"` };
    }
    case "10": {
      const allNonEmpty = run.turns.every((t) => (t.parsed?.reply?.length ?? 0) > 0);
      const turn2ShownCount = run.turns[1]?.parsed?.showProductImages?.length ?? 0;
      const turn3Escalated = run.turns[2]?.parsed?.needsHumanReview ?? false;
      const turn3Reason = run.turns[2]?.parsed?.needsHumanReviewReason ?? null;
      // the original bug was escalating turn 3 despite exactly ONE clearly-identified product from turn 2 (the
      // color attribute simply being absent from the catalogue is not real ambiguity); escalating when turn 2
      // showed MULTIPLE products with no single referent chosen is a different, legitimate ambiguity case.
      const unnecessaryEscalation = turn3Escalated && turn2ShownCount === 1;
      return { ...base, contextRetention: "requires human review (see per-turn replies)", naturalness: "requires human review", nonEmptyReplies: allNonEmpty, turn2ShownCount, turn3Escalated, turn3Reason, unnecessaryEscalation };
    }
    case "11": {
      const claimsNoResults = /(couldn't find|no results|no products|don't have anything)/.test(lastReply);
      return { ...base, intentCorrectness: !claimsNoResults, notes: `reply="${lastTurn?.parsed?.reply}"` };
    }
    default:
      return base;
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — aborting (no API calls made).");

  const scenarioFilter = process.env.EVAL_SCENARIOS ? new Set(process.env.EVAL_SCENARIOS.split(",")) : null;
  const applicable = SCENARIOS.filter((s) => s.llmApplicable && (!scenarioFilter || scenarioFilter.has(s.id)));
  const totalTurns = applicable.reduce((sum, s) => sum + s.turns.length, 0);
  const totalCalls = totalTurns * 2;
  console.log(`Applicable (LLM-routed) scenarios: ${applicable.length} / ${SCENARIOS.length}`);
  console.log(`Total turns: ${totalTurns} x 2 models = ${totalCalls} real OpenAI API calls`);
  console.log(`Control model: ${CONTROL_MODEL}, Candidate model: ${CANDIDATE_MODEL}`);

  const client = new OpenAI({ apiKey });
  const provider = new OpenAiResponsesProvider(client);

  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    if (scenarioFilter && !scenarioFilter.has(scenario.id)) continue;
    if (!scenario.llmApplicable) {
      results.push({ scenario, control: null, candidate: null, verdict: null });
      console.log(`[SKIP - deterministic, no model call] Test ${scenario.id}: ${scenario.name}`);
      continue;
    }
    console.log(`[RUNNING] Test ${scenario.id}: ${scenario.name}`);
    const control = await runScenarioForModel(provider, CONTROL_MODEL, scenario);
    const candidate = await runScenarioForModel(provider, CANDIDATE_MODEL, scenario);
    const verdict = { control: evaluateRun(scenario, control), candidate: evaluateRun(scenario, candidate) };
    results.push({ scenario, control, candidate, verdict });
  }

  // aggregates
  function aggregate(modelId: string, pick: (r: ScenarioResult) => ScenarioModelRun | null) {
    const runs = results.map(pick).filter((r): r is ScenarioModelRun => r !== null);
    const allTurns = runs.flatMap((r) => r.turns);
    const successfulTurns = allTurns.filter((t) => t.success);
    const totalTests = runs.length;
    const verdicts = results.map((r) => (pick(r) ? (modelId === CONTROL_MODEL ? r.verdict?.control : r.verdict?.candidate) : null)).filter(Boolean) as Record<string, unknown>[];
    const passed = verdicts.filter((v) => !v.callFailure && v.structuredOutputValid && !v.hallucination && v.productCorrectness !== false && v.constraintAdherence !== false && v.productIdCorrectness !== false && v.inventoryCorrectness !== false && v.intentCorrectness !== false).length;
    const hallucinationCount = verdicts.filter((v) => v.hallucination).length;
    const structuredFailureCount = verdicts.filter((v) => !v.structuredOutputValid).length;
    const avgLatency = successfulTurns.length ? Math.round(successfulTurns.reduce((s, t) => s + t.latencyMs, 0) / successfulTurns.length) : null;
    const avgInputTokens = successfulTurns.length ? Math.round(successfulTurns.reduce((s, t) => s + (t.inputTokens ?? 0), 0) / successfulTurns.length) : null;
    const avgOutputTokens = successfulTurns.length ? Math.round(successfulTurns.reduce((s, t) => s + (t.outputTokens ?? 0), 0) / successfulTurns.length) : null;
    const totalInputTokens = successfulTurns.reduce((s, t) => s + (t.inputTokens ?? 0), 0);
    const totalOutputTokens = successfulTurns.reduce((s, t) => s + (t.outputTokens ?? 0), 0);
    const estimatedCost = modelId === CONTROL_MODEL
      ? Number(((totalInputTokens / 1000) * GPT_4O_INPUT_COST_PER_1K + (totalOutputTokens / 1000) * GPT_4O_OUTPUT_COST_PER_1K).toFixed(4))
      : null; // no published pricing for gpt-5.6-terra — never guessed
    return { modelId, totalTests, passed, failed: totalTests - passed, hallucinationCount, structuredOutputFailureCount: structuredFailureCount, avgLatencyMs: avgLatency, avgInputTokens, avgOutputTokens, totalInputTokens, totalOutputTokens, estimatedCostUsd: estimatedCost, callFailures: allTurns.filter((t) => !t.success).length };
  }

  const controlAgg = aggregate(CONTROL_MODEL, (r) => r.control);
  const candidateAgg = aggregate(CANDIDATE_MODEL, (r) => r.candidate);

  const outDir = path.join(__dirname, "results", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });

  const jsonOut = { generatedAt: new Date().toISOString(), controlModel: CONTROL_MODEL, candidateModel: CANDIDATE_MODEL, aggregates: { control: controlAgg, candidate: candidateAgg }, scenarios: results };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(jsonOut, null, 2));

  const md = renderMarkdown(jsonOut);
  fs.writeFileSync(path.join(outDir, "report.md"), md);

  console.log(`\nResults written to:\n  ${path.join(outDir, "results.json")}\n  ${path.join(outDir, "report.md")}`);
  console.log(`\nControl (${CONTROL_MODEL}) aggregate:`, controlAgg);
  console.log(`Candidate (${CANDIDATE_MODEL}) aggregate:`, candidateAgg);
}

function renderMarkdown(data: { generatedAt: string; controlModel: string; candidateModel: string; aggregates: { control: Record<string, unknown>; candidate: Record<string, unknown> }; scenarios: ScenarioResult[] }): string {
  const lines: string[] = [];
  lines.push(`# AI Model Offline Evaluation — ${data.controlModel} vs ${data.candidateModel}`, "", `Generated: ${data.generatedAt}`, "");
  lines.push("## Aggregate metrics (metric-by-metric — no overall winner score)", "");
  lines.push("| Metric | " + data.controlModel + " | " + data.candidateModel + " |", "|---|---|---|");
  const keys = ["totalTests", "passed", "failed", "hallucinationCount", "structuredOutputFailureCount", "callFailures", "avgLatencyMs", "avgInputTokens", "avgOutputTokens", "estimatedCostUsd"];
  for (const k of keys) lines.push(`| ${k} | ${data.aggregates.control[k as never] ?? "n/a"} | ${data.aggregates.candidate[k as never] ?? "n/a"} |`);
  lines.push("");

  lines.push("## Per-test comparison", "");
  for (const r of data.scenarios) {
    lines.push(`### TEST ${r.scenario.id} — ${r.scenario.name} (${r.scenario.category})`, "");
    if (!r.scenario.llmApplicable) {
      lines.push(`**N/A — deterministic, no model call.** ${r.scenario.notApplicableReason}`, "");
      continue;
    }
    lines.push(`**Expected:** ${r.scenario.expected}`, "");
    lines.push(`**${data.controlModel}:**`);
    for (const t of r.control!.turns) lines.push(`- Turn ${t.turnIndex + 1} ("${t.customerMessage}"): ${t.success ? (t.parsed?.reply ?? "(invalid structured output)") : `ERROR: ${t.error}`}`);
    lines.push("", `**${data.candidateModel}:**`);
    for (const t of r.candidate!.turns) lines.push(`- Turn ${t.turnIndex + 1} ("${t.customerMessage}"): ${t.success ? (t.parsed?.reply ?? "(invalid structured output)") : `ERROR: ${t.error}`}`);
    lines.push("", `**Verdict — ${data.controlModel}:** ${JSON.stringify(r.verdict!.control)}`);
    lines.push(`**Verdict — ${data.candidateModel}:** ${JSON.stringify(r.verdict!.candidate)}`, "");
  }
  return lines.join("\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
