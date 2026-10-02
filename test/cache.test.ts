import { describe, it, expect } from "vitest";
import {
  InMemoryExactCache,
  Singleflight,
  InMemorySemanticCache,
} from "../src/index.js";
import { cosine } from "../src/cache/index.js";
import { canonicalize } from "../src/canonicalization/index.js";
import { keyTokensMatch } from "../src/cache/semantic.js";
import type {
  SavingsRequest,
} from "../src/index.js";

describe("InMemoryExactCache", () => {
  it("stores and retrieves; honors TTL", async () => {
    let now = 1000;
    const cache = new InMemoryExactCache({ now: () => now });
    await cache.set("k", { text: "v", storedAtMs: now }, 100);
    expect((await cache.get("k"))?.text).toBe("v");
    now = 1101;
    expect(await cache.get("k")).toBeNull();
  });

  it("evicts oldest beyond maxEntries", async () => {
    const cache = new InMemoryExactCache({ maxEntries: 2 });
    await cache.set("a", { text: "a", storedAtMs: 0 });
    await cache.set("b", { text: "b", storedAtMs: 0 });
    await cache.set("c", { text: "c", storedAtMs: 0 });
    expect(await cache.get("a")).toBeNull();
    expect((await cache.get("c"))?.text).toBe("c");
  });
});

describe("Singleflight", () => {
  it("coalesces concurrent calls onto a single execution", async () => {
    const sf = new Singleflight();
    let executions = 0;
    const fn = async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 10));
      return "result";
    };
    const results = await Promise.all([
      sf.run("k", fn),
      sf.run("k", fn),
      sf.run("k", fn),
    ]);
    expect(executions).toBe(1);
    expect(results.filter((r) => r.coalesced).length).toBe(2);
    expect(results.every((r) => r.value === "result")).toBe(true);
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});

describe("InMemorySemanticCache — safety filters", () => {
  const embed = (t: string) =>
    // toy embedding: char-code histogram over a few buckets
    Array.from({ length: 8 }, (_, i) =>
      [...t].filter((c) => c.charCodeAt(0) % 8 === i).length,
    );

  function canon(text: string, tenantId: string): ReturnType<typeof canonicalize> {
    const request: SavingsRequest = { model: "m", messages: [{ role: "user", content: text }], context: { tenantId } };
    return canonicalize(request);
  }

  it("never returns a hit from another tenant", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0, acceptThreshold: 0 });
    await cache.store(canon("capital of france", "t1"), { text: "Paris", storedAtMs: 0 });
    const hit = await cache.find(canon("capital of france", "t2"));
    expect(hit).toBeNull();
  });

  it("returns a verified hit within the same tenant", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    await cache.store(canon("capital of france", "t1"), { text: "Paris", storedAtMs: 0 });
    const hit = await cache.find(canon("capital of france", "t1"));
    expect(hit?.record.answer.text).toBe("Paris");
  });

  it("invalidates an entire knowledge epoch", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0, acceptThreshold: 0 });
    const request: SavingsRequest = { model: "m", messages: [{ role: "user", content: "x" }], context: { tenantId: "t", knowledgeEpoch: "e1" } };
    await cache.store(canonicalize(request), { text: "v", storedAtMs: 0 });
    expect(cache.invalidateEpoch("e1")).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("rejects a high-similarity but factually-different query (precision guard)", async () => {
    // similarityThreshold 0 ⇒ the embedding never blocks; only the key-token guard can.
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0, acceptThreshold: 0 });
    await cache.store(canon("convert 100 usd to eur", "t1"), { text: "≈92 EUR", storedAtMs: 0 });
    // Swapped number ⇒ must NOT serve the 100-USD answer for a 200-USD question.
    expect(await cache.find(canon("convert 200 usd to eur", "t1"))).toBeNull();
    // The identical question still hits.
    expect((await cache.find(canon("convert 100 usd to eur", "t1")))?.record.answer.text).toBe("≈92 EUR");
  });
});

describe("keyTokensMatch — semantic-cache precision guard", () => {
  it("accepts true paraphrases", () => {
    expect(keyTokensMatch("capital of france", "capital of france")).toBe(true);
    expect(keyTokensMatch("capital of france", "france capital")).toBe(true);
  });
  it("rejects swapped numbers and dates", () => {
    expect(keyTokensMatch("convert 100 usd to eur", "convert 200 usd to eur")).toBe(false);
    expect(keyTokensMatch("weather in paris on july 20", "weather in paris on july 21")).toBe(false);
  });
  it("rejects a negation flip", () => {
    expect(keyTokensMatch("is aspirin safe in pregnancy", "is aspirin not safe in pregnancy")).toBe(false);
  });
  it("rejects a one-token entity swap", () => {
    expect(keyTokensMatch("capital of north dakota", "capital of south dakota")).toBe(false);
  });
});

describe("InMemoryExactCache — sirve copias, no referencias", () => {
  it("mutar lo que devuelve `get` no cambia la entrada para la siguiente lectura", async () => {
    const cache = new InMemoryExactCache();
    await cache.set("k", { text: "hola", data: { n: 1 } } as never);
    const primera = (await cache.get("k")) as unknown as { text: string; data: { n: number } };
    primera.text = "adiós";
    primera.data.n = 99;
    const segunda = (await cache.get("k")) as unknown as { text: string; data: { n: number } };
    expect(segunda.text).toBe("hola");
    expect(segunda.data.n).toBe(1);
  });
  it("mutar el objeto DESPUÉS de `set` tampoco cambia lo que la caché sirve", async () => {
    const cache = new InMemoryExactCache();
    const original = { text: "hola", data: { n: 1 } };
    await cache.set("k", original as never);
    original.text = "adiós";
    expect(((await cache.get("k")) as unknown as { text: string }).text).toBe("hola");
  });
});

describe("cosine — dimensiones distintas", () => {
  it("dos embebedores distintos no se comparan: similitud 0, nunca un acierto falso por truncado", () => {
    // Truncando al más corto, [1,0,0,0] contra [1,0] daba 1: idénticos.
    expect(cosine([1, 0, 0, 0], [1, 0])).toBe(0);
    expect(cosine([0.3, 0.4], [0.3, 0.4, 0.5])).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
});
