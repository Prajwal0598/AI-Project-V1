// One-off, read-only check: does this OpenAI API key/project have access to each candidate model ID?
// Uses the Models API (list/retrieve) — no completions, no prompt tokens, negligible/no cost.
// Run with: node check-model-access.js   (from this directory)
require("dotenv").config({ path: "../../../../.env" });
const OpenAI = require("openai");

const MODEL_IDS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-4o", "gpt-4.1", "gpt-4o-mini"];

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set in .env — aborting.");
    process.exit(1);
  }
  const client = new OpenAI({ apiKey });

  const results = [];
  for (const modelId of MODEL_IDS) {
    try {
      const model = await client.models.retrieve(modelId);
      results.push({ modelId, accessible: true, ownedBy: model.owned_by ?? null, error: null });
    } catch (err) {
      const status = err && err.status ? err.status : null;
      const message = err && err.message ? err.message : String(err);
      results.push({ modelId, accessible: false, ownedBy: null, error: { status, message } });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main();
