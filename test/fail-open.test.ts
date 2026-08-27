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

  it("does NOT re-invoke (double-charge) the provider when a post-provider cache write fails", async () => {
    let calls = 0;
    const countingProvider = {
      id: "counting",
      async generate() {
        calls += 1;
        return { text: `answer-${calls}`, usage: { inputTokens: 5, outputTokens: 3 } };
      },
    };
    // Cache miss on read, but the write blows up (backend down) AFTER the provider was billed.
    const flakyCache: ExactCache = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("cache backend down");
      },
      async delete() {},
    };
    const layer = createSavingsLayer({ provider: countingProvider, exactCache: flakyCache });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls).toBe(1); // billed exactly once — no fail-open double charge
    expect(res.text).toBe("answer-1");
    expect(res.report.traces.some((t) => t.stage === "cache-write")).toBe(true);
  });

  it("⛔ el fail-open NO pierde structuredData: el proveedor recibe el payload", async () => {
    // Caza del 27-08: failOpenDirect mandaba request.messages a secas, sin el
    // structuredData que el camino optimizado inserta. Durante una caída del
    // sidecar, el modelo contestaba SIN los datos (a ciegas), se cobraba
    // "measured" y no había señal. El proveedor espía comprueba que el payload
    // viaja de verdad.
    const vistos: string[] = [];
    const layer = createSavingsLayer({
      provider: {
        id: "espia",
        async generate(req) {
          vistos.push(...req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
          return { text: "ok", usage: { inputTokens: 10, outputTokens: 2 } };
        },
      },
      exactCache: explodingCache, // fuerza el fail-open (error interno pre-proveedor)
    });
    const tabla = { filas: [{ id: 42, nombre: "acme" }] };
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "resume la tabla" }],
      structuredData: tabla,
    });
    // El JSON del payload tiene que aparecer en ALGÚN mensaje que vio el proveedor.
    const todo = vistos.join("\n");
    expect(todo).toContain('"id":42');
    expect(todo).toContain("acme");
  });

  it("el fail-open sin structuredData no inventa un bloque de datos", async () => {
    const vistos: unknown[] = [];
    const layer = createSavingsLayer({
      provider: {
        id: "espia2",
        async generate(req) {
          vistos.push(req.messages);
          return { text: "ok", usage: { inputTokens: 5, outputTokens: 1 } };
        },
      },
      exactCache: explodingCache,
    });
    await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });
    // Un solo mensaje (el del usuario): no se añadió ningún bloque de datos.
    expect((vistos[0] as unknown[]).length).toBe(1);
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
