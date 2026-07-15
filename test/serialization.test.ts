import { describe, it, expect } from "vitest";
import {
  encodeToon,
  decodeToon,
  csvSerializer,
  FormatSelector,
  TokenizerRegistry,
  uniformColumns,
} from "../src/index.js";

describe("TOON encoder", () => {
  it("emits a tabular header once for a uniform array of flat objects", () => {
    const data = {
      users: [
        { id: 1, name: "Alice", role: "admin" },
        { id: 2, name: "Bob", role: "user" },
      ],
    };
    const toon = encodeToon(data);
    expect(toon).toContain("users[2]{id,name,role}:");
    expect(toon).toContain("1,Alice,admin");
    expect(toon).toContain("2,Bob,user");
  });

  it("quotes values containing the delimiter", () => {
    const toon = encodeToon({ rows: [{ a: "x,y", b: "z" }] });
    expect(toon).toContain('"x,y"');
  });

  it("round-trips flat objects, nested objects and inline arrays", () => {
    const value = {
      title: "hello world",
      count: 42,
      active: true,
      tags: ["a", "b", "c"],
      meta: { author: "jane", version: 2 },
    };
    expect(decodeToon(encodeToon(value))).toEqual(value);
  });

  it("round-trips a tabular array", () => {
    const value = {
      items: [
        { sku: "A1", qty: 3, price: 9.5 },
        { sku: "B2", qty: 1, price: 12 },
      ],
    };
    expect(decodeToon(encodeToon(value))).toEqual(value);
  });

  it("detects non-uniform arrays as non-tabular", () => {
    expect(uniformColumns([{ a: 1 }, { a: 1, b: 2 }])).toBeNull();
    expect(uniformColumns([{ a: { nested: 1 } }])).toBeNull();
  });
});

describe("CSV serializer", () => {
  it("supports only uniform tabular arrays", () => {
    expect(csvSerializer.supports([{ a: 1 }, { a: 2 }])).toBe(true);
    expect(csvSerializer.supports({ a: 1 })).toBe(false);
    expect(csvSerializer.supports([{ a: 1 }, { b: 2 }])).toBe(false);
  });

  it("encodes header + rows", () => {
    const csv = csvSerializer.encode([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
    expect(csv).toBe("id,name\n1,Alice\n2,Bob");
  });
});

describe("FormatSelector", () => {
  const tokenizer = new TokenizerRegistry();

  it("keeps JSON for tiny payloads (thresholds not met)", () => {
    const selector = new FormatSelector({ tokenizer });
    const choice = selector.choose({ a: 1 }, { model: "m" });
    expect(choice.chosen).toBe("json-compact");
  });

  it("selects CSV for a large flat top-level table (smallest for pure tables)", () => {
    const selector = new FormatSelector({ tokenizer });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
      active: i % 3 === 0,
    }));
    const choice = selector.choose(rows, { model: "m" });
    expect(choice.chosen).toBe("csv");
    expect(choice.candidateTokens.csv!).toBeLessThan(choice.candidateTokens["json-compact"]!);
  });

  it("selects TOON over JSON for a nested table CSV cannot represent", () => {
    const selector = new FormatSelector({ tokenizer });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
    }));
    // Wrapping in an object makes CSV inapplicable (not a top-level array).
    const choice = selector.choose({ users: rows }, { model: "m" });
    expect(choice.chosen).toBe("toon");
    expect(choice.candidateTokens.toon!).toBeLessThan(choice.candidateTokens["json-compact"]!);
  });

  it("never lets a chosen format exceed JSON tokens", () => {
    const selector = new FormatSelector({ tokenizer });
    const nested = { deeply: { nested: { value: [1, 2, { x: { y: 1 } }] } } };
    const choice = selector.choose(nested, { model: "m" });
    const jsonTokens = choice.candidateTokens["json-compact"]!;
    const chosenTokens = choice.candidateTokens[choice.chosen]!;
    expect(chosenTokens).toBeLessThanOrEqual(jsonTokens);
  });
});
