/**
 * Basic BV-SALA example. Run: pnpm example:basic
 *
 * Shows the cheapest-first cascade: a deterministic resolver answers with zero
 * LLM calls; a repeated request is served from the exact cache; and a novel
 * request makes exactly one primary call. Each result carries a SavingsReport.
 */
import { createSavingsLayer, createMockProvider } from "../../src/index.js";

const layer = createSavingsLayer({
  provider: createMockProvider({ answer: "Paris is the capital of France." }),
});

function summarize(label: string, report: import("../../src/index.js").SavingsReport) {
  console.log(
    `\n[${label}] cache=${report.cache.result} llm=${report.calls.actualLlm} ` +
      `avoided=${report.calls.avoidedLlm} in=${report.tokens.actualInput} ` +
      `out=${report.tokens.actualOutput} eliminated=${report.tokens.eliminatedInput} ` +
      `netSavings=${(report.cost.netSavingsRatio * 100).toFixed(0)}%`,
  );
}

// 1) Computable locally -> zero LLM calls.
const math = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
});
console.log("answer:", math.text);
summarize("resolver", math.report);

// 2) A real question -> one call.
const q = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
};
const first = await layer.generate(q);
summarize("first (miss)", first.report);

// 3) The same question again -> exact cache, no call.
const second = await layer.generate(q);
summarize("second (exact)", second.report);
