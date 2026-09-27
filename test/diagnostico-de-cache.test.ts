import { beforeEach, describe, expect, it } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryCacheBreakpointStore } from "../src/cache/breakpoint-store.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { SavingsResult } from "../src/contracts/types.js";
import { CacheAnthropicSimulada } from "../benchmarks/colocador-de-cache/simulador.js";
import { agente, reloj } from "../benchmarks/colocador-de-cache/escenarios.js";

/**
 * EL DIAGNÓSTICO DE CACHÉ DE ANTHROPIC (`cacheMissDiagnostics`, opt-in).
 *
 * Verificado en la fuente primaria el 2026-09-27:
 *   https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
 *   https://platform.claude.com/docs/en/release-notes/api (23-sep-2026: GA, sin cabecera beta)
 *
 *  · Petición: `diagnostics: { previous_message_id: <id de la respuesta anterior> | null }`.
 *    El proveedor guarda una huella SOLO de las peticiones que llevan el objeto.
 *  · Respuesta: `diagnostics` es `null` (comparó y no divergió, o no se pidió
 *    comparar), `{cache_miss_reason: null}` (aún comparando) o
 *    `{cache_miss_reason: {type, cache_missed_input_tokens?}}`. En stream, en `message_start`.
 *  · Solo la Claude API: ni Bedrock ni Vertex ni Claude Platform on AWS.
 *
 * Lo que se fija aquí: el campo sale solo si se pide y solo contra el host
 * oficial; se lee igual en JSON y en stream; y el colocador, cuando una lectura
 * que predijo no llega, publica el `cache_miss_reason` en la traza.
 */

beforeEach(() => reiniciarAvisos());

const REQ: ProviderRequest = {
  model: "anthropic/claude-sonnet-4-5",
  messages: [
    { role: "system", content: "Reglas." },
    { role: "user", content: "hola" },
  ],
};

function capturador(respuesta: unknown, tipo = "application/json") {
  const cuerpos: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    cuerpos.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(typeof respuesta === "string" ? respuesta : JSON.stringify(respuesta), {
      status: 200,
      headers: { "content-type": tipo },
    });
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const MENSAJE = (diagnostics: unknown) => ({
  id: "msg_02",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
  ...(diagnostics === undefined ? {} : { diagnostics }),
});

describe("adaptador de Anthropic: el cable", () => {
  it("sin pedirlo, el cuerpo no lleva `diagnostics`", async () => {
    const { cuerpos, fetchImpl } = capturador(MENSAJE(null));
    await new AnthropicProvider({ fetchImpl }).generate(REQ);
    expect(cuerpos[0]).not.toHaveProperty("diagnostics");
  });

  it("pedido, va con el id anterior o con null; contra otro host no va", async () => {
    const oficial = capturador(MENSAJE(null));
    const p = new AnthropicProvider({ fetchImpl: oficial.fetchImpl });
    await p.generate({ ...REQ, cacheDiagnostics: { previousMessageId: "msg_01" } });
    await p.generate({ ...REQ, cacheDiagnostics: { previousMessageId: null } });
    expect(oficial.cuerpos[0]!["diagnostics"]).toEqual({ previous_message_id: "msg_01" });
    expect(oficial.cuerpos[1]!["diagnostics"]).toEqual({ previous_message_id: null });

    const proxy = capturador(MENSAJE(null));
    const r = await new AnthropicProvider({ fetchImpl: proxy.fetchImpl, baseUrl: "https://gateway.example.com/v1" }).generate({
      ...REQ,
      cacheDiagnostics: { previousMessageId: "msg_01" },
    });
    expect(proxy.cuerpos[0]).not.toHaveProperty("diagnostics");
    expect(r.cacheDiagnostics).toBeUndefined();
  });
});

describe("adaptador de Anthropic: la lectura", () => {
  const pedir = async (diagnostics: unknown, previo: string | null = "msg_01") => {
    const { fetchImpl } = capturador(MENSAJE(diagnostics));
    return new AnthropicProvider({ fetchImpl }).generate({ ...REQ, cacheDiagnostics: { previousMessageId: previo } });
  };

  it("las tres formas de la documentación, y el id de la respuesta", async () => {
    const r = await pedir({ cache_miss_reason: { type: "system_changed", cache_missed_input_tokens: 41850 } });
    expect(r.providerMessageId).toBe("msg_02");
    expect(r.cacheDiagnostics).toEqual({ missReason: "system_changed", missedInputTokens: 41850 });
    expect((await pedir(null)).cacheDiagnostics).toEqual({ missReason: "none" });
    expect((await pedir({ cache_miss_reason: null })).cacheDiagnostics).toEqual({ missReason: "pending" });
    expect((await pedir({ cache_miss_reason: { type: "previous_message_not_found" } })).cacheDiagnostics).toEqual({
      missReason: "previous_message_not_found",
    });
  });

  it("sin comparación pedida, `diagnostics: null` NO se lee como «sin divergencia»", async () => {
    expect((await pedir(null, null)).cacheDiagnostics).toBeUndefined();
    const { fetchImpl } = capturador(MENSAJE(null));
    expect((await new AnthropicProvider({ fetchImpl }).generate(REQ)).cacheDiagnostics).toBeUndefined();
  });

  it("en stream llega en `message_start`", async () => {
    const eventos = [
      ["message_start", { type: "message_start", message: { id: "msg_09", usage: { input_tokens: 10, output_tokens: 1 }, diagnostics: { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 5 } } } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hola" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    const sse = eventos.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const { fetchImpl } = capturador(sse, "text/event-stream");
    let final: unknown;
    for await (const ev of new AnthropicProvider({ fetchImpl }).generateStream!({ ...REQ, cacheDiagnostics: { previousMessageId: "msg_01" } })) {
      if (ev.type === "done") final = ev.response;
    }
    expect(final).toMatchObject({ providerMessageId: "msg_09", cacheDiagnostics: { missReason: "tools_changed", missedInputTokens: 5 } });
  });
});

describe("el colocador publica por qué no llegó una lectura que predijo", () => {
  /**
   * El simulador de la caché de Anthropic, con dos añadidos de la API real: un
   * `id` por respuesta y, cuando la petición pide comparar, un diagnóstico.
   * Aquí el proveedor «no lee» más allá del primer bloque (un cable que cambia
   * bytes que el espejo no ve), y el diagnóstico dice `messages_changed`.
   */
  function simuladorConDiagnostico(sim: CacheAnthropicSimulada) {
    let n = 0;
    const cuerpos: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: unknown, init: { body: string }) => {
      const cuerpo = JSON.parse(init.body) as Record<string, unknown>;
      cuerpos.push(cuerpo);
      const r = (await (sim.fetch as unknown as (u: unknown, i: { body: string }) => Promise<Response>)(url, init)) as Response;
      const json = (await r.json()) as Record<string, unknown>;
      const previo = (cuerpo["diagnostics"] as { previous_message_id?: string | null } | undefined)?.previous_message_id;
      const diagnostics = previo ? { cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 1234 } } : null;
      return new Response(JSON.stringify({ ...json, id: `msg_${++n}`, diagnostics }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, cuerpos };
  }

  async function correr(diagnosticar: boolean, conAlmacen = false) {
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    sim.leerSoloHastaBloque = 1;
    const { fetchImpl, cuerpos } = simuladorConDiagnostico(sim);
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl }),
      cacheBreakpoints: "auto",
      ...(diagnosticar ? { cacheMissDiagnostics: true } : {}),
      ...(conAlmacen ? { cacheBreakpointStore: new InMemoryCacheBreakpointStore({ now: r.ahora }) } : {}),
      now: r.ahora,
      silenceWarnings: true,
    });
    const informes: SavingsResult<unknown>["report"][] = [];
    const orig = layer.generate.bind(layer);
    (layer as { generate: typeof layer.generate }).generate = (async (req) => {
      const x = await orig(req);
      informes.push(x.report);
      return x;
    }) as typeof layer.generate;
    await agente(layer, r, { runs: 2, pasos: 10, huecoMs: 4000, entreRuns: 30_000, resultadoChars: 200 });
    const verificadas = informes.flatMap((i) => i.traces.filter((t) => t.stage === "prefix-cache-placement" && t.outcome === "verified"));
    return { cuerpos, verificadas };
  }

  it("⛔ apagado (el defecto): ningún cuerpo lleva `diagnostics` y la traza no inventa motivos", async () => {
    const { cuerpos, verificadas } = await correr(false);
    expect(cuerpos.some((c) => "diagnostics" in c)).toBe(false);
    expect(verificadas.length).toBeGreaterThan(0);
    expect(verificadas.some((t) => "cacheMissReason" in (t.detail ?? {}))).toBe(false);
  });

  for (const conAlmacen of [false, true]) {
    it(`encendido${conAlmacen ? " y con almacén" : ""}: cada petición marcada lleva el id de la que escribió la entrada predicha, y el fallo sale con su motivo`, async () => {
      const { cuerpos, verificadas } = await correr(true, conAlmacen);
      const conDiagnostico = cuerpos.filter((c) => "diagnostics" in c);
      expect(conDiagnostico.length).toBeGreaterThan(0);
      // La primera petición marcada no tiene con quién compararse.
      expect(conDiagnostico[0]!["diagnostics"]).toEqual({ previous_message_id: null });
      const ids = conDiagnostico
        .map((c) => (c["diagnostics"] as { previous_message_id: string | null }).previous_message_id)
        .filter((x): x is string => x != null);
      expect(ids.length).toBeGreaterThan(0);
      // Cada id apunta a una respuesta ANTERIOR (msg_<n> con n menor que la petición que lo lleva).
      for (const c of conDiagnostico) {
        const previo = (c["diagnostics"] as { previous_message_id: string | null }).previous_message_id;
        if (previo) expect(Number(previo.slice(4))).toBeLessThan(cuerpos.indexOf(c) + 1);
      }
      const fallidas = verificadas.filter((t) => t.detail?.["confirmed"] === false);
      expect(fallidas.length).toBeGreaterThan(0);
      for (const t of fallidas) {
        expect(t.detail?.["cacheMissReason"]).toBe("messages_changed");
        expect(t.detail?.["cacheMissedInputTokensEstimate"]).toBe(1234);
      }
      // Una lectura confirmada no lleva motivo.
      expect(verificadas.filter((t) => t.detail?.["confirmed"] === true).every((t) => !("cacheMissReason" in (t.detail ?? {})))).toBe(true);
    });
  }
});
