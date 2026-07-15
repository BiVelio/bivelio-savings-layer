import { describe, it, expect } from "vitest";
import { canonicalize, evaluatePolicy } from "../src/index.js";
import type { SavingsRequest } from "../src/index.js";

function policyFor(overrides: Partial<SavingsRequest>) {
  const request: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
  return evaluatePolicy(canonicalize(request));
}

describe("policy engine", () => {
  it("blocks semantic cache for freshness-sensitive queries", () => {
    const p = policyFor({ messages: [{ role: "user", content: "what is the price of BTC right now?" }] });
    expect(p.requiresFreshData).toBe(true);
    expect(p.allowSemanticCache).toBe(false);
  });

  it("blocks semantic cache and singleflight when write tools are present", () => {
    const p = policyFor({
      messages: [{ role: "user", content: "please proceed" }],
      tools: [{ id: "pay", intents: ["pay"], risk: "write" }],
    });
    expect(p.hasSideEffects).toBe(true);
    expect(p.allowSemanticCache).toBe(false);
    expect(p.allowSingleflight).toBe(false);
  });

  it("blocks semantic cache for personalized/account-scoped queries", () => {
    const p = policyFor({
      messages: [{ role: "user", content: "what is my account balance?" }],
      context: { tenantId: "user-1" },
    });
    expect(p.isPersonalized).toBe(true);
    expect(p.allowSemanticCache).toBe(false);
  });

  it("disables exact cache for deliberately stochastic outputs", () => {
    const p = policyFor({ temperature: 0.9 });
    expect(p.allowExactCache).toBe(false);
  });

  it("allows caching for a neutral read-only public query", () => {
    const p = policyFor({ messages: [{ role: "user", content: "define photosynthesis" }] });
    expect(p.allowExactCache).toBe(true);
    expect(p.allowSemanticCache).toBe(true);
  });
});
