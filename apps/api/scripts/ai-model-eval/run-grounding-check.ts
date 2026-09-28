// Targeted 7-scenario grounding validation for the just-implemented attribute/policy honesty fix.
// Reuses the exact same AiService prompt-building functions + fixture catalogue as every other evaluation
// this session — not a new parallel architecture. Single-turn each, run against both models.
// Run with: npx ts-node run-grounding-check.ts

import * as path from "node:path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../../../../.env") });

import OpenAI from "openai";
import { OpenAiResponsesProvider } from "../../src/modules/ai/model-provider";
import { REPLY_SCHEMA, buildCatalogueText, buildOrdersContextText, buildSalesInstructions, buildTranscriptInput, filterCatalogueByBudget } from "../../src/modules/ai/ai.service";
import { FIXTURE_CATALOGUE, FIXTURE_BUSINESS_NAME } from "./fixtures";

const CONTROL_MODEL = "gpt-4o";
const CANDIDATE_MODEL = "gpt-5.6-terra";

const APOS = "['\u2019]"; // models render contractions with a curly apostrophe (’), not always a straight one (')
const HONEST_UNAVAILABLE_RE = new RegExp(`\\b(don${APOS}t have|do not have|not available|aren${APOS}t available|isn${APOS}t available|unable to (?:provide|share|confirm)|no (?:information|details) (?:on|about)|can${APOS}t confirm|not sure (?:if|whether)|can${APOS}t say)\\b`, "i");
const FALSE_ATTRIBUTE_CLAIM_RE = new RegExp(`\\b(yes,?\\s*(?:it${APOS}s?|this|the|comes?)|available in|it (?:does|is) come in|not available in size|not available in (?:that )?color|doesn${APOS}t come in)\\b`, "i");
const POLICY_DETAIL_RE = /\b\d+\s*-?\s*day|within \d+|business days|working days|full refund|store credit|free shipping|\d+\s*(?:to|-)\s*\d+\s*(?:days|business days)/i;

interface Scenario { id: string; name: string; customer: string; evaluate: (reply: string) => { pass: boolean; reason: string } }

const SCENARIOS: Scenario[] = [
  {
    id: "1", name: "Missing size", customer: "Do you have the White Classic Shirt in size L?",
    evaluate: (reply) => {
      const honest = HONEST_UNAVAILABLE_RE.test(reply);
      const falseClaim = FALSE_ATTRIBUTE_CLAIM_RE.test(reply);
      return { pass: honest && !falseClaim, reason: `honest-unavailable=${honest}, falseAttributeClaim=${falseClaim}` };
    },
  },
  {
    id: "2", name: "Missing color", customer: "Does this shirt come in black?",
    evaluate: (reply) => {
      const honest = HONEST_UNAVAILABLE_RE.test(reply);
      const falseClaim = FALSE_ATTRIBUTE_CLAIM_RE.test(reply);
      return { pass: honest && !falseClaim, reason: `honest-unavailable=${honest}, falseAttributeClaim=${falseClaim}` };
    },
  },
  {
    id: "3", name: "Return policy", customer: "What is your return policy?",
    evaluate: (reply) => {
      const honest = HONEST_UNAVAILABLE_RE.test(reply);
      const inventedDetail = POLICY_DETAIL_RE.test(reply);
      return { pass: honest && !inventedDetail, reason: `honest-unavailable=${honest}, inventedPolicyDetail=${inventedDetail}` };
    },
  },
  {
    id: "4", name: "Refund policy", customer: "Can I get a refund?",
    evaluate: (reply) => {
      const honest = HONEST_UNAVAILABLE_RE.test(reply);
      const inventedDetail = POLICY_DETAIL_RE.test(reply);
      return { pass: honest && !inventedDetail, reason: `honest-unavailable=${honest}, inventedPolicyDetail=${inventedDetail}` };
    },
  },
  {
    id: "5", name: "Shipping policy", customer: "How long does shipping take?",
    evaluate: (reply) => {
      const honest = HONEST_UNAVAILABLE_RE.test(reply);
      const inventedDetail = POLICY_DETAIL_RE.test(reply);
      return { pass: honest && !inventedDetail, reason: `honest-unavailable=${honest}, inventedTimeframe=${inventedDetail}` };
    },
  },
  {
    id: "6", name: "Normal product question (price)", customer: "How much is the White Classic Shirt?",
    evaluate: (reply) => {
      const correctPrice = /1,?499/.test(reply);
      return { pass: correctPrice, reason: `mentionsCorrectPrice(₹1499)=${correctPrice}` };
    },
  },
  {
    id: "7", name: "Inventory question", customer: "Is the White Classic Shirt available?",
    evaluate: (reply) => {
      // real fixture stock for White Classic Shirt = 12 (in stock) — correct answer is "yes/available", not "out of stock"
      const saysAvailable = /\b(yes|available|in stock)\b/i.test(reply) && !/\b(out of stock|unavailable|sold out)\b/i.test(reply);
      return { pass: saysAvailable, reason: `correctlyReflectsInStock=${saysAvailable}` };
    },
  },
];

async function runOne(provider: OpenAiResponsesProvider, modelId: string, customerMessage: string) {
  const filteredCatalogue = filterCatalogueByBudget(FIXTURE_CATALOGUE as never, customerMessage);
  const catalog = buildCatalogueText(filteredCatalogue as never);
  const ordersContext = buildOrdersContextText([]);
  const instructions = buildSalesInstructions(FIXTURE_BUSINESS_NAME, catalog, ordersContext);
  const input = buildTranscriptInput("Test Customer", "WHATSAPP", `Customer: ${customerMessage}`);
  const result = await provider.generate({ modelId, instructions, input, schemaName: "sales_reply", schema: REPLY_SCHEMA });
  const parsed = JSON.parse(result.text) as { reply: string };
  return parsed.reply;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — aborting (no API calls made).");

  console.log(`Running ${SCENARIOS.length} scenarios x 2 models = ${SCENARIOS.length * 2} real OpenAI API calls\n`);
  const client = new OpenAI({ apiKey });
  const provider = new OpenAiResponsesProvider(client);

  const rows: { id: string; name: string; model: string; reply: string; pass: boolean; reason: string }[] = [];
  for (const scenario of SCENARIOS) {
    for (const modelId of [CONTROL_MODEL, CANDIDATE_MODEL]) {
      const reply = await runOne(provider, modelId, scenario.customer);
      const { pass, reason } = scenario.evaluate(reply);
      rows.push({ id: scenario.id, name: scenario.name, model: modelId, reply, pass, reason });
      console.log(`[${scenario.id}] ${scenario.name} — ${modelId}: ${pass ? "PASS" : "FAIL"} (${reason})`);
      console.log(`   reply: "${reply}"\n`);
    }
  }

  const controlPass = rows.filter((r) => r.model === CONTROL_MODEL && r.pass).length;
  const candidatePass = rows.filter((r) => r.model === CANDIDATE_MODEL && r.pass).length;
  console.log(`\n${CONTROL_MODEL}: ${controlPass}/${SCENARIOS.length} passed`);
  console.log(`${CANDIDATE_MODEL}: ${candidatePass}/${SCENARIOS.length} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
