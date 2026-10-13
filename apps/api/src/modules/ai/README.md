# AI model routing & A/B experiment

`AiService` never chooses a model itself — it calls `AiModelRouterService.generate()` with the same
instructions/schema/tool-contract regardless of variant, and gets back plain reply text. This is what lets a
model be swapped or rolled back with an environment variable, no code change or redeploy of `AiService` itself.

## Routing

`AiModelRouterService.assign(conversationId, complexityHint)` deterministically assigns each conversation to
**control** (today's model, unchanged behavior) or a **candidate** tier, hashing `conversationId` so a single
conversation never flips variant mid-thread. Tier selection within the candidate arm is a simple, deterministic
heuristic (no extra model call): assisted-buying conversations → `advanced`, short messages → `efficient`,
everything else → `balanced`.

## Config (all optional — unset means "experiment off, control only")

| Env var | Purpose |
|---|---|
| `AI_MODEL_CONTROL` | Control model ID. Falls back to `OPENAI_MODEL`, then `"gpt-4o"`. |
| `AI_MODEL_EFFICIENT` / `AI_MODEL_BALANCED` / `AI_MODEL_ADVANCED` | Candidate model IDs per tier. |
| `AI_MODEL_EXPERIMENT_ENABLED` | `"true"` to route any traffic to a candidate at all. |
| `AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT` | 0–100, share of conversations eligible for a candidate tier. |
| `AI_MODEL_EXPERIMENT_ID` | Label recorded on telemetry rows. |
| `AI_MODEL_REASONING_EFFORT_<TIER>` | Optional `"low"\|"medium"\|"high"`, only sent if set. |
| `AI_MODEL_COST_INPUT_PER_1K_<TIER>` / `AI_MODEL_COST_OUTPUT_PER_1K_<TIER>` | Optional $/1K-token pricing — `estimatedCost` telemetry stays `null` (unknown) until real pricing is configured; never guesses a price. |

## Fallback

If a candidate call throws or returns an invalid/empty response, `generate()` retries exactly once on the
control model before giving up — the customer never sees a candidate-model failure, and the retry is recorded
in telemetry (`fallbackUsed: true`).

## Rollback

Set `AI_MODEL_EXPERIMENT_ENABLED=false` (or leave `AI_MODEL_EXPERIMENT_TRAFFIC_PERCENT=0`) to force 100% of
traffic back onto the control model immediately — no deploy required beyond the env var change.

## Telemetry

Every model attempt (including fallback retries) writes one `AiModelInvocation` row: `experimentId`, `variant`,
`tier`, `modelId`, `latencyMs`, `inputTokens`/`outputTokens`, `estimatedCost`, `success`, `fallbackUsed`,
`errorMessage`. Never stores prompt/reply content or customer data. A telemetry write failure is logged and
swallowed — it can never break the actual customer-facing reply (see `recordInvocation`).

## Conversational shopping interpretation

WhatsApp shopping (the button flow in `shopping-flow` and the free-text engine in `assisted-buying`) shares one
layer, `modules/shopping-intelligence`:

- `shopping-interpretation.ts` — deterministic per-message reading (intent, product terms, budget, colour/size/gender,
  occasion, ordinal, "other / cheaper / similar", new-topic vs refinement). An optional model reading (via
  `AiModelRouterService`) is schema-validated and **only** widens a failed search or fills a gap; it is never
  authoritative for product IDs, prices, stock or order state, and any budget it returns that the customer never typed
  is discarded. Any failure falls back to the deterministic reading.
- `shopping-context.ts` — the one persisted context (`Conversation.assistedBuyingContext`) read by both engines.
- `shopping-ranking.ts` — hard constraints (price ceiling/floor, active, in stock) are applied in the database query and
  re-checked on the returned records; ranking and diversity only reorder what already passed.

| Env var | Effect |
|---|---|
| `SHOPPING_INTERPRETER_ENABLED` | `"false"` disables the model step entirely (deterministic only). Default on. |
| `SHOPPING_INTERPRETER_TIMEOUT_MS` | Max wait for the model reading before falling back. Default `5000`. |

There is no embedding/vector retrieval; model "semantic" help is limited to optional query-expansion terms.

## Out of scope for this pass

The full multi-field `ShoppingContext` (occasion/gender/color/budget/etc.) as a first-class structured input to
`AiService`'s prompt, the 50–100 message offline benchmark set, and live production traffic-percentage tuning
are deliberately deferred — see the PR description for reasoning. `ShoppingFlowService` already persists a
subset of this (gender/color/budget) for its own deterministic flow and is a reasonable starting point if/when
the full `ShoppingContext` redesign is picked up.
