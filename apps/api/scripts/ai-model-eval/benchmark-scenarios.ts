// 30-category benchmark scenario set for the larger offline model-comparison benchmark.
// Reuses FIXTURE_CATALOGUE/FIXTURE_BUSINESS_NAME from fixtures.ts (the same catalogue used in every prior
// evaluation this session) — deliberately not a new/parallel fixture set, for direct comparability.

export interface BenchmarkTurn { customer: string }

export interface BenchmarkScenario {
  id: string;
  category: string;
  name: string;
  turns: BenchmarkTurn[];
  // categories where run-to-run LLM sampling variance is the whole point being measured (matches this
  // session's own prior findings: budget adherence and escalation legitimacy both varied run-to-run)
  resample: boolean;
  // for categories deterministically intercepted BEFORE the model in real Relay (PAYMENT_CLAIM_RE /
  // ORDER_STATUS_QUERY_RE guards in ai.service.ts) — the harness mirrors those exact guards so these
  // categories correctly report "guarded, not applicable to model comparison" instead of asking a model
  // something production would never actually ask it.
  guardApplicable?: "payment" | "order_status";
}

export const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  { id: "b1", category: "1. Basic product discovery", name: "Plain product-type request", resample: false,
    turns: [{ customer: "I need a shirt" }] },

  { id: "b2", category: "2. Assisted buying", name: "Open-ended styled request, no budget", resample: false,
    turns: [{ customer: "I need something classy for a wedding" }] },

  { id: "b3", category: "3. Multi-turn context retention", name: "Shirt -> formal -> black, across 3 turns", resample: false,
    turns: [{ customer: "I need a shirt" }, { customer: "Something formal" }, { customer: "In black" }] },

  { id: "b4", category: "4. Budget constraints", name: "Wedding outfit under ₹3,000 (flagship budget test)", resample: true,
    turns: [{ customer: "I need something classy for a wedding under ₹3,000" }] },

  { id: "b5", category: "5. Color constraints", name: "Shirts, then narrow to black", resample: false,
    turns: [{ customer: "Show me shirts" }, { customer: "In black" }] },

  { id: "b6", category: "6. Size constraints", name: "Size question the catalogue has no data for", resample: false,
    turns: [{ customer: "Does the Men's Festive Kurta come in size L?" }] },

  { id: "b7", category: "7. Gender constraints", name: "Men's items under a budget", resample: false,
    turns: [{ customer: "I need something for men under ₹2,000" }] },

  { id: "b8", category: "8. Multiple simultaneous constraints", name: "Color + gender + budget together", resample: false,
    turns: [{ customer: "I need a black shirt for men under ₹1,600" }] },

  { id: "b9", category: "9. Changing requirements", name: "Dresses -> full category switch to shirts", resample: false,
    turns: [{ customer: "Show me dresses" }, { customer: "Actually, show me shirts instead" }] },

  { id: "b10", category: "10. \"Actually...\" corrections", name: "Pick one item, then correct to another", resample: false,
    turns: [{ customer: "I'll take the White Classic Shirt" }, { customer: "Actually, make it the Black Formal Shirt instead" }] },

  { id: "b11", category: "11. \"That one\" references", name: "Ambiguous singular reference after 2 items shown", resample: false,
    turns: [{ customer: "Show me party dresses" }, { customer: "I'll take that one" }] },

  { id: "b12", category: "12. \"The second one\" references", name: "Ordinal reference after shirts shown", resample: false,
    turns: [{ customer: "Show me shirts" }, { customer: "I'll take the second one" }] },

  { id: "b13", category: "13. Product attribute questions", name: "Material question the catalogue has no data for", resample: false,
    turns: [{ customer: "What material is the Women's Silk Saree made of?" }] },

  { id: "b14", category: "14. Product comparison", name: "Compare two real catalogue products", resample: false,
    turns: [{ customer: "What's the difference between the Black Party Dress and the Red Party Dress?" }] },

  { id: "b15", category: "15. Recommendation requests", name: "Open casual-outfit recommendation", resample: false,
    turns: [{ customer: "What would you recommend for a casual weekend outfit?" }] },

  { id: "b16", category: "16. Ambiguous requests", name: "Extremely vague, no constraints at all", resample: false,
    turns: [{ customer: "Show me something nice" }] },

  { id: "b17", category: "17. Legitimate human escalation", name: "Genuine complaint, should escalate", resample: true,
    turns: [{ customer: "I received the wrong item and I'm extremely unhappy about it, I want a refund immediately" }] },

  { id: "b18", category: "18. Avoidable human escalation", name: "Single clear product, missing attribute — should NOT escalate", resample: true,
    turns: [{ customer: "Do you have the Men's Festive Kurta in blue?" }] },

  { id: "b19", category: "19. Cart actions", name: "Add to cart, then view cart", resample: false,
    turns: [{ customer: "Add the White Classic Shirt to my cart" }, { customer: "What's in my cart?" }] },

  { id: "b20", category: "20. Product selection", name: "First-ordinal selection after dresses shown", resample: false,
    turns: [{ customer: "Show me dresses" }, { customer: "I want the first one" }] },

  { id: "b21", category: "21. Product price questions", name: "Direct price question", resample: false,
    turns: [{ customer: "How much is the Men's Wedding Suit?" }] },

  { id: "b22", category: "22. Inventory questions", name: "Stock question on a deliberately out-of-stock item", resample: false,
    turns: [{ customer: "Do you have the Running Sneakers in stock?" }] },

  { id: "b23", category: "23. Order questions", name: "Order-status question (should be deterministically guarded)", resample: false, guardApplicable: "order_status",
    turns: [{ customer: "Where is my order?" }] },

  { id: "b24", category: "24. Payment questions", name: "Unverified payment claim (should be deterministically guarded)", resample: false, guardApplicable: "payment",
    turns: [{ customer: "I have already paid for my order" }] },

  { id: "b25", category: "25. General catalogue questions", name: "What do you sell, broadly", resample: false,
    turns: [{ customer: "What categories of products do you have?" }] },

  { id: "b26", category: "26. Natural conversational shopping", name: "Open, evolving, budget-aware natural chat", resample: false,
    turns: [
      { customer: "Hey! I'm looking for something to wear to my sister's engagement party next month, nothing too expensive" },
      { customer: "Maybe something with a bit of color" },
      { customer: "That sounds good, how much is it?" },
    ] },

  { id: "b27", category: "27. Out-of-scope questions", name: "Genuinely out-of-scope policy question", resample: false,
    turns: [{ customer: "What's your return policy?" }] },

  { id: "b28", category: "28. Customer dissatisfaction/correction", name: "Frustrated correction — should NOT unnecessarily escalate", resample: false,
    turns: [{ customer: "Show me shirts" }, { customer: "That's not what I asked for, I wanted something under ₹2,000, not this" }] },

  { id: "b29", category: "29. Cross-sell/upsell context", name: "What goes well with a just-bought item", resample: false,
    turns: [{ customer: "I just bought the Men's Wedding Suit, what else would go well with it?" }] },

  { id: "b30", category: "30. Multiple constraints then a constraint change", name: "Women's party wear under budget -> switch to men's", resample: false,
    turns: [{ customer: "I need party wear for women under ₹3,000" }, { customer: "Actually, make it for men" }] },
];
