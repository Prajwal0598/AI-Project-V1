// Fixed, purpose-built fixture catalogue + scenario definitions for the offline AI model A/B evaluation.
// Deliberately NOT the generic sample-product-catalogue.csv — these scenarios need specific gender/color/
// occasion attributes (party wear, men's/women's, budget bands) that the generic sample data doesn't have.
// Entirely in-memory — no real Postgres/Prisma access, no production data touched.

export interface FixtureVariant { id: string; price: number; currency: string; inventory: number | null }
export interface FixtureProduct { id: string; name: string; variants: FixtureVariant[] }

export const FIXTURE_BUSINESS_NAME = "Relay Test Boutique";

export const FIXTURE_CATALOGUE: FixtureProduct[] = [
  { id: "p_shirt_white", name: "White Classic Shirt", variants: [{ id: "v_shirt_white", price: 1499, currency: "INR", inventory: 12 }] },
  { id: "p_shirt_black", name: "Black Formal Shirt", variants: [{ id: "v_shirt_black", price: 1599, currency: "INR", inventory: 8 }] },
  { id: "p_shirt_blue", name: "Blue Casual Shirt", variants: [{ id: "v_shirt_blue", price: 1299, currency: "INR", inventory: 0 }] }, // deliberately out of stock, for inventory-truth test
  { id: "p_dress_black_party", name: "Black Party Dress", variants: [{ id: "v_dress_black_party", price: 2499, currency: "INR", inventory: 15 }] },
  { id: "p_dress_red_party", name: "Red Party Dress", variants: [{ id: "v_dress_red_party", price: 2799, currency: "INR", inventory: 5 }] },
  { id: "p_suit_men_wedding", name: "Men's Wedding Suit", variants: [{ id: "v_suit_men_wedding", price: 5999, currency: "INR", inventory: 6 }] },
  { id: "p_kurta_men", name: "Men's Festive Kurta", variants: [{ id: "v_kurta_men", price: 1899, currency: "INR", inventory: 20 }] },
  { id: "p_saree_women", name: "Women's Silk Saree", variants: [{ id: "v_saree_women", price: 3499, currency: "INR", inventory: 10 }] },
  { id: "p_jeans", name: "Slim Fit Jeans", variants: [{ id: "v_jeans", price: 1799, currency: "INR", inventory: 30 }] },
  { id: "p_sneakers", name: "Running Sneakers", variants: [{ id: "v_sneakers", price: 2999, currency: "INR", inventory: 0 }] },
];

export interface ScenarioTurn { customer: string }

export interface Scenario {
  id: string;
  name: string;
  category: string;
  llmApplicable: boolean; // false = handled entirely by a deterministic Relay service, no model involved
  turns: ScenarioTurn[];
  expected: string;
  notApplicableReason?: string; // present only when llmApplicable is false
}

export const SCENARIOS: Scenario[] = [
  {
    id: "1", name: "Basic product discovery", category: "Product discovery", llmApplicable: true,
    turns: [{ customer: "I need a shirt" }],
    expected: "Presents shirt options (White Classic Shirt / Black Formal Shirt / Blue Casual Shirt) via showProductImages, using only catalogue names — never a product not in the catalogue.",
  },
  {
    id: "2", name: "Context accumulation (party wear -> men -> budget -> white)", category: "Deterministic shopping-flow context", llmApplicable: false,
    notApplicableReason: "Handled entirely by ShoppingFlowService.search()'s persistent gender/color/budget context (added and regression-tested 2026-09-28) — a deterministic Prisma query, no LLM call. Comparing gpt-4o vs candidate here would be a no-op since neither model is ever invoked.",
    turns: [{ customer: "I need party wear for men" }, { customer: "Under ₹3,000" }, { customer: "Do you have anything in white?" }],
    expected: "Final retrieval preserves party wear + men + budget + white (verified by shopping-flow.service.spec.ts's \"persistent shopping context\" suite, 8/8 passing).",
  },
  {
    id: "3", name: "Intent interruption (quantity prompt -> \"for men\")", category: "Deterministic shopping-flow context", llmApplicable: false,
    notApplicableReason: "Handled by ShoppingFlowService.receiveQuantity()'s INTENT_INTERRUPTION_RE redirect (regression-tested 2026-09-28) — deterministic, no LLM call.",
    turns: [{ customer: "Show me the black party dress" }, { customer: "For men" }],
    expected: "Recognizes \"For men\" as a new shopping constraint and redirects to search(), never rejects it as an invalid quantity (verified by existing regression tests).",
  },
  {
    id: "4", name: "Assisted buying (classy, wedding, budget)", category: "Product discovery", llmApplicable: true,
    turns: [{ customer: "I need something classy for a wedding under ₹3,000" }],
    expected: "Recommends wedding-appropriate items within budget (Men's Festive Kurta ₹1,899 fits; Men's Wedding Suit ₹5,999 and Women's Silk Saree ₹3,499 exceed ₹3,000) using only catalogue names/prices, no hallucinated products.",
  },
  {
    id: "5", name: "Constraint changes (dresses -> men -> shirts -> black)", category: "Deterministic shopping-flow context", llmApplicable: false,
    notApplicableReason: "Handled by ShoppingFlowService.search()'s explicit-replace-not-accumulate slot logic (regression-tested 2026-09-28) — deterministic, no LLM call.",
    turns: [{ customer: "Show me dresses" }, { customer: "Actually I need something for men" }, { customer: "Show me shirts instead" }, { customer: "Something black" }],
    expected: "Latest valid constraints (men + shirts + black) are reflected in retrieval, old constraints (dresses) are dropped (verified by existing regression tests).",
  },
  {
    id: "6", name: "Product price truth", category: "Guardrail — product truth", llmApplicable: true,
    turns: [{ customer: "How much is the White Classic Shirt?" }],
    expected: "States exactly ₹1,499 (the real catalogue price) — never an invented figure.",
  },
  {
    id: "7", name: "Inventory truth", category: "Guardrail — product truth", llmApplicable: true,
    turns: [{ customer: "Is the Blue Casual Shirt available?" }],
    expected: "States it's out of stock (real inventory = 0) — never claims it's available.",
  },
  {
    id: "8", name: "Product selection (\"the second one\")", category: "Guardrail — product/variant ID correctness", llmApplicable: true,
    turns: [{ customer: "Show me shirts" }, { customer: "I'll take the second one" }],
    expected: "Resolves \"the second one\" against the shirts just shown and carries forward the CORRECT real catalogue product (order of shirts as listed in the catalogue: White, Black, Blue -> \"second\" = Black Formal Shirt) in `items`, never an invented product name.",
  },
  {
    id: "9", name: "Cart view", category: "Guardrail — cart state", llmApplicable: false,
    notApplicableReason: "AiService's free-text flow has NO cart concept at all — it goes straight from `items` to a draft order (no intermediate cart review step). \"View my cart\" only has meaning in the deterministic button-tap flow (ShoppingFlowService + CartService). Running this through AiService would just get a generic non-answer from the model, not a real cart state check — reported as a discovered gap, not tested as a false model comparison.",
    turns: [{ customer: "View my cart" }],
    expected: "N/A for the free-text LLM flow (see notApplicableReason). CartService itself already has direct unit test coverage.",
  },
  {
    id: "10", name: "Natural conversation (wedding recommendation, evolving)", category: "Natural conversation", llmApplicable: true,
    turns: [
      { customer: "I'm going to a wedding next weekend. What would you recommend?" },
      { customer: "Something less formal." },
      { customer: "Do you have it in black?" },
    ],
    expected: "Recommendation evolves naturally across turns (formal wedding wear -> less formal alternative -> black option), preserving context via the transcript, using only real catalogue items.",
  },
  {
    id: "11", name: "Out-of-scope / general catalogue question", category: "General catalogue question", llmApplicable: true,
    turns: [{ customer: "What do you sell?" }],
    expected: "Answers as a general catalogue/business overview question (e.g. describes the range of categories), not a narrow keyword search returning zero results.",
  },
  {
    id: "12", name: "Proactive follow-up safety (active conversation)", category: "Deterministic proactive-messaging guardrail", llmApplicable: false,
    notApplicableReason: "Handled by OpportunityService.isConversationActive() in a completely separate code path (background worker jobs creating proactive Opportunity records) — not part of AiService.generateAndSendReply at all. No model is ever involved. Regression-tested 2026-09-28 (3/3 passing).",
    turns: [{ customer: "(customer is actively chatting — background follow-up job would run concurrently in production)" }],
    expected: "No proactive follow-up is auto-sent while the customer is mid-conversation (verified by existing regression tests).",
  },
];
