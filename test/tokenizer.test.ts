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

  it("una llamada evitada va SOLO al libro 1, no también al 2", () => {
    // El README promete que los cuatro libros son disjuntos: "summing them would
    // lie to you, so the report never does". avoidCall sumaba el prompt entero a
    // eliminatedInput ADEMÁS de contar la llamada evitada, así que el mismo
    // ahorro aparecía en dos libros — y el panel los enseña en fila, de modo que
    // quien los lea los suma con la vista. Este test antes afirmaba el bug.
    const ledger = new SavingsLedger();
    ledger.avoidCall(500, 200);
    expect(ledger.avoidedLlm).toBe(1);
    expect(ledger.actualLlm).toBe(0);
    expect(ledger.baselineInput).toBe(500);   // el ahorro vive AQUÍ
    expect(ledger.eliminatedInput).toBe(0);   // y no se duplica aquí
    expect(ledger.eliminatedOutput).toBe(0);
  });

  it("el libro 2 sigue registrando las eliminaciones de verdad", () => {
    // No se ha desactivado el libro: una poda real de contexto sigue contando.
    const ledger = new SavingsLedger();
    ledger.eliminate(320);
    expect(ledger.eliminatedInput).toBe(320);
  });

  it("does not credit phantom output savings on a call that actually ran", () => {
    // Ran call: output was capped at 200 but the model still generated 50 real
    // tokens. The layer did not shrink generation, so no output saving is honest.
    const ledger = new SavingsLedger();
    ledger.baselineInput = 100;
    ledger.baselineOutput = 200; // the maxOutputTokens ceiling — NOT a measured baseline
    ledger.actualInput = 100;
    ledger.actualOutput = 50;
    // avoidedLlm stays 0 → this is a ran call.
    const cost = ledger.estimateCost({ inputPer1k: 1, outputPer1k: 10 });
    // baseline output must equal actual output (50), not the 200 ceiling:
    // baseline = 100@1 + 50@10 = 0.6 ; actual = 100@1 + 50@10 = 0.6 → 0% output saving.
    expect(cost.baselineEstimate).toBeCloseTo(0.6, 6);
    expect(cost.netSavings).toBeCloseTo(0, 6);
  });

  it("still credits the whole generation as saved on an AVOIDED call", () => {
    const ledger = new SavingsLedger();
    ledger.avoidCall(500, 200); // cache/resolver hit: nothing ran
    ledger.baselineInput = 500;
    const cost = ledger.estimateCost({ inputPer1k: 1, outputPer1k: 10 });
    // baseline = 500@1 + 200@10 = 2.5 ; actual = 0 → 100% saved.
    expect(cost.baselineEstimate).toBeCloseTo(2.5, 6);
    expect(cost.actual).toBeCloseTo(0, 6);
    expect(cost.netSavings).toBeCloseTo(1, 6);
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
