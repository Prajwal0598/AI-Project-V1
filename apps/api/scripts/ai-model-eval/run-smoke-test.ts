// Production smoke test — runs against the EXACT deployed source (commit fa16488, same as af1ccc5's
// feature content + the tsconfig build fix), real OpenAI calls, simulated conversations. No live WhatsApp
// dispatch, no production DB writes — since AI_MODEL_EXPERIMENT_ENABLED=false in production, every real
// conversation only ever reaches gpt-4o anyway, so this exercises the identical code path production uses.
// Run with: npx ts-node run-smoke-test.ts

import * as path from "node:path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

import OpenAI from "openai";
import { OpenAiResponsesProvider } from "../../src/modules/ai/model-provider";
import { REPLY_SCHEMA, buildCatalogueText, buildOrdersContextText, buildSalesInstructions, buildTranscriptInput, filterCatalogueByBudget, matchCatalogueItems } from "../../src/modules/ai/ai.service";
import { FIXTURE_CATALOGUE, FIXTURE_BUSINESS_NAME } from "./fixtures";

const MODEL = "gpt-4o"; // the ONLY model production can ever reach with AI_MODEL_EXPERIMENT_ENABLED=false

async function runTurn(provider: OpenAiResponsesProvider, transcript: string, customerMessage: string) {
  const filtered = filterCatalogueByBudget(FIXTURE_CATALOGUE as never, customerMessage);
  const catalog = buildCatalogueText(filtered as never);
  const instructions = buildSalesInstructions(FIXTURE_BUSINESS_NAME, catalog, buildOrdersContextText([]));
  const input = buildTranscriptInput("Test Customer", "WHATSAPP", transcript);
  const result = await provider.generate({ modelId: MODEL, instructions, input, schemaName: "sales_reply", schema: REPLY_SCHEMA });
  const parsed = JSON.parse(result.text) as { reply: string; items: { productName: string; quantity: number }[]; showProductImages: string[] };
  return { parsed, candidateCatalogueNames: (filtered as typeof FIXTURE_CATALOGUE).map((p) => p.name) };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const provider = new OpenAiResponsesProvider(new OpenAI({ apiKey }));

  console.log("=== SCENARIO 1: Budget enforcement ===");
  {
    const { parsed, candidateCatalogueNames } = await runTurn(provider, "Customer: I need something under ₹3,000", "I need something under ₹3,000");
    const overBudget = candidateCatalogueNames.filter((n) => {
      const m = matchCatalogueItems(FIXTURE_CATALOGUE as never, [{ productName: n, quantity: 1 }]);
      return m.matched[0] && m.matched[0].price > 3000;
    });
    const shown = parsed.showProductImages;
    const fullDump = shown.length === FIXTURE_CATALOGUE.length;
    console.log("customer: I need something under ₹3,000");
    console.log("reply:", parsed.reply);
    console.log("shown:", shown);
    console.log("candidate catalogue (post-filter):", candidateCatalogueNames);
    console.log("overBudgetInCandidateSet:", overBudget, "| fullCatalogueDumped:", fullDump);
    console.log(overBudget.length === 0 && !fullDump ? "PASS" : "FAIL");
  }

  console.log("\n=== SCENARIO 2: Context preservation (3 turns) ===");
  {
    let transcript = "Customer: I'm looking for party wear for men";
    let r1 = await runTurn(provider, transcript, "I'm looking for party wear for men");
    transcript += `\nBusiness: ${r1.parsed.reply}\nCustomer: Under ₹3,000`;
    let r2 = await runTurn(provider, transcript, "Under ₹3,000");
    transcript += `\nBusiness: ${r2.parsed.reply}\nCustomer: Do you have anything in white?`;
    let r3 = await runTurn(provider, transcript, "Do you have anything in white?");
    console.log("turn1 reply:", r1.parsed.reply, "| shown:", r1.parsed.showProductImages);
    console.log("turn2 reply:", r2.parsed.reply, "| shown:", r2.parsed.showProductImages);
    console.log("turn3 reply:", r3.parsed.reply, "| shown:", r3.parsed.showProductImages);
    console.log("turn3 candidate catalogue (post-budget-filter):", r3.candidateCatalogueNames);
  }

  console.log("\n=== SCENARIO 3: Missing size attribute grounding ===");
  {
    const msg = "Does the White Classic Shirt come in size L?";
    const { parsed } = await runTurn(provider, `Customer: ${msg}`, msg);
    console.log("reply:", parsed.reply);
  }

  console.log("\n=== SCENARIO 4: Missing return-policy grounding ===");
  {
    const msg = "What is your return policy?";
    const { parsed } = await runTurn(provider, `Customer: ${msg}`, msg);
    console.log("reply:", parsed.reply);
  }

  console.log("\n=== SCENARIO 5: Normal catalogue grounding (price + inventory) ===");
  {
    const priceMsg = "How much is the White Classic Shirt?";
    const { parsed: priceReply } = await runTurn(provider, `Customer: ${priceMsg}`, priceMsg);
    console.log("price question reply:", priceReply.reply);
    const invMsg = "Is the White Classic Shirt available?";
    const { parsed: invReply } = await runTurn(provider, `Customer: ${invMsg}`, invMsg);
    console.log("inventory question reply:", invReply.reply);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
