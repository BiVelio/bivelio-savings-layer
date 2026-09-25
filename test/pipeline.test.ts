import { describe, it, expect } from "vitest";
import {
  createSavingsLayer,
  createMockProvider,
  InMemorySemanticCache,
  type JsonSchema,
  type SavingsRequest,
} from "../src/index.js";

let counter = 0;
const deterministicId = () => `req-${counter++}`;

describe("SavingsPipeline end-to-end", () => {
  it("answers arithmetic via a deterministic resolver — zero LLM calls", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider(), generateId: deterministicId });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
    });
    expect(res.text).toBe("8");
    expect(res.report.calls.actualLlm).toBe(0);
    expect(res.report.calls.avoidedLlm).toBe(1);
    expect(res.report.cache.result).toBe("deterministic");
  });

  it("serves a repeated request from the exact cache", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "Paris" }),
      generateId: deterministicId,
    });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital of france" }],
    };
    const first = await layer.generate(request);
    expect(first.report.cache.result).toBe("miss");
    expect(first.report.calls.actualLlm).toBe(1);

    const second = await layer.generate(request);
    expect(second.report.cache.result).toBe("exact");
    expect(second.report.calls.actualLlm).toBe(0);
    expect(second.report.calls.avoidedLlm).toBe(1);
    expect(second.text).toBe("Paris");
  });

  it("coalesces concurrent identical requests via singleflight", async () => {
    let providerCalls = 0;
    const provider = {
      id: "counting",
      async generate() {
        providerCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { text: "shared", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const layer = createSavingsLayer({ provider, generateId: deterministicId });
    const request: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "expensive unique question xyz" }],
    };
    const [a, b, c] = await Promise.all([
      layer.generate(request),
      layer.generate(request),
      layer.generate(request),
    ]);
    expect(providerCalls).toBe(1);
    const outcomes = [a, b, c].map((r) => r.report.cache.result).sort();
    expect(outcomes.filter((o) => o === "singleflight").length).toBe(2);
  });

  it("produces a schema-valid structured output and marks it valid", async () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "refs"],
      properties: {
        answer: { type: "string", maxLength: 600 },
        refs: { type: "array", maxItems: 5, items: { type: "string", maxLength: 32 } },
      },
    };
    const layer = createSavingsLayer({ provider: createMockProvider(), generateId: deterministicId });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "research question about widgets" }],
      response: { contractId: "research-answer:v3", schema, maxOutputTokens: 220 },
    });
    expect(res.report.constraints.structurallyValid).toBe(true);
    expect(typeof (res.data as { answer: string }).answer).toBe("string");
  });

  it("records compression ledger when a large table is serialized as the compact encoder", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }), generateId: deterministicId });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
    }));
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "summarize the attached table" }],
      structuredData: { users: rows },
    });
    expect(res.report.serialization.chosen).toBe("compact-rows");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
  });

  it("sends structured data as JSON when the format selector is disabled (never drops it)", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }), generateId: deterministicId });
    const rows = { users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `u${i}` })) };
    const withData = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "analyze payload alpha" }],
      structuredData: rows,
      savings: { serialization: false },
    });
    const withoutData = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "analyze payload beta" }],
      savings: { serialization: false },
    });
    // Payload was sent (not dropped) → more input tokens than the no-data request.
    expect(withData.report.tokens.actualInput).toBeGreaterThan(withoutData.report.tokens.actualInput);
    expect(withData.report.serialization.chosen).toBe("json-compact");
    expect(withData.report.tokens.compressedInput).toBe(0); // no compression when disabled
  });

  it("keeps the four ledgers separate in the report", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "hi", cachedInputTokens: 30 }),
      generateId: deterministicId,
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "a neutral factual question about history" }],
    });
    expect(res.report.tokens).toHaveProperty("eliminatedInput");
    expect(res.report.tokens).toHaveProperty("compressedInput");
    expect(res.report.tokens.providerCachedInput).toBe(30);
  });

  it("does not use the exact cache for high-temperature stochastic requests", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "creative" }), generateId: deterministicId });
    const request: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "write a poem" }],
      temperature: 0.9,
    };
    await layer.generate(request);
    const second = await layer.generate(request);
    expect(second.report.cache.result).not.toBe("exact");
  });

  it("respects tenant isolation on the semantic cache", async () => {
    const embed = (t: string) => Array.from({ length: 4 }, (_, i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "tenant-1-answer" }),
      semanticCache,
      generateId: deterministicId,
    });
    const base: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "what is the standard refund window in days" }],
      savings: { semanticCache: "safe-only" },
      context: { tenantId: "t1", knowledgeEpoch: "e1" },
    };
    await layer.generate(base);
    const other = await layer.generate({ ...base, context: { tenantId: "t2", knowledgeEpoch: "e1" } });
    // Different tenant must not receive tenant-1's cached answer.
    expect(other.report.cache.result).not.toBe("semantic");
  });

  /** A provider with a fixed, real-looking counter: 9 in / 3 out on every call.
   *  The built-in mock is NOT one — its usage comes from a heuristic estimator,
   *  so it never leaves a reference (see the test below). */
  const fixedCounterProvider = () => ({
    id: "fixed-counter",
    async generate() {
      // Like OpenAI's counter, it states that no hidden reasoning was billed:
      // without that statement a repeat never credits output (rule v2).
      return { text: "Paris", usage: { inputTokens: 9, outputTokens: 3, reasoningTokens: 0 } };
    },
  });

  it("credits an avoided call's output baseline from the real answer, not the ceiling default", async () => {
    const layer = createSavingsLayer({ provider: fixedCounterProvider(), generateId: deterministicId });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital city output-baseline probe" }],
      temperature: 0,
    };
    const first = await layer.generate(request); // miss → populate cache
    const hit = await layer.generate(request);
    expect(hit.report.cache.result).toBe("exact");
    // Measured by reference: the counter of the identical call that ran.
    expect(hit.report.cost.basis).toBe("reference");
    // Old behavior credited the 256 (maxOutputTokens ?? 256) ceiling as saved output;
    // the honest baseline is the real answer's counter, never 256 — and, under
    // deterministic sampling, 95% of it.
    expect(hit.report.tokens.baselineOutput).toBe(Math.floor(0.95 * first.report.tokens.actualOutput));
    expect(hit.report.tokens.baselineOutput).toBeLessThan(20);
  });

  it("credits no output on a deterministic repeat when the counter did not state its reasoning tokens", async () => {
    const layer = createSavingsLayer({
      provider: {
        id: "silent-reasoning",
        async generate() {
          return { text: "Paris", usage: { inputTokens: 9, outputTokens: 3 } };
        },
      },
      generateId: deterministicId,
    });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital city output-baseline probe, silent counter" }],
      temperature: 0,
    };
    await layer.generate(request);
    const hit = await layer.generate(request);
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.tokens.baselineInput).toBeGreaterThan(0);
    expect(hit.report.tokens.baselineOutput).toBe(0);
  });

  it("credits no output on a repeat without deterministic sampling", async () => {
    const layer = createSavingsLayer({ provider: fixedCounterProvider(), generateId: deterministicId });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital city output-baseline probe, sampled" }],
    };
    await layer.generate(request);
    const hit = await layer.generate(request);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.tokens.baselineOutput).toBe(0);
  });

  it("never values a repeat with the built-in mock's made-up counter", async () => {
    // The mock fabricates its usage with the heuristic estimator: there is no
    // provider bill behind it. A metered test suite or staging run on the mock
    // must not turn its repeats into commissionable "reference" savings.
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "Paris" }), generateId: deterministicId });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital city output-baseline probe, simulated" }],
      temperature: 0,
    };
    const first = await layer.generate(request);
    const ref = first.report.traces.find((t) => t.stage === "reference");
    expect(ref?.outcome).toBe("not-written");
    expect(ref?.detail).toEqual({ reason: "simulated-provider" });
    const hit = await layer.generate(request);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.reference).toBeUndefined();
    expect(hit.report.cache.referenceRejected).toBe("absent");
    // The avoided call still credits the real answer's output, as before this lane.
    expect(hit.report.tokens.baselineOutput).toBeLessThan(20);
  });

  it("actually applies compression to the outgoing prompt and credits only the realized reduction", async () => {
    let captured: { role: string; content: string }[] = [];
    const provider = {
      id: "capturing",
      async generate(req: { messages: { role: string; content: string }[] }) {
        captured = req.messages;
        return { text: "ok", usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };
    const compressor = {
      async compress(r: { text: string }) {
        return {
          compressed: r.text.split(" ").filter((w) => w !== "DROPME").join(" "),
          originalTokens: 0,
          compressedTokens: 0,
          protectedSpans: 0,
          fidelityPassed: true,
          skipped: false,
          reason: "test compressor",
        };
      },
    };
    const layer = createSavingsLayer({ provider, compressor, generateId: deterministicId });
    // El contexto es grande a propósito: la etapa 9 ya no comprime a ciegas, así
    // que un prompt de una línea no llega al mínimo de 2000 tokens y este test
    // pasaría sin comprimir nada. El relleno que sobrevive mantiene el prompt
    // comprimido por encima del tramo cacheable de 1024, que es la otra verja.
    const contenido =
      "please analyze this long context " +
      "DROPME ".repeat(300) +
      "padding ".repeat(1200);
    const res = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: contenido }],
      savings: { compression: true },
    });
    const sent = captured.map((m) => m.content).join("\n");
    // Regression for the phantom-compression bug: the compressed prompt must actually
    // reach the provider, and the ledger only credits what was truly removed.
    expect(sent).not.toContain("DROPME");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
  });

  it("reports constraints backend 'none' by default (honest validate+repair, not claimed native enforcement)", async () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", maxLength: 200 } },
    };
    const layer = createSavingsLayer({ provider: createMockProvider(), generateId: deterministicId });
    const res = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "structured question for backend honesty" }],
      response: { contractId: "honesty:v1", schema },
    });
    expect(res.report.constraints.backend).toBe("none");
  });

  it("injects the retrieved evidence into the prompt (RAG grounding — regression for the docs-discarded bug)", async () => {
    let captured: { role: string; content: string }[] = [];
    const provider = {
      id: "capturing",
      async generate(req: { messages: { role: string; content: string }[] }) {
        captured = req.messages;
        return { text: "Alexander Graham Bell", usage: { inputTokens: 30, outputTokens: 5 } };
      },
    };
    const retriever = {
      async retrieve() {
        return [
          {
            id: "doc-1",
            text: "PATENT-1876: Alexander Graham Bell was granted the telephone patent.",
            score: 0.9,
          },
        ];
      },
    };
    const layer = createSavingsLayer({ provider, retriever, generateId: deterministicId });
    await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "who invented the telephone?" }],
    });
    // The kept evidence must actually reach the model — not just the ledger/report.
    const promptText = captured.map((m) => m.content).join("\n");
    expect(promptText).toContain("PATENT-1876");
  });
});
