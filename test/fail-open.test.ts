import { describe, it, expect } from "vitest";
import { createSavingsLayer, createMockProvider } from "../src/index.js";
import type { ExactCache } from "../src/index.js";

/** An exact cache whose read throws — stands in for ANY internal optimizer bug. */
const explodingCache: ExactCache = {
  get() {
    throw new Error("boom: internal optimizer failure");
  },
  async set() {},
  async delete() {},
};

describe("SDK reliability contract — fail open to the raw provider", () => {
  it("never lets an internal error reach the caller; serves a direct provider answer", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "the real answer" }),
      exactCache: explodingCache,
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.text).toBe("the real answer");
    // A direct call ran; no optimization → zero claimed savings.
    expect(res.report.calls.actualLlm).toBe(1);
    expect(res.report.cost.netSavings).toBe(0);
    // The degradation is observable in the trace.
    expect(res.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
  });

  it("still enforces the output contract on the fallback path", async () => {
    const schema = { type: "object" as const, required: ["answer"], properties: { answer: { type: "string" as const } } };
    const layer = createSavingsLayer({
      provider: createMockProvider(),
      exactCache: explodingCache,
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      response: { contractId: "answer:v1", schema, maxOutputTokens: 50 },
    });
    expect(res.report.constraints.structurallyValid).toBe(true);
    expect((res.data as { answer?: string }).answer).toBeDefined();
  });

  it("with failOpen:false, internal errors surface (for tests/benchmarks)", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider(),
      exactCache: explodingCache,
      failOpen: false,
    });
    await expect(
      layer.generate({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/boom/);
  });

  it("a genuine provider failure still propagates (not masked by fail-open)", async () => {
    const layer = createSavingsLayer({
      provider: {
        id: "broken",
        async generate() {
          throw new Error("provider 503: upstream down");
        },
      },
    });
    await expect(
      layer.generate({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/provider 503/);
  });
});
