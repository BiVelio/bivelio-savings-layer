import { describe, it, expect } from "vitest";

import { construirBrazoNaive, construirBrazoNativo, construirBrazoRazonable } from "../benchmarks/brazos.js";
import {
  BUSQUEDA_ANTHROPIC,
  EFFORT_ANTHROPIC,
  conAjustesNativos,
  igualQueB1,
  planNativo,
  reescribirCuerpo,
  resumirPlanes,
  type EsfuerzoB2,
  type PlanNativo,
} from "../benchmarks/nativo.js";
import { conMuestreoPareado, conSalDeFrio, scenarios, type Scenario } from "../benchmarks/scenarios.js";
import { proveedorDelBanco, proveedorDelBrazoNativo, type ConfigDeTransporte } from "../benchmarks/transporte.js";
import type { SavingsRequest, ToolDescriptor } from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";

/**
 * EL BRAZO B2 «NATIVO BIEN CONFIGURADO», SIN PAGAR UNA LLAMADA.
 *
 * Tres cosas que tienen que ser ciertas para que la comparación contra B2 sea
 * la que dice ser (informe de competencia, §8 rec. 3):
 *
 *   1. B2 es B1 y algo más, nunca otra petición: mismos mensajes, contrato,
 *      tope, muestreo y marcas de caché.
 *   2. Cada ajuste se decide con una REGLA que tiene su fuente oficial, y la
 *      regla dice «no aplica» cuando no aplica (la búsqueda de herramientas con
 *      8 herramientas, la compactación con unos miles de tokens).
 *   3. Lo que viaja por el cable es exactamente eso: se comprueba sobre el
 *      cuerpo que el adaptador arma, con un `fetch` de mentira.
 */

const escenario = (nombre: string): Scenario => {
  const s = scenarios.find((x) => x.name === nombre);
  expect(s, `falta el escenario ${nombre}`).toBeDefined();
  return s!;
};

/** Un `fetch` que no sale a la red: guarda lo que se le pide y contesta el mínimo. */
function fetchEspia(respuesta: unknown): { fetchImpl: typeof fetch; cuerpos: { url: string; body: Record<string, unknown> }[] } {
  const cuerpos: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    cuerpos.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(respuesta), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, cuerpos };
}

const RESPUESTA_OPENAI = {
  model: "gpt-6-luna",
  choices: [{ message: { content: "{\"answer\":\"ok\"}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7_000, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
};
const RESPUESTA_ANTHROPIC = {
  content: [{ type: "text", text: "vale" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

const CFG_OPENAI: ConfigDeTransporte = { openaiBaseUrl: "https://openai.invalido/v1", openaiApiKey: "no-es-una-clave" };
const CFG_ANTHROPIC: ConfigDeTransporte = {
  anthropicBaseUrl: "https://anthropic.invalido/v1",
  anthropicApiKey: "no-es-una-clave",
};

/** La petición del escenario con el modelo forzado y el muestreo que le toca, como en `runScenario`. */
function peticionDe(s: Scenario, modelo: string, sal?: string): SavingsRequest {
  const base: SavingsRequest = { ...s.request, model: modelo };
  return conMuestreoPareado(sal ? conSalDeFrio(base, sal) : base);
}

function plan(modelo: string, transporte: "openai-compatible" | "anthropic-nativo" | "mock", peticion: ProviderRequest, esfuerzo: EsfuerzoB2 = "low", extra: Partial<Parameters<typeof planNativo>[0]> = {}): PlanNativo {
  return planNativo({ modelo, transporte, peticion, esfuerzo, ...extra });
}

const decision = (p: PlanNativo, f: string) => p.decisiones.find((d) => d.funcion === f);

describe("B2 es B1 y algo más: la petición neutra es la misma", () => {
  for (const s of scenarios) {
    it(s.name, () => {
      const req = conMuestreoPareado(s.request);
      const opts = s.toolsB1 ? { toolsB1: s.toolsB1 } : {};
      expect(construirBrazoNativo(req, req.model, opts)).toEqual(construirBrazoRazonable(req, req.model, opts));
    });
  }

  it("con la búsqueda de herramientas, B2 manda TODAS (como B0) y conserva la caché de B1", () => {
    const s = escenario("Tool-heavy request");
    const req = conMuestreoPareado(s.request);
    const b2 = construirBrazoNativo(req, req.model, { toolsB1: s.toolsB1!, busquedaDeHerramientas: true });
    expect(b2.tools?.map((t) => t.id)).toEqual(construirBrazoNaive(req, req.model).tools?.map((t) => t.id));
    expect(b2.stablePrefixMessages).toBe(construirBrazoRazonable(req, req.model, {}).stablePrefixMessages);
    expect(b2.messages).toEqual(construirBrazoRazonable(req, req.model, {}).messages);
  });
});

describe("el plan de B2, modelo a modelo, con su fuente", () => {
  const prefijo = escenario("Stable-prefix agent turn");

  it("gpt-6-luna: esfuerzo bajo, modo explícito y breakpoint SOLO al final de un prefijo que se repite", () => {
    const req = peticionDe(prefijo, "openai/gpt-6-luna");
    const p = plan("openai/gpt-6-luna", "openai-compatible", construirBrazoNativo(req, req.model));
    expect(decision(p, "reasoningEffort")).toMatchObject({ aplicada: true, valor: "low" });
    expect(decision(p, "promptCacheMode")).toMatchObject({ aplicada: true, valor: "explicit" });
    expect(decision(p, "promptCacheBreakpoint")).toMatchObject({ aplicada: true, valor: 0 });
    expect(p.cable.openai).toEqual({ reasoningEffort: "low", promptCacheMode: "explicit", breakpointEnMensaje: 0 });
    expect(decision(p, "toolSearch")?.aplicada).toBe(false);
    expect(decision(p, "toolSearch")?.motivo).toMatch(/Responses API only/);
    expect(decision(p, "compaction")?.aplicada).toBe(false);
    expect(decision(p, "compaction")?.motivo).toMatch(/Responses API only/);
    expect(p.degradadoPorTransporte).toBe(false);
    expect(igualQueB1(p)).toBe(false);
  });

  it("gpt-6-luna en un escenario salado: modo explícito SIN breakpoint, así que sin escrituras de caché", () => {
    const req = peticionDe(escenario("Summarize provided text"), "openai/gpt-6-luna", "sal-de-prueba");
    const p = plan("openai/gpt-6-luna", "openai-compatible", construirBrazoNativo(req, req.model));
    expect(decision(p, "promptCacheMode")?.aplicada).toBe(true);
    expect(decision(p, "promptCacheBreakpoint")?.aplicada).toBe(false);
    expect(p.cable.openai?.breakpointEnMensaje).toBeUndefined();
  });

  it("gpt-4o-mini: nada que ajustar, y se DICE (B2 = B1)", () => {
    const req = peticionDe(prefijo, "openai/gpt-4o-mini");
    const p = plan("openai/gpt-4o-mini", "openai-compatible", construirBrazoNativo(req, req.model));
    expect(igualQueB1(p)).toBe(true);
    expect(decision(p, "reasoningEffort")).toMatchObject({ aplicada: false });
    expect(decision(p, "reasoningEffort")?.motivo).toMatch(/not a reasoning model/);
    expect(decision(p, "implicitCache")?.motivo).toMatch(/no prompt_cache_options/);
    expect(decision(p, "promptCacheMode")).toBeUndefined();
  });

  it("claude-sonnet-5 por el endpoint nativo: effort bajo; ni búsqueda (8 herramientas) ni compactación (50.000)", () => {
    const s = escenario("Big tool catalogue (schema-on-demand)");
    const req = peticionDe(s, "anthropic/claude-sonnet-5");
    const p = plan("anthropic/claude-sonnet-5", "anthropic-nativo", construirBrazoNativo(req, req.model), "low", {
      numHerramientas: req.tools?.length ?? 0,
      tokensDeEsquemas: 3_000,
    });
    expect(req.tools?.length).toBeLessThan(10);
    expect(decision(p, "reasoningEffort")).toMatchObject({ aplicada: true, valor: "low" });
    expect(p.cable.anthropic).toEqual({ effort: "low" });
    expect(decision(p, "toolSearch")?.aplicada).toBe(false);
    expect(decision(p, "toolSearch")?.motivo).toMatch(/under the documented threshold/);
    expect(decision(p, "compaction")?.aplicada).toBe(false);
    expect(decision(p, "compaction")?.motivo).toMatch(/50,000/);
    expect(decision(p, "contextEditing")?.aplicada).toBe(false);
  });

  it("claude-haiku-4-5: sin `effort` en la documentación, su B2 se queda en B1 y lo dice", () => {
    const req = peticionDe(escenario("Anthropic stable-prefix agent turn"), "anthropic/claude-haiku-4-5");
    const p = plan("anthropic/claude-haiku-4-5", "anthropic-nativo", construirBrazoNativo(req, req.model));
    expect(decision(p, "reasoningEffort")).toMatchObject({ aplicada: false });
    expect(decision(p, "reasoningEffort")?.motivo).toMatch(/not in the effort parameter's supported models/);
    expect(decision(p, "anthropicCacheBreakpoint")?.aplicada).toBe(true);
    expect(igualQueB1(p)).toBe(true);
  });

  it("claude-sonnet-5 por la pasarela: B2 queda DEGRADADO por el transporte (y la verja no lo publica)", () => {
    const req = peticionDe(prefijo, "anthropic/claude-sonnet-5");
    const p = plan("anthropic/claude-sonnet-5", "openai-compatible", construirBrazoNativo(req, req.model));
    expect(p.degradadoPorTransporte).toBe(true);
    expect(decision(p, "reasoningEffort")?.motivo).toMatch(/degraded by transport/);
    expect(igualQueB1(p)).toBe(true);
  });

  it("gemini-3.8-flash: esfuerzo bajo por el endpoint OpenAI-compatible, y la caché implícita declarada", () => {
    const req = peticionDe(escenario("Gemini stable-prefix agent turn"), "google/gemini-3.8-flash");
    const p = plan("google/gemini-3.8-flash", "openai-compatible", construirBrazoNativo(req, req.model));
    expect(decision(p, "reasoningEffort")).toMatchObject({ aplicada: true, valor: "low" });
    expect(decision(p, "implicitCache")?.motivo).toMatch(/on by default/);
    expect(p.cable.openai).toEqual({ reasoningEffort: "low" });
  });

  it("un esfuerzo que el modelo no admite para la tirada ANTES de gastar", () => {
    const req = peticionDe(prefijo, "openai/gpt-6-luna");
    const r = construirBrazoNativo(req, req.model);
    expect(() => plan("openai/gpt-6-luna", "openai-compatible", r, "minimal")).toThrow(/does not accept reasoning_effort "minimal"/);
    expect(() => plan("anthropic/claude-sonnet-5", "anthropic-nativo", r, "minimal")).toThrow(/Anthropic effort levels/);
    expect(() => plan("anthropic/claude-sonnet-5", "anthropic-nativo", r, "none")).toThrow(/Anthropic effort levels/);
    expect(() => plan("google/gemini-3.8-flash", "openai-compatible", r, "none")).toThrow(/cannot be turned off/);
    expect(() => plan("openai/gpt-6-luna", "openai-compatible", r, "bogus" as EsfuerzoB2)).toThrow(/is not one of/);
    // `default` no cambia nada: el B2 sin el intercambio de calidad.
    const porDefecto = plan("openai/gpt-6-luna", "openai-compatible", r, "default");
    expect(decision(porDefecto, "reasoningEffort")?.aplicada).toBe(false);
    expect(porDefecto.cable.openai?.reasoningEffort).toBeUndefined();
  });

  it("en MOCK el plan es el del transporte que se usaría, marcado como simulado", () => {
    const req = peticionDe(prefijo, "anthropic/claude-sonnet-5");
    const p = plan("anthropic/claude-sonnet-5", "mock", construirBrazoNativo(req, req.model));
    expect(p.simulado).toBe(true);
    expect(p.transporte).toBe("anthropic-nativo");
    expect(plan("openai/gpt-6-luna", "mock", construirBrazoNativo(req, req.model)).transporte).toBe("openai-compatible");
  });

  it("TODA decisión lleva su fuente oficial y la fecha en que se leyó", () => {
    const planes: PlanNativo[] = [];
    for (const [modelo, transporte] of [
      ["openai/gpt-6-luna", "openai-compatible"],
      ["openai/gpt-4o-mini", "openai-compatible"],
      ["anthropic/claude-sonnet-5", "anthropic-nativo"],
      ["anthropic/claude-sonnet-5", "openai-compatible"],
      ["anthropic/claude-haiku-4-5", "anthropic-nativo"],
      ["google/gemini-3.8-flash", "openai-compatible"],
    ] as const) {
      const req = peticionDe(prefijo, modelo);
      planes.push(plan(modelo, transporte, construirBrazoNativo(req, req.model)));
    }
    for (const p of planes) {
      expect(p.decisiones.length).toBeGreaterThan(0);
      for (const d of p.decisiones) {
        expect(d.fuente.url).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev|raw\.githubusercontent\.com\/openai\/openai-node)\//);
        expect(d.fuente.consultado).toBe("2026-09-27");
        // Público: en inglés, sin acentos del castellano.
        expect(d.motivo).not.toMatch(/[áéíóúñ¿¡]/);
      }
    }
    // Y el resumen por modelo conserva la fuente y dice dónde se aplicó.
    const resumen = resumirPlanes(planes.map((plan, i) => ({ escenario: `e${i}`, plan })));
    expect(resumen.find((d) => d.feature === "reasoningEffort")?.scenarios?.length).toBeGreaterThan(0);
    expect(resumen.every((d) => d.source.checked === "2026-09-27")).toBe(true);
  });

  it("las listas de modelos son las de la documentación (Sonnet 5 tiene `effort` pero no búsqueda de herramientas)", () => {
    expect(EFFORT_ANTHROPIC).toContain("claude-sonnet-5");
    expect(EFFORT_ANTHROPIC).not.toContain("claude-haiku-4-5-20251001");
    expect(BUSQUEDA_ANTHROPIC).not.toContain("claude-sonnet-5");
    expect(BUSQUEDA_ANTHROPIC).toContain("claude-haiku-4-5-20251001");
  });
});

describe("lo que viaja por el cable: B0 frente a B2", () => {
  it("OpenAI, «Stable-prefix agent turn» contra gpt-6-luna: modo explícito, esfuerzo y breakpoint en el mensaje 0", async () => {
    const s = escenario("Stable-prefix agent turn");
    const req = peticionDe(s, "openai/gpt-6-luna");
    const b0 = fetchEspia(RESPUESTA_OPENAI);
    await proveedorDelBanco("openai/gpt-6-luna", { ...CFG_OPENAI, fetchImpl: b0.fetchImpl }).generate(
      construirBrazoNaive(req, req.model),
    );
    const b2 = fetchEspia(RESPUESTA_OPENAI);
    const planPara = (r: ProviderRequest) => plan("openai/gpt-6-luna", "openai-compatible", r);
    await proveedorDelBrazoNativo("openai/gpt-6-luna", { ...CFG_OPENAI, fetchImpl: b2.fetchImpl }, planPara).generate(
      construirBrazoNativo(req, req.model),
    );
    const cuerpoB0 = b0.cuerpos[0]!.body;
    const cuerpoB2 = b2.cuerpos[0]!.body;
    expect(b2.cuerpos[0]!.url).toBe("https://openai.invalido/v1/chat/completions");
    // Por un endpoint directo, el id viaja SIN prefijo.
    expect(cuerpoB2["model"]).toBe("gpt-6-luna");
    expect(cuerpoB2["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect(cuerpoB2["reasoning_effort"]).toBe("low");
    const mensajesB2 = cuerpoB2["messages"] as { content: unknown }[];
    const mensajesB0 = cuerpoB0["messages"] as { content: unknown }[];
    expect(mensajesB2[0]!.content).toEqual([
      { type: "text", text: mensajesB0[0]!.content, prompt_cache_breakpoint: { mode: "explicit" } },
    ]);
    // Solo el mensaje 0 cambia de forma, y el texto es el mismo.
    expect(mensajesB2.slice(1)).toEqual(mensajesB0.slice(1));
    // B0 no lleva nada de eso…
    expect(cuerpoB0["prompt_cache_options"]).toBeUndefined();
    expect(cuerpoB0["reasoning_effort"]).toBeUndefined();
    expect(typeof mensajesB0[0]!.content).toBe("string");
    // …y NINGÚN brazo manda temperature ni seed a un modelo que razona.
    for (const c of [cuerpoB0, cuerpoB2]) {
      expect(c["temperature"]).toBeUndefined();
      expect(c["seed"]).toBeUndefined();
    }
    // El contrato viaja igual en los dos.
    expect(cuerpoB2["response_format"]).toEqual(cuerpoB0["response_format"]);
  });

  it("OpenAI, un escenario salado: modo explícito y NINGÚN breakpoint", async () => {
    const req = peticionDe(escenario("Summarize provided text"), "openai/gpt-6-luna", "sal-de-prueba");
    const b2 = fetchEspia(RESPUESTA_OPENAI);
    await proveedorDelBrazoNativo("openai/gpt-6-luna", { ...CFG_OPENAI, fetchImpl: b2.fetchImpl }, (r) =>
      plan("openai/gpt-6-luna", "openai-compatible", r),
    ).generate(construirBrazoNativo(req, req.model));
    const cuerpo = b2.cuerpos[0]!.body;
    expect(cuerpo["prompt_cache_options"]).toEqual({ mode: "explicit" });
    expect(JSON.stringify(cuerpo)).not.toContain("prompt_cache_breakpoint");
  });

  it("Anthropic nativo, «Anthropic stable-prefix agent turn» contra Sonnet 5: effort y la MISMA caché que B1", async () => {
    const s = escenario("Anthropic stable-prefix agent turn");
    const req = peticionDe(s, "anthropic/claude-sonnet-5");
    const b1 = fetchEspia(RESPUESTA_ANTHROPIC);
    await proveedorDelBanco("anthropic/claude-sonnet-5", { ...CFG_ANTHROPIC, fetchImpl: b1.fetchImpl }).generate(
      construirBrazoRazonable(req, req.model),
    );
    const b2 = fetchEspia(RESPUESTA_ANTHROPIC);
    await proveedorDelBrazoNativo("anthropic/claude-sonnet-5", { ...CFG_ANTHROPIC, fetchImpl: b2.fetchImpl }, (r) =>
      plan("anthropic/claude-sonnet-5", "anthropic-nativo", r),
    ).generate(construirBrazoNativo(req, req.model));
    const cuerpoB1 = b1.cuerpos[0]!.body;
    const cuerpoB2 = b2.cuerpos[0]!.body;
    expect(b2.cuerpos[0]!.url).toBe("https://anthropic.invalido/v1/messages");
    expect((cuerpoB2["output_config"] as { effort?: string } | undefined)?.effort).toBe("low");
    expect(cuerpoB1["output_config"]).toBeUndefined();
    // La caché de B1, tal cual: el mismo `system` con el mismo `cache_control`.
    expect(cuerpoB2["system"]).toEqual(cuerpoB1["system"]);
    expect(JSON.stringify(cuerpoB2["system"])).toContain("cache_control");
    expect(cuerpoB2["messages"]).toEqual(cuerpoB1["messages"]);
    expect(cuerpoB2["temperature"]).toBeUndefined();
  });

  it("Anthropic nativo con 12 herramientas: la búsqueda entra, difiere todas menos las de B1 y el contrato, y quita su cache_control", async () => {
    const tools: ToolDescriptor[] = Array.from({ length: 12 }, (_, i) => ({
      id: `herramienta_${i}`,
      intents: [`intent ${i}`],
      risk: "read",
      description: `Tool number ${i} of a large catalogue`,
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }));
    const req: SavingsRequest = {
      model: "anthropic/claude-opus-5",
      messages: [
        { role: "system", content: "stable policy" },
        { role: "user", content: "find the right tool" },
      ],
      tools,
    };
    const noDiferidas = ["herramienta_3"];
    const peticion = construirBrazoNativo(req, req.model, { toolsB1: noDiferidas, busquedaDeHerramientas: true });
    expect(peticion.tools).toHaveLength(12);
    const planPara = (r: ProviderRequest) =>
      plan("anthropic/claude-opus-5", "anthropic-nativo", r, "low", { numHerramientas: 12, tokensDeEsquemas: 400, noDiferidas });
    expect(decision(planPara(peticion), "toolSearch")?.aplicada).toBe(true);
    const espia = fetchEspia(RESPUESTA_ANTHROPIC);
    await proveedorDelBrazoNativo("anthropic/claude-opus-5", { ...CFG_ANTHROPIC, fetchImpl: espia.fetchImpl }, planPara).generate(peticion);
    const enviadas = espia.cuerpos[0]!.body["tools"] as Record<string, unknown>[];
    expect(enviadas[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    for (const t of enviadas.slice(1)) {
      const sigueCargada = t["name"] === "herramienta_3" || t["name"] === "bvsala_contract";
      expect(t["defer_loading"], String(t["name"])).toBe(sigueCargada ? undefined : true);
      if (t["defer_loading"]) expect(t["cache_control"]).toBeUndefined();
    }
    expect(enviadas.filter((t) => !t["defer_loading"]).length).toBeGreaterThan(0);
  });

  it("la reescritura NUNCA toca el texto de un mensaje ni cuántos hay", () => {
    const cuerpos: Record<string, unknown>[] = [
      { model: "gpt-6-luna", messages: [{ role: "system", content: "A" }, { role: "user", content: "B" }] },
      {
        model: "gpt-6-luna",
        messages: [
          { role: "system", content: [{ type: "text", text: "A1" }, { type: "text", text: "A2" }] },
          { role: "user", content: "B" },
        ],
      },
      { model: "claude-sonnet-5", system: [{ type: "text", text: "S" }], messages: [{ role: "user", content: "B" }], temperature: 0.3, max_tokens: 9 },
    ];
    const planes: PlanNativo[] = [
      { modelo: "gpt-6-luna", transporte: "openai-compatible", simulado: false, degradadoPorTransporte: false, decisiones: [], cable: { openai: { reasoningEffort: "low", promptCacheMode: "explicit", breakpointEnMensaje: 0 } } },
      { modelo: "gpt-6-luna", transporte: "openai-compatible", simulado: false, degradadoPorTransporte: false, decisiones: [], cable: { openai: { promptCacheMode: "explicit", breakpointEnMensaje: 5 } } },
      { modelo: "claude-sonnet-5", transporte: "anthropic-nativo", simulado: false, degradadoPorTransporte: false, decisiones: [], cable: { anthropic: { effort: "low" } } },
    ];
    // Los TEXTOS de los mensajes, en orden, vengan como cadena o como partes.
    const textos = (c: Record<string, unknown>): string[] =>
      (c["messages"] as { content: unknown }[]).flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : (m.content as { text?: string }[]).map((x) => x.text ?? ""),
      );
    for (const p of planes) {
      for (const url of ["https://x.invalido/v1/chat/completions", "https://x.invalido/v1/messages"]) {
        for (const c of cuerpos) {
          const r = reescribirCuerpo(p, url, c);
          expect((r["messages"] as unknown[]).length).toBe((c["messages"] as unknown[]).length);
          expect(textos(r)).toEqual(textos(c));
          expect(r["temperature"]).toEqual(c["temperature"]);
          expect(r["max_tokens"]).toEqual(c["max_tokens"]);
          expect(r["system"]).toEqual(c["system"]);
        }
      }
    }
  });

  it("un cuerpo que no es JSON pasa tal cual, y el `fetch` de base es el que llama", async () => {
    const vistos: unknown[] = [];
    const base = (async (_u: string | URL | Request, init?: RequestInit) => {
      vistos.push(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const p: PlanNativo = { modelo: "gpt-6-luna", transporte: "openai-compatible", simulado: false, degradadoPorTransporte: false, decisiones: [], cable: { openai: { reasoningEffort: "low" } } };
    const f = conAjustesNativos(p, base);
    await f("https://x.invalido/v1/chat/completions", { method: "POST", body: "no es json" });
    await f("https://x.invalido/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) });
    expect(vistos[0]).toBe("no es json");
    expect(JSON.parse(String(vistos[1]))).toEqual({ model: "m", messages: [], reasoning_effort: "low" });
  });
});
