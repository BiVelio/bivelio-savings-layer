import { describe, expect, it } from "vitest";

import { leerJson, leerSse, costeFacturado } from "../benchmarks/publicados/xstest/nucleo.js";
import {
  correrTirada,
  esfuerzoNativoDe,
  esGeminiNativo,
  fetchDeMentira,
  MODELOS,
  prevuelo,
  type ConfigDeModelo,
} from "../benchmarks/publicados/xstest/banco.js";
import { construirInforme } from "../benchmarks/publicados/xstest/informe.js";
import type { PromptXSTest } from "../benchmarks/publicados/xstest/nucleo.js";

/**
 * XSTEST CON GEMINI POR SU API NATIVA (`generateContent`), sin red.
 *
 * Las respuestas tienen la forma EXACTA de la API: las de texto y SSE, las
 * grabadas en la sonda del 2026-09-29 contra gemini-3.8-flash (las mismas de
 * test/proveedor-google.test.ts); las negativas, la forma de la referencia
 * oficial (https://ai.google.dev/api/generate-content): `promptFeedback.blockReason`
 * sin candidatos, o `finishReason: SAFETY` sin partes.
 */

const TEXTO_CON_PENSAMIENTO = {
  candidates: [{ content: { parts: [{ text: "391", thoughtSignature: "Ev8BCvwBAWkUfROE" }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: {
    promptTokenCount: 16,
    candidatesTokenCount: 3,
    totalTokenCount: 92,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 16 }],
    thoughtsTokenCount: 73,
    serviceTier: "standard",
  },
  modelVersion: "gemini-3.8-flash",
  responseId: "I3i7ap6JG8zkxN8Pi8OhoAI",
};

const sse = (...trozos: unknown[]): string => trozos.map((t) => `data: ${JSON.stringify(t)}\r\n\r\n`).join("");

const CLAVE = "fake-key-que-no-debe-salir-0002";
const NATIVA = "https://generativelanguage.invalid/v1beta";
const endpoints = {
  anthropicBaseUrl: "https://anthropic.invalid/v1",
  openaiBaseUrl: "https://openai.invalid/v1",
  googleBaseUrl: NATIVA,
  googleApiKey: CLAVE,
};

describe("XSTest · lectura de la API nativa de Gemini", () => {
  it("el pensamiento es salida facturada, y el texto visible es solo el de las partes de texto", () => {
    const l = leerJson("google", 200, TEXTO_CON_PENSAMIENTO);
    expect(l).toMatchObject({ inputTokens: 16, outputTokens: 76, reasoningTokens: 73, stopReason: "STOP", negativaDelApi: false, texto: "391" });
    // 16 × 1 + 76 × 10 (por 1k): el pensamiento se cobra como salida.
    expect(costeFacturado("google", l, { inputPer1k: 1, outputPer1k: 10, cachedInputPer1k: 0.1 })).toBeCloseTo(0.016 + 0.76, 9);
  });

  it("negativas del API: `promptFeedback.blockReason` y `finishReason` de filtro", () => {
    const bloqueo = leerJson("google", 200, { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 } });
    expect(bloqueo).toMatchObject({ negativaDelApi: true, stopReason: "content_filter: SAFETY", promptFeedback: true, texto: "", outputTokens: 0 });
    for (const fr of ["SAFETY", "PROHIBITED_CONTENT", "OTHER", "BLOCKLIST"]) {
      const l = leerJson("google", 200, { candidates: [{ content: { role: "model" }, finishReason: fr, index: 0 }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } });
      expect(l.negativaDelApi).toBe(true);
      expect(l.stopReason).toBe(`content_filter: ${fr}`);
    }
    expect(leerJson("google", 200, { candidates: [{ content: { parts: [{ text: "x" }], role: "model" }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }))
      .toMatchObject({ negativaDelApi: false, stopReason: "MAX_TOKENS" });
    // Un error nativo sigue siendo un error (y no se cobra).
    expect(leerJson("google", 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "x" } }).error).toBe("HTTP 400: INVALID_ARGUMENT");
  });

  it("SSE de `streamGenerateContent`: el texto se suma y el uso es el del ÚLTIMO trozo", () => {
    const texto = sse(
      { candidates: [{ content: { parts: [{ text: "1, 2" }], role: "model" }, index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } },
      { candidates: [{ content: { parts: [{ text: ", 3, 4, 5" }], role: "model" }, index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 13, totalTokenCount: 25 } },
      { candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 13, totalTokenCount: 30, thoughtsTokenCount: 5 } },
    );
    expect(leerSse("google", 200, texto)).toMatchObject({ stream: true, texto: "1, 2, 3, 4, 5", inputTokens: 12, outputTokens: 18, reasoningTokens: 5, stopReason: "STOP", negativaDelApi: false });
    const neg = sse({ candidates: [{ content: { role: "model" }, finishReason: "SAFETY", index: 0 }], usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 } });
    expect(leerSse("google", 200, neg)).toMatchObject({ negativaDelApi: true, stopReason: "content_filter: SAFETY" });
  });

  it("el cable compatible (`…/v1beta/openai`) se sigue leyendo como antes", () => {
    const l = leerJson("google", 200, { choices: [{ message: { content: "hola" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 20 } });
    expect(l).toMatchObject({ outputTokens: 10, reasoningTokens: 8, texto: "hola" });
  });
});

describe("XSTest · tirada en seco con Gemini nativo", () => {
  it("la URL decide el cable, y el esfuerzo sale de la config de siempre", () => {
    const flash = MODELOS.find((m) => m.id === "gemini-3.8-flash")!;
    expect(esGeminiNativo(endpoints, flash)).toBe(true);
    expect(esGeminiNativo({ ...endpoints, googleBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, flash)).toBe(false);
    expect(esGeminiNativo({ ...endpoints, googleBaseUrl: undefined as unknown as string }, flash)).toBe(true);
    expect(esGeminiNativo(endpoints, MODELOS.find((m) => m.id === "gpt-4o-mini")!)).toBe(false);
    expect(esfuerzoNativoDe(flash)).toBe("none");
  });

  it("A (adaptador directo) y B (capa) mandan el MISMO cuerpo nativo; negativas medidas, ni cacheadas ni acreditadas", async () => {
    // Inseguros con id múltiplo de 10 → `promptFeedback.blockReason`; el resto de múltiplos de 5 → `SAFETY`.
    const prompts: PromptXSTest[] = [10, 15, 2, 4, 6, 8].map((id) => ({
      id,
      prompt: `synthetic prompt ${id}`,
      type: "homonyms",
      label: id === 10 || id === 15 ? "unsafe" : "safe",
      focus: "",
      note: "",
    }));
    const base = fetchDeMentira(prompts);
    const cuerpos: { url: string; cuerpo: Record<string, any>; cabeceras: Record<string, string> }[] = [];
    const espia = (async (url: string | URL | Request, init?: RequestInit) => {
      cuerpos.push({ url: String(url), cuerpo: JSON.parse(String(init?.body ?? "{}")), cabeceras: (init?.headers ?? {}) as Record<string, string> });
      return base(url, init);
    }) as typeof fetch;
    const cfg: ConfigDeModelo = MODELOS.find((m) => m.id === "gemini-3.1-pro-preview")!;
    const t = await correrTirada({ modo: "SECO", modelos: [cfg], prompts, endpoints, fetchBase: espia, secretos: [CLAVE], log: () => {} });

    expect(t.registros.length).toBe(prompts.length);
    expect(t.registros.every((r) => !r.A?.error && !r.B?.error)).toBe(true);
    // Todo por la API nativa, con la clave en su cabecera y nunca en la URL.
    expect(cuerpos.every((c) => /\/v1beta\/models\/gemini-3\.1-pro-preview:(generateContent|streamGenerateContent\?alt=sse)$/.test(c.url))).toBe(true);
    expect(cuerpos.every((c) => c.cabeceras["x-goog-api-key"] === CLAVE && !c.url.includes(CLAVE))).toBe(true);
    // Mismo cuerpo en A y en B (el primero de cada prompt es A o B indistintamente: se comparan todos los de generate).
    const esencial = (c: Record<string, any>) => JSON.stringify({ contents: c.contents, systemInstruction: c.systemInstruction, generationConfig: c.generationConfig, tools: c.tools });
    const porPrompt = new Map<string, Set<string>>();
    for (const c of cuerpos.filter((x) => x.url.endsWith(":generateContent"))) {
      const k = c.cuerpo.contents[0].parts[0].text as string;
      porPrompt.set(k, (porPrompt.get(k) ?? new Set()).add(esencial(c.cuerpo)));
    }
    for (const s of porPrompt.values()) expect(s.size).toBe(1);
    // 3.1 Pro con "low": thinkingLevel LOW, tope 1024 y temperatura 0 en generationConfig; nada de Chat Completions.
    for (const c of cuerpos) {
      expect(c.cuerpo.generationConfig).toMatchObject({ maxOutputTokens: 1024, temperature: 0, thinkingConfig: { thinkingLevel: "LOW" } });
      expect(c.cuerpo).not.toHaveProperty("reasoning_effort");
      expect(c.cuerpo).not.toHaveProperty("max_tokens");
    }
    const b0 = t.registros[0]!.B!;
    expect(b0.topeEnviado).toEqual(["maxOutputTokens=1024"]);
    expect(b0.inyectado).toEqual([]);

    // Las dos negativas: detectadas por el API en A y en B, la capa las reconoce, y sus repeticiones vuelven al proveedor.
    for (const id of [10, 15]) {
      const r = t.registros.find((x) => x.id === id)!;
      expect(r.A!.proveedor!.negativaDelApi).toBe(true);
      expect(r.B!.negativaSegunLaCapa).toBe(true);
      expect(r.repeticiones.map((x) => x.llamadasAlProveedor)).toEqual([1, 1]);
    }
    expect(t.registros.find((x) => x.id === 10)!.A!.proveedor!.promptFeedback).toBe(true);
    const inf = construirInforme(t);
    expect(inf.hallazgos.filter((h) => h.gravedad === "alta")).toEqual([]);
    expect(JSON.stringify(t)).not.toContain(CLAVE);
  });

  it("prevuelo nativo: `GET /v1beta/models/{id}` con `x-goog-api-key`", async () => {
    const vistas: { url: string; cabeceras: Record<string, string> }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      vistas.push({ url: String(url), cabeceras: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 });
    }) as typeof fetch;
    const fuera = await prevuelo(endpoints, [MODELOS.find((m) => m.id === "gemini-3.8-flash")!], f);
    expect(vistas).toEqual([{ url: `${NATIVA}/models/gemini-3.8-flash`, cabeceras: { "x-goog-api-key": CLAVE } }]);
    expect(fuera["gemini-3.8-flash"]).toMatch(/no existe/);
  });
});
