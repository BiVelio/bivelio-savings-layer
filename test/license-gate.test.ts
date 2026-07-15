import { describe, it, expect } from "vitest";
import {
  createSavingsLayer,
  createMockProvider,
  InMemorySemanticCache,
  type LicenseGate,
  type SavingsRequest,
} from "../src/index.js";

/**
 * The SDK only sees a structural LicenseGate; it never imports the license
 * package. These tests use plain stub gates to prove the pipeline gates managed
 * features by entitlement and degrades gracefully when unlicensed.
 */
const embed = (t: string) =>
  Array.from({ length: 4 }, (_, i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

function layerWithGate(gate: LicenseGate | undefined) {
  const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
  return createSavingsLayer({
    provider: createMockProvider({ answer: "answer" }),
    semanticCache,
    ...(gate ? { licenseGate: gate } : {}),
    generateId: (() => { let n = 0; return () => `r${n++}`; })(),
  });
}

const req: SavingsRequest = {
  model: "m",
  messages: [{ role: "user", content: "a neutral public factual question about geography" }],
  savings: { semanticCache: "safe-only" },
  context: { tenantId: "t1", knowledgeEpoch: "e1" },
};

describe("license gating of managed features", () => {
  it("degrades semantic cache when the gate denies the feature", async () => {
    const gate: LicenseGate = { isEntitled: () => false };
    const layer = layerWithGate(gate);
    const first = await layer.generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(true);
  });

  it("allows semantic cache when the gate grants the feature", async () => {
    const gate: LicenseGate = { isEntitled: (f) => f === "semantic_cache" };
    const layer = layerWithGate(gate);
    const first = await layer.generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    // stored on miss; the degrade trace must NOT appear
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(false);
    expect(traces.some((t) => t.startsWith("semantic-cache"))).toBe(true);
  });

  it("is ungated (all features available) when no gate is configured", async () => {
    const layer = layerWithGate(undefined);
    const first = await layer.generate(req);
    const traces = first.report.traces.map((t) => `${t.stage}:${t.outcome}`);
    expect(traces.some((t) => t.startsWith("semantic-cache:degraded"))).toBe(false);
  });
});
