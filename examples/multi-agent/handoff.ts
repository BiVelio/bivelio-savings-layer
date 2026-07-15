/**
 * Multi-agent handoff example. Run: pnpm example:handoff
 *
 * Instead of re-explaining system + tools + context in prose at every hop,
 * agents exchange a typed BivelioHandoff. The serializer then encodes it in the
 * cheapest format for the destination tokenizer. This replaces free-form
 * conversation with a compact intermediate representation.
 */
import {
  createHandoff,
  FormatSelector,
  TokenizerRegistry,
} from "../../src/index.js";

const handoff = createHandoff({
  task: "compare_offers",
  goal: "select_lowest_total_cost",
  rules: ["currency=EUR", "include_shipping"],
  facts: [
    { id: "a", value: { price: 99, shipping: 8 } },
    { id: "b", value: { price: 103, shipping: 0 } },
  ],
  refs: ["offer:a", "offer:b"],
  outputContract: "offer-selection:v2",
});

const selector = new FormatSelector({ tokenizer: new TokenizerRegistry() });
const choice = selector.choose(handoff, { model: "openai/gpt-4o-mini" });

console.log("Typed handoff (what agent B receives instead of prose):");
console.log(JSON.stringify(handoff, null, 2));
console.log("\nWire format chosen:", choice.chosen, "-", choice.reason);
console.log("candidate tokens:", choice.candidateTokens);
