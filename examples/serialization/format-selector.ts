/**
 * Format-selector example. Run: pnpm example:serialization
 *
 * Demonstrates that TOON is a candidate, not a default: it wins on large uniform
 * tables but loses to compact JSON on small/nested payloads. Everything is
 * counted with the destination model's tokenizer.
 */
import {
  FormatSelector,
  TokenizerRegistry,
  encodeToon,
} from "../../src/index.js";

const selector = new FormatSelector({ tokenizer: new TokenizerRegistry() });

const bigTable = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    role: i % 2 ? "admin" : "user",
    active: i % 3 === 0,
  })),
};

const smallNested = { user: { id: 1, profile: { name: "Ana", prefs: { theme: "dark" } } } };

for (const [label, payload] of [
  ["big uniform table", bigTable],
  ["small nested object", smallNested],
] as const) {
  const choice = selector.choose(payload, { model: "openai/gpt-4o-mini" });
  console.log(`\n=== ${label} ===`);
  console.log("candidateTokens:", choice.candidateTokens);
  console.log("chosen:", choice.chosen, "->", choice.reason);
}

console.log("\n--- TOON preview (big table, first lines) ---");
console.log(encodeToon(bigTable).split("\n").slice(0, 4).join("\n"), "\n...");
