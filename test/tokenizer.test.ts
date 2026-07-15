import { describe, it, expect } from "vitest";
import {
  HeuristicEstimator,
  TokenizerRegistry,
  SavingsLedger,
} from "../src/index.js";

describe("HeuristicEstimator", () => {
  const est = new HeuristicEstimator();

  it("returns 0 for empty string", () => {
    expect(est.count("")).toBe(0);
  });

  it("grows monotonically with length", () => {
    const short = est.count("hello");
    const long = est.count("hello world this is a longer sentence");
    expect(long).toBeGreaterThan(short);
  });

  it("counts a compact JSON payload higher than a tabular encoding", () => {
    const json = JSON.stringify([
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
    ]);
    const toon = "users[2]{id,name,role}:\n  1,Alice,admin\n  2,Bob,user";
    expect(est.count(json)).toBeGreaterThan(est.count(toon));
  });
});

describe("TokenizerRegistry", () => {
  it("resolves by model mapping, then falls back", () => {
    const registry = new TokenizerRegistry();
    registry
      .register(new HeuristicEstimator("o200k_base"))
      .mapModel("openai/gpt-4o-mini", "o200k_base");

    expect(registry.resolve({ model: "openai/gpt-4o-mini" }).id).toBe("o200k_base");
    expect(registry.resolve({ model: "unknown/model" }).id).toBe("heuristic");
    expect(registry.resolve({ tokenizer: "o200k_base" }).id).toBe("o200k_base");
  });
});

describe("SavingsLedger — four separate accounts", () => {
  it("keeps eliminated, compressed and provider-cached tokens distinct", () => {
    const ledger = new SavingsLedger();
    ledger.eliminate(100);
    ledger.compress(200, 120); // saves 80
    ledger.providerCached(50);

    expect(ledger.eliminatedInput).toBe(100);
    expect(ledger.compressedInput).toBe(80);
    expect(ledger.providerCachedInput).toBe(50);
  });

  it("avoiding a call eliminates the whole input and output", () => {
    const ledger = new SavingsLedger();
    ledger.avoidCall(500, 200);
    expect(ledger.avoidedLlm).toBe(1);
    expect(ledger.actualLlm).toBe(0);
    expect(ledger.eliminatedInput).toBe(500);
    expect(ledger.eliminatedOutput).toBe(200);
  });

  it("prices provider-cached input at the discounted rate", () => {
    const ledger = new SavingsLedger();
    ledger.baselineInput = 1000;
    ledger.baselineOutput = 200;
    ledger.actualInput = 1000;
    ledger.actualOutput = 200;
    ledger.providerCached(800);

    const cost = ledger.estimateCost({
      inputPer1k: 1,
      outputPer1k: 2,
      cachedInputPer1k: 0.1,
    });
    // billed input = 200 @1 + 800 @0.1 = 0.2 + 0.08; output 200 @2 = 0.4
    expect(cost.actual).toBeCloseTo(0.68, 5);
  });
});
