import { describe, expect, it } from "vitest";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider } from "../src/providers/types.js";

const provider: Provider = {
  id: "stub-provider-span",
  generate: async () => ({
    text: "OK",
    usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, complete: true },
    finishReason: "stop",
  }),
};

describe("provider span in SavingsReport traces", () => {
  it("matches the reported provider time without including preparation or postprocessing", async () => {
    let reloj = 0;
    const layer = createSavingsLayer({
      provider,
      devUnlicensed: true,
      exactTokenizer: false,
      silenceWarnings: true,
      now: () => ++reloj,
    });
    try {
      const resultado = await layer.generate({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Explain a short caching rule." }],
      });
      const span = resultado.report.traces.filter((t) => t.stage === "provider");
      expect(span.map((t) => t.outcome)).toEqual(["start", "done"]);
      expect(Math.abs(span[1]!.atMs - span[0]!.atMs - resultado.report.latencyMs.provider)).toBeLessThanOrEqual(1);
      expect(span[1]!.detail?.["providerMs"]).toBe(resultado.report.latencyMs.provider);
    } finally {
      await layer.close();
    }
  });
});
