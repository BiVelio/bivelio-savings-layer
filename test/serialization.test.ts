import { describe, it, expect } from "vitest";
import {
  encodeCompactRows,
  decodeCompactRows,
  csvSerializer,
  FormatSelector,
  TokenizerRegistry,
  uniformColumns,
} from "../src/index.js";

describe("the compact encoder encoder", () => {
  it("emits a tabular header once for a uniform array of flat objects", () => {
    const data = {
      users: [
        { id: 1, name: "Alice", role: "admin" },
        { id: 2, name: "Bob", role: "user" },
      ],
    };
    const filas = encodeCompactRows(data);
    expect(filas).toContain("users[2]{id,name,role}:");
    expect(filas).toContain("1,Alice,admin");
    expect(filas).toContain("2,Bob,user");
  });

  it("quotes values containing the delimiter", () => {
    const filas = encodeCompactRows({ rows: [{ a: "x,y", b: "z" }] });
    expect(filas).toContain('"x,y"');
  });

  it("round-trips flat objects, nested objects and inline arrays", () => {
    const value = {
      title: "hello world",
      count: 42,
      active: true,
      tags: ["a", "b", "c"],
      meta: { author: "jane", version: 2 },
    };
    expect(decodeCompactRows(encodeCompactRows(value))).toEqual(value);
  });

  it("round-trips a tabular array", () => {
    const value = {
      items: [
        { sku: "A1", qty: 3, price: 9.5 },
        { sku: "B2", qty: 1, price: 12 },
      ],
    };
    expect(decodeCompactRows(encodeCompactRows(value))).toEqual(value);
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

  it("selects the compact encoder for a large flat top-level table; CSV is gated out as lossy", () => {
    const selector = new FormatSelector({ tokenizer });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
      active: i % 3 === 0,
    }));
    const choice = selector.choose(rows, { model: "m" });
    // CSV would encode id/active as bare strings (1 vs "1", true vs "true") and has
    // no faithful decoder, so the round-trip fidelity gate rejects it and it is never
    // even offered. the compact encoder round-trips this typed table exactly and wins over JSON.
    expect(choice.chosen).toBe("compact-rows");
    expect(choice.candidateTokens.csv).toBeUndefined();
    expect(choice.candidateTokens["compact-rows"]!).toBeLessThan(choice.candidateTokens["json-compact"]!);
  });

  it("selects the compact encoder over JSON for a nested table CSV cannot represent", () => {
    const selector = new FormatSelector({ tokenizer });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
    }));
    // Wrapping in an object makes CSV inapplicable (not a top-level array).
    const choice = selector.choose({ users: rows }, { model: "m" });
    expect(choice.chosen).toBe("compact-rows");
    expect(choice.candidateTokens["compact-rows"]!).toBeLessThan(choice.candidateTokens["json-compact"]!);
  });

  it("falls back to JSON when the cheaper encoding would be lossy (embedded newlines)", () => {
    const selector = new FormatSelector({ tokenizer });
    // the compact encoder is line-based, so a cell containing a newline cannot round-trip; the
    // fidelity gate must reject it (and CSV) and keep lossless JSON — even though a
    // naive token count would have preferred the cheaper, corrupt encoding.
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, note: `first line ${i}\nsecond line ${i}` }));
    const choice = selector.choose({ rows }, { model: "m" });
    expect(choice.chosen).toBe("json-compact");
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
