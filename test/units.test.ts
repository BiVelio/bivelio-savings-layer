import { describe, it, expect } from "vitest";
import {
  validateAgainstSchema,
  SchemaRegistry,
  emptyState,
  mergeDelta,
  createDefaultResolvers,
  type JsonSchema,
  type Compressor,
} from "../src/index.js";
import { projectContext } from "../src/memory/index.js";
import { withProtectedSpans, shouldCompress } from "../src/compression/index.js";
import { dedupe, adaptiveK } from "../src/retrieval/index.js";
import { evalArithmetic } from "../src/resolvers/index.js";
import { canonicalize } from "../src/canonicalization/index.js";

describe("schema validation", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["answer", "refs"],
    properties: {
      answer: { type: "string", maxLength: 10 },
      refs: { type: "array", maxItems: 2, items: { type: "string" } },
    },
  };

  it("accepts a valid object", () => {
    expect(validateAgainstSchema({ answer: "ok", refs: ["a"] }, schema).valid).toBe(true);
  });

  it("rejects missing required, extra props, and length/items violations", () => {
    expect(validateAgainstSchema({ refs: [] }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ answer: "ok", refs: [], extra: 1 }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ answer: "way too long here", refs: [] }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ answer: "ok", refs: ["a", "b", "c"] }, schema).valid).toBe(false);
  });

  it("lints unbounded schemas for output-token hygiene", () => {
    const warnings = SchemaRegistry.lint({
      type: "object",
      properties: { note: { type: "string" }, items: { type: "array", items: { type: "string" } } },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("memory deltas", () => {
  it("applies set/append/remove deterministically", () => {
    let state = emptyState();
    state = mergeDelta(state, { set: { plan: "pro" }, append: { goals: ["ship"] } });
    expect(state.confirmedFacts.plan).toBe("pro");
    expect(state.goals).toEqual(["ship"]);
    state = mergeDelta(state, { remove: ["plan"] });
    expect(state.confirmedFacts.plan).toBeUndefined();
  });

  it("projects only compact state + recent turns + current message", () => {
    const state = mergeDelta(emptyState(), { append: { goals: ["reduce cost"] } });
    const history = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` }));
    const projected = projectContext({ state, history, current: { role: "user", content: "now" }, rawTurns: 2 });
    // system state + 2 recent + current
    expect(projected.length).toBe(4);
    expect(projected[projected.length - 1]?.content).toBe("now");
  });
});

describe("compression protected spans", () => {
  const dropEverything: Compressor = {
    async compress(_req) {
      return {
        compressed: "",
        originalTokens: 100,
        compressedTokens: 0,
        protectedSpans: 0,
        fidelityPassed: true,
        skipped: false,
        reason: "aggressive",
      };
    },
  };

  it("falls back to original when a protected span is lost", async () => {
    const guarded = withProtectedSpans(dropEverything);
    const result = await guarded.compress({
      text: "the total is 1.234,56 EUR and must not change",
      protectedSpans: [{ id: "total", text: "1.234,56 EUR" }],
    });
    expect(result.fidelityPassed).toBe(false);
    expect(result.compressed).toContain("1.234,56 EUR");
  });

  it("net-positive activation gate", () => {
    expect(shouldCompress({ contextTokens: 500, projectedEliminable: 400, compressorCostTokens: 50 }).compress).toBe(false);
    expect(shouldCompress({ contextTokens: 4000, projectedEliminable: 1500, compressorCostTokens: 200 }).compress).toBe(true);
  });
});

describe("retrieval pruning", () => {
  it("dedupes identical documents", () => {
    const docs = dedupe([
      { id: "1", text: "hello world" },
      { id: "2", text: "hello   world" },
      { id: "3", text: "different" },
    ]);
    expect(docs.length).toBe(2);
  });

  it("adaptiveK keeps fewer docs when the top dominates", () => {
    const kept = adaptiveK(
      [
        { id: "a", text: "x", score: 1.0 },
        { id: "b", text: "y", score: 0.2 },
        { id: "c", text: "z", score: 0.1 },
      ],
      { maxDocuments: 5 },
    );
    expect(kept.length).toBe(1);
  });
});

describe("deterministic resolvers", () => {
  it("evaluates arithmetic with precedence and parentheses", () => {
    expect(evalArithmetic("2 + 2 * 3")).toBe(8);
    expect(evalArithmetic("(2 + 2) * 3")).toBe(12);
    expect(evalArithmetic("10 / 0")).toBeNull();
    expect(evalArithmetic("2 ** 3")).toBeNull();
  });

  it("answers a math question without an LLM call", () => {
    const resolvers = createDefaultResolvers();
    const c = canonicalize({ model: "m", messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    expect(resolvers.try(c)?.text).toBe("8");
  });
});
