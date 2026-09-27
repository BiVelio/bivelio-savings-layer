import { describe, it, expect, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { atestadoDelCable } from "../src/providers/atestado-del-cable.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * PETICIONES `standalone`: EL PROVEEDOR ESCRIBE SU CACHÉ SOLO EN EL PREFIJO
 * ESTABLE, O EN NINGUNA PARTE.
 *
 * En GPT-5.6+ escribir la caché cuesta 1,25x la entrada, y en modo implícito el
 * punto de ruptura cae al final de la pregunta: una petición de un solo uso
 * escribe TODO su prompt y nadie lo vuelve a leer. Con `mode: "explicit"` y un
 * punto en la frontera del prefijo, solo se escribe lo que se repite.
 *
 * Lo que este fichero fija, además del cuerpo: SIN la marca el cuerpo es el de
 * siempre, byte a byte, y fuera del API de OpenAI (o en un modelo sin prima) la
 * marca no toca nada y el informe lo dice.
 */

const OFICIAL = "https://api.openai.com/v1";
const SISTEMA = "Eres un clasificador de incidencias. ".repeat(200);

interface Llamada {
  url: string;
  cuerpo: Record<string, unknown>;
}

/** `fetch` que captura cada cuerpo y contesta con el uso que se le diga. */
function servidor(uso: Record<string, unknown> = { prompt_tokens: 3000, completion_tokens: 40 }, extra: Record<string, unknown> = {}) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, cuerpo: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: uso, ...extra }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { llamadas, fetchImpl };
}

const PETICION_PROVEEDOR: ProviderRequest = {
  model: "gpt-5.6-luna",
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: "¿Es urgente la incidencia 42?" },
  ],
};

beforeEach(() => reiniciarAvisos());

// ── El adaptador: el cuerpo, al byte ────────────────────────────────────────

describe("adaptador OpenAI: el modo explícito en el cable", () => {
  it("con la marca y prefijo: `mode: \"explicit\"` y UN punto en la frontera", async () => {
    const s = servidor();
    const r = await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }).generate({
      ...PETICION_PROVEEDOR,
      explicitCacheWrites: true,
      stablePrefixMessages: 1,
      promptCacheKey: "huella",
    });
    const cuerpo = s.llamadas[0]!.cuerpo;
    expect(cuerpo["prompt_cache_options"]).toEqual({ mode: "explicit" });
    const mensajes = cuerpo["messages"] as Record<string, unknown>[];
    expect(mensajes[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: SISTEMA, prompt_cache_breakpoint: { mode: "explicit" } }],
    });
    // La pregunta sigue siendo texto plano: después del punto, sin prima.
    expect(mensajes[1]).toEqual({ role: "user", content: "¿Es urgente la incidencia 42?" });
    expect(atestadoDelCable(r)?.cacheExplicita).toEqual({ puntos: 1 });
    expect(atestadoDelCable(r)?.origen).toBe("openai");
  });

  it("el punto va en el índice `stablePrefixMessages − 1`", async () => {
    const s = servidor();
    await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }).generate({
      model: "gpt-5.6-terra",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: "primera" },
        { role: "assistant", content: "respuesta" },
        { role: "user", content: "segunda" },
        { role: "user", content: "la pregunta" },
      ],
      explicitCacheWrites: true,
      stablePrefixMessages: 4,
    });
    const mensajes = s.llamadas[0]!.cuerpo["messages"] as Record<string, unknown>[];
    const conPunto = mensajes.flatMap((m, i) => (Array.isArray(m["content"]) ? [i] : []));
    expect(conPunto).toEqual([3]);
  });

  it("sin prefijo, o con la frontera en un turno del asistente: explícito con CERO puntos", async () => {
    for (const req of [
      { ...PETICION_PROVEEDOR, explicitCacheWrites: true },
      {
        model: "gpt-5.6-luna",
        messages: [
          { role: "system" as const, content: SISTEMA },
          { role: "assistant" as const, content: "hola" },
          { role: "user" as const, content: "pregunta" },
        ],
        explicitCacheWrites: true,
        stablePrefixMessages: 2,
      },
    ]) {
      const s = servidor();
      const r = await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }).generate(req);
      const cuerpo = s.llamadas[0]!.cuerpo;
      // Explícito sin puntos = ni escribe ni lee: el lado que no cobra prima.
      expect(cuerpo["prompt_cache_options"]).toEqual({ mode: "explicit" });
      expect((cuerpo["messages"] as Record<string, unknown>[]).every((m) => typeof m["content"] === "string")).toBe(true);
      expect(atestadoDelCable(r)?.cacheExplicita).toEqual({ puntos: 0 });
    }
  });

  it("⛔ SIN la marca, el cuerpo es EXACTAMENTE el de siempre", async () => {
    const s = servidor();
    const r = await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }).generate({
      ...PETICION_PROVEEDOR,
      stablePrefixMessages: 1,
      promptCacheKey: "huella",
    });
    expect(s.llamadas[0]!.cuerpo).toEqual({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: "¿Es urgente la incidencia 42?" },
      ],
      prompt_cache_key: "huella",
    });
    expect(atestadoDelCable(r)?.cacheExplicita).toBeUndefined();
  });

  it("⛔ gpt-5.4 (sin prima), Gemini o un host no oficial: la marca no toca el cuerpo", async () => {
    const casos: [string, string][] = [
      [OFICIAL, "gpt-5.4"],
      [OFICIAL, "o4-mini"],
      ["https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-pro"],
      ["https://proxy.example.com/v1", "gpt-5.6-luna"],
      ["https://eu.api.openai.com/v1", "gpt-5.6-luna"],
    ];
    for (const [baseUrl, model] of casos) {
      const con = servidor();
      const sin = servidor();
      const base = { ...PETICION_PROVEEDOR, model, stablePrefixMessages: 1, promptCacheKey: "huella" };
      const r = await new OpenAICompatibleProvider({ baseUrl, fetchImpl: con.fetchImpl }).generate({
        ...base,
        explicitCacheWrites: true,
      });
      await new OpenAICompatibleProvider({ baseUrl, fetchImpl: sin.fetchImpl }).generate(base);
      expect(con.llamadas[0]!.cuerpo, `${baseUrl} · ${model}`).toEqual(sin.llamadas[0]!.cuerpo);
      expect(atestadoDelCable(r)?.cacheExplicita).toBeUndefined();
    }
  });

  it("lee `prompt_tokens_details.cache_write_tokens`, en generate y en stream", async () => {
    const uso = { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } };
    const s = servidor(uso);
    const r = await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect(r.usage.cacheWriteInputTokens).toBe(1200);

    const sse = [
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: uso },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const fetchSse = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    let final: { usage: { cacheWriteInputTokens?: number } } | undefined;
    for await (const ev of new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: fetchSse }).generateStream(PETICION_PROVEEDOR)) {
      if (ev.type === "done") final = ev.response;
    }
    expect(final!.usage.cacheWriteInputTokens).toBe(1200);

    // Sin el campo, ausente (no 0): «no se sabe» no es «no escribió».
    const sinCampo = servidor({ prompt_tokens: 10, completion_tokens: 2 });
    const r2 = await new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: sinCampo.fetchImpl }).generate(PETICION_PROVEEDOR);
    expect(r2.usage.cacheWriteInputTokens).toBeUndefined();
  });
});

// ── El pipeline: la decisión, el informe y el dinero ────────────────────────

const peticion = (pregunta: string, standalone?: boolean, model = "openai/gpt-5.6-luna"): SavingsRequest => ({
  model,
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: pregunta },
  ],
  ...(standalone === undefined ? {} : { savings: { standalone } }),
});

describe("pipeline: `savings.standalone`", () => {
  it("marca el prefijo, pone el punto y publica `report.cacheWrites` con la prima evitada (`estimated`)", async () => {
    const s = servidor({ prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } });
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    const { report } = await layer.generate(peticion("¿Es urgente la 42?", true));

    const cuerpo = s.llamadas[0]!.cuerpo;
    expect(cuerpo["prompt_cache_options"]).toEqual({ mode: "explicit" });
    const mensajes = cuerpo["messages"] as Record<string, unknown>[];
    expect(Array.isArray(mensajes[0]!["content"])).toBe(true);
    expect(typeof mensajes[1]!["content"]).toBe("string");

    expect(report.cacheWrites).toBeDefined();
    expect(report.cacheWrites!.mode).toBe("explicit");
    expect(report.cacheWrites!.breakpoints).toBe(1);
    expect(report.cacheWrites!.reason).toMatch(/Trade-off/);
    const prima = report.cacheWrites!.avoidedWritePremium!;
    expect(prima.basis).toBe("estimated");
    // 3000 − 0 − 1200 = 1800 ordinarios · (0,25 − 0,20) por 1M.
    expect(prima.amount).toBeCloseTo(1800 * (0.00025 - 0.0002) / 1000, 12);
    expect(prima.basisReason).toMatch(/not run/);
    expect(report.traces.some((t) => t.stage === "cache-writes")).toBe(true);
  });

  it("⛔ cuando la verja deja de marcar (h medida bajo el equilibrio), CERO puntos: ni escribe ni lee", async () => {
    // Cada petición escribe el prefijo y ninguna lo lee: h = 0 tras la
    // exploración, y la verja se apaga para esta huella.
    const s = servidor({ prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } });
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    for (let i = 0; i < 8; i++) await layer.generate(peticion(`pregunta distinta ${i}`, true));
    const { report } = await layer.generate(peticion("la novena", true));

    const ultima = s.llamadas.at(-1)!.cuerpo;
    expect(ultima["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect((ultima["messages"] as Record<string, unknown>[]).every((m) => typeof m["content"] === "string")).toBe(true);
    expect(report.cacheWrites!.mode).toBe("explicit");
    expect(report.cacheWrites!.breakpoints).toBe(0);
    expect(report.cacheWrites!.reason).toMatch(/neither wrote nor read/);
  });

  it("sin prefijo estable (solo la pregunta): explícito con cero puntos", async () => {
    const s = servidor();
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    const { report } = await layer.generate({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "solo esto" }],
      savings: { standalone: true },
    });
    expect(s.llamadas[0]!.cuerpo["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect(report.cacheWrites!.breakpoints).toBe(0);
  });

  it("⛔ SIN `standalone`, el cuerpo que sale del pipeline es el de siempre y no hay bloque", async () => {
    const s = servidor();
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    const { report } = await layer.generate(peticion("¿Es urgente la 42?"));
    const cuerpo = s.llamadas[0]!.cuerpo;
    expect(Object.keys(cuerpo).sort()).toEqual(["messages", "model", "prompt_cache_key"]);
    expect((cuerpo["messages"] as Record<string, unknown>[]).every((m) => typeof m["content"] === "string")).toBe(true);
    expect("cacheWrites" in report).toBe(false);
  });

  it("⛔ gpt-5.4, Gemini, Anthropic o un host no oficial: cuerpo intacto y `provider-default` con su motivo", async () => {
    const openaiCon = (baseUrl: string) => {
      const s = servidor();
      return { s, provider: new OpenAICompatibleProvider({ baseUrl, fetchImpl: s.fetchImpl }) };
    };
    const anthropicCon = () => {
      const llamadas: Llamada[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        llamadas.push({ url, cuerpo: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 20 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      return { s: { llamadas }, provider: new AnthropicProvider({ fetchImpl }) };
    };

    const escenarios = [
      { nombre: "gpt-5.4", hacer: () => openaiCon(OFICIAL), model: "openai/gpt-5.4", motivo: /not an OpenAI model that bills/ },
      { nombre: "gemini", hacer: () => openaiCon("https://generativelanguage.googleapis.com/v1beta/openai"), model: "gemini-2.5-pro", motivo: /not an OpenAI model that bills/ },
      { nombre: "anthropic", hacer: anthropicCon, model: "claude-haiku-4-5", motivo: /not an OpenAI model that bills/ },
      { nombre: "proxy", hacer: () => openaiCon("https://proxy.example.com/v1"), model: "openai/gpt-5.6-luna", motivo: /only exists on OpenAI's own API/ },
    ];
    for (const e of escenarios) {
      const con = e.hacer();
      const sin = e.hacer();
      const r = await createSavingsLayer({ provider: con.provider as never }).generate(peticion("pregunta", true, e.model));
      await createSavingsLayer({ provider: sin.provider as never }).generate(peticion("pregunta", undefined, e.model));
      expect(con.s.llamadas[0]!.cuerpo, e.nombre).toEqual(sin.s.llamadas[0]!.cuerpo);
      expect(r.report.cacheWrites!.mode, e.nombre).toBe("provider-default");
      expect(r.report.cacheWrites!.breakpoints).toBe(0);
      expect(r.report.cacheWrites!.avoidedWritePremium).toBeUndefined();
      expect(r.report.cacheWrites!.reason, e.nombre).toMatch(e.motivo);
    }
  });

  it("⛔ `cost.*` es IDÉNTICO con y sin `standalone`: la palanca no toca el dinero publicado", async () => {
    const uso = { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } };
    const a = servidor(uso);
    const b = servidor(uso);
    const sin = await createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: a.fetchImpl }) })
      .generate(peticion("¿Es urgente la 42?"));
    const con = await createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: b.fetchImpl }) })
      .generate(peticion("¿Es urgente la 42?", true));
    expect(con.report.cost).toEqual(sin.report.cost);
  });

  it("un acierto de caché con `standalone` publica el bloque diciendo que no hubo llamada", async () => {
    const s = servidor();
    const layer = createSavingsLayer({ provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }) });
    await layer.generate(peticion("¿Es urgente la 42?", true));
    const segunda = await layer.generate(peticion("¿Es urgente la 42?", true));
    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.report.cacheWrites).toEqual({
      mode: "provider-default",
      breakpoints: 0,
      reason: expect.stringMatching(/no provider call was made/),
    });
  });
});
