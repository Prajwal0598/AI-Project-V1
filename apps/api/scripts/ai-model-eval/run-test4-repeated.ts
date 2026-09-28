// Investigates the Test 4 (assisted-buying budget) variance reported by run-eval.ts, WITHOUT changing any
// application code or the prompt — pure repeated-sampling measurement using the exact same fixtures/functions.
// Run with: npx ts-node run-test4-repeated.ts

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

import OpenAI from "openai";
import { OpenAiResponsesProvider } from "../../src/modules/ai/model-provider";
import { REPLY_SCHEMA, buildCatalogueText, buildOrdersContextText, buildSalesInstructions, buildTranscriptInput, matchCatalogueItems, filterCatalogueByBudget } from "../../src/modules/ai/ai.service";
import { FIXTURE_CATALOGUE, FIXTURE_BUSINESS_NAME } from "./fixtures";

const CONTROL_MODEL = "gpt-4o";
const CANDIDATE_MODEL = "gpt-5.6-terra";
const BUDGET_MAX = 3000;
const CUSTOMER_MESSAGE = "I need something classy for a wedding under ₹3,000";
const REPETITIONS = 10;

interface RunRecord {
  runIndex: number;
  success: boolean;
  error: string | null;
  structuredOutputValid: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  recommendedNames: string[]; // raw names from items + showProductImages, as returned by the model
  candidateCatalogueNames: string[]; // exactly what filterCatalogueByBudget() let through to this run's prompt
  resolved: { name: string; price: number; inCatalogue: true }[]; // real catalogue matches with real price
  hallucinated: string[]; // names that don't match any real catalogue product at all
  budgetMentioned: boolean;
  budgetAdherent: boolean | null; // null when there's nothing to check (no recommendations at all) or the call failed
  overBudgetProducts: { name: string; price: number }[];
}

async function runOnce(provider: OpenAiResponsesProvider, modelId: string, runIndex: number): Promise<RunRecord> {
  // rebuilt fresh every run (mirrors AiService.generateAndSendReply() exactly) rather than reused across runs
  const filteredCatalogue = filterCatalogueByBudget(FIXTURE_CATALOGUE as never, CUSTOMER_MESSAGE);
  const candidateCatalogueNames = (filteredCatalogue as typeof FIXTURE_CATALOGUE).map((p) => p.name);
  const catalog = buildCatalogueText(filteredCatalogue as never);
  const ordersContext = buildOrdersContextText([]);
  const instructions = buildSalesInstructions(FIXTURE_BUSINESS_NAME, catalog, ordersContext);
  const input = buildTranscriptInput("Test Customer", "WHATSAPP", `Customer: ${CUSTOMER_MESSAGE}`);
  const startedAt = Date.now();
  try {
    const result = await provider.generate({ modelId, instructions, input, schemaName: "sales_reply", schema: REPLY_SCHEMA });
    const latencyMs = Date.now() - startedAt;
    let parsed: { reply: string; items: { productName: string; quantity: number }[]; showProductImages: string[] } | null = null;
    let structuredOutputValid = false;
    try {
      parsed = JSON.parse(result.text);
      structuredOutputValid = !!parsed && typeof parsed.reply === "string" && Array.isArray(parsed.items) && Array.isArray(parsed.showProductImages);
    } catch { structuredOutputValid = false; }

    const recommendedNames = [...(parsed?.items?.map((i) => i.productName) ?? []), ...(parsed?.showProductImages ?? [])];
    const uniqueNames = [...new Set(recommendedNames)];
    const { matched, unmatched } = matchCatalogueItems(FIXTURE_CATALOGUE as never, uniqueNames.map((n) => ({ productName: n, quantity: 1 })));
    const resolved = matched.map((m) => ({ name: m.name, price: m.price, inCatalogue: true as const }));
    const overBudgetProducts = resolved.filter((r) => r.price > BUDGET_MAX).map((r) => ({ name: r.name, price: r.price }));
    const budgetMentioned = /3,?000|budget/i.test(parsed?.reply ?? "");

    return {
      runIndex, success: true, error: null, structuredOutputValid, latencyMs,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      recommendedNames: uniqueNames, candidateCatalogueNames, resolved, hallucinated: unmatched, budgetMentioned,
      budgetAdherent: resolved.length ? overBudgetProducts.length === 0 : null,
      overBudgetProducts,
    };
  } catch (error) {
    return {
      runIndex, success: false, error: error instanceof Error ? error.message : String(error), structuredOutputValid: false,
      latencyMs: Date.now() - startedAt, recommendedNames: [], candidateCatalogueNames, resolved: [], hallucinated: [], budgetMentioned: false,
      budgetAdherent: null, overBudgetProducts: [],
    };
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — aborting (no API calls made).");

  console.log(`Test 4 repeated-sampling investigation: ${REPETITIONS} runs x 2 models = ${REPETITIONS * 2} real OpenAI API calls`);
  console.log(`Control: ${CONTROL_MODEL}, Candidate: ${CANDIDATE_MODEL}, budgetMax: ₹${BUDGET_MAX}\n`);

  // architectural fact, verified directly against ai.service.ts's own Prisma query (not measured empirically):
  // the catalogue query has NO price/budget filter at all (only status=PUBLISHED, take 30) — so there is no
  // retrieval-time budget enforcement in this code path; every product, at every price, reaches the model.
  console.log("NOTE: AiService's product query (line ~184) filters ONLY by status=PUBLISHED (+ take:30) — no");
  console.log("price/budget filter exists at retrieval time in this flow. Every catalogue item, regardless of");
  console.log("price, is always visible to the model. Any budget violation below is therefore necessarily a");
  console.log("MODEL SELECTION outcome, not a retrieval-layer bug — there is no retrieval-layer budget filter");
  console.log("to fail in the first place, for this specific (free-text AiService) code path.\n");

  const client = new OpenAI({ apiKey });
  const provider = new OpenAiResponsesProvider(client);

  async function runModel(modelId: string): Promise<RunRecord[]> {
    const records: RunRecord[] = [];
    for (let i = 0; i < REPETITIONS; i++) {
      process.stdout.write(`  [${modelId}] run ${i + 1}/${REPETITIONS}...`);
      const record = await runOnce(provider, modelId, i);
      records.push(record);
      console.log(` ${record.success ? (record.budgetAdherent === false ? "VIOLATION" : "ok") : "ERROR"}`);
    }
    return records;
  }

  const controlRuns = await runModel(CONTROL_MODEL);
  const candidateRuns = await runModel(CANDIDATE_MODEL);

  function summarize(modelId: string, runs: RunRecord[]) {
    const successfulRuns = runs.filter((r) => r.success);
    const adherentRuns = successfulRuns.filter((r) => r.budgetAdherent !== false); // null (no recs) counts as adherent — nothing violated
    const violatingRuns = successfulRuns.filter((r) => r.budgetAdherent === false);
    const allOverBudgetProducts = [...new Set(violatingRuns.flatMap((r) => r.overBudgetProducts.map((p) => `${p.name} (₹${p.price})`)))];
    const allHallucinated = [...new Set(runs.flatMap((r) => r.hallucinated))];
    const sareeEverInCandidateSet = runs.some((r) => r.candidateCatalogueNames.some((n) => n === "Women's Silk Saree"));
    const suitEverInCandidateSet = runs.some((r) => r.candidateCatalogueNames.some((n) => n === "Men's Wedding Suit"));
    const avgLatency = successfulRuns.length ? Math.round(successfulRuns.reduce((s, r) => s + r.latencyMs, 0) / successfulRuns.length) : null;
    const avgInputTokens = successfulRuns.length ? Math.round(successfulRuns.reduce((s, r) => s + (r.inputTokens ?? 0), 0) / successfulRuns.length) : null;
    const avgOutputTokens = successfulRuns.length ? Math.round(successfulRuns.reduce((s, r) => s + (r.outputTokens ?? 0), 0) / successfulRuns.length) : null;
    return {
      modelId, totalRuns: runs.length, callFailures: runs.length - successfulRuns.length,
      budgetAdherentRuns: adherentRuns.length, violations: violatingRuns.length,
      violationRate: `${Math.round((violatingRuns.length / runs.length) * 100)}%`,
      overBudgetProductsInvolved: allOverBudgetProducts, hallucinatedNames: allHallucinated,
      sareeEverInCandidateSet, suitEverInCandidateSet,
      structuredOutputFailures: runs.filter((r) => r.success && !r.structuredOutputValid).length,
      avgLatencyMs: avgLatency, avgInputTokens, avgOutputTokens,
    };
  }

  const controlSummary = summarize(CONTROL_MODEL, controlRuns);
  const candidateSummary = summarize(CANDIDATE_MODEL, candidateRuns);

  const outDir = path.join(__dirname, "results", `test4-repeated-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), controlModel: CONTROL_MODEL, candidateModel: CANDIDATE_MODEL, budgetMax: BUDGET_MAX, controlSummary, candidateSummary, controlRuns, candidateRuns }, null, 2));

  console.log(`\nResults written to: ${path.join(outDir, "results.json")}\n`);
  console.log(`${CONTROL_MODEL}:`, controlSummary);
  console.log(`${CANDIDATE_MODEL}:`, candidateSummary);
}

main().catch((err) => { console.error(err); process.exit(1); });
