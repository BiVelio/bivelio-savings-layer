import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import {
  atestadoDelCable,
  atestiguar,
  heredarAtestado,
} from "../src/providers/atestado-del-cable.js";
import { precioDeLista } from "../src/pricing/catalogo.js";
import {
  motivoSinSalida,
  registroDeReferencia,
  type HechosDeLaPoblada,
} from "../src/pipeline/referencia.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { Provider, ProviderResponse, ProviderStreamEvent } from "../src/providers/types.js";
import type { JsonSchema, SavingsRequest, SavingsResult } from "../src/contracts/types.js";

/**
 * MEDIDO POR REFERENCIA, REGLA v2 — contra los adaptadores DE VERDAD.
 *
 * Aquí no se firma nada a mano: el cuerpo HTTP lo arma el adaptador real
 * (Chat Completions o Mensajes) y el `fetch` falso solo contesta. Así lo que se
 * prueba es lo que viaja por el cable y lo que el proveedor cobraría por ello.
 *
 * Dos decisiones:
 *
 *   (a) E5 AMPLIADA. Con la configuración por defecto (sin `constraintBackends`)
 *       el tráfico con esquema deja referencia cuando el proveedor confirma que
 *       lo impuso y el adaptador atestigua que viajó TAL CUAL en su parámetro
 *       nativo. Nunca se acredita un token que puso la capa: ni la instrucción
 *       de JSON por prompt, ni la pista de límites, ni la herramienta de
 *       contrato de Anthropic, ni el turno «(continue)»; el envoltorio de
 *       `response_format` se descuenta con el margen de una pieza.
 *   (b) GUARDA DE RAZONAMIENTO. Ni un token de salida si el modelo razona, si el
 *       contador declaró razonamiento o si no dijo cuánto. La entrada sí.
 */

const DIA = 24 * 60 * 60 * 1000;
const MINI = "openai/gpt-4o-mini"; // catálogo: cacheada 0,000075 · salida 0,0006
const PREGUNTA = "What is the capital of France?";

const CONTRATO: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

/** Un `fetch` que contesta en orden y guarda cada cuerpo que le mandan. */
function servidor(respuestas: Array<{ estado?: number; cuerpo: unknown }>) {
  const enviados: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const r = respuestas[Math.min(i++, respuestas.length - 1)]!;
    return new Response(typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo), {
      status: r.estado ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

/** Una completion de Chat Completions con el `usage` que se le pida. */
const completion = (content: string, usage: Record<string, unknown>) => ({
  cuerpo: {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  },
});

const USO_OPENAI = (reasoning?: number | null) => ({
  prompt_tokens: 1736,
  completion_tokens: 282,
  ...(reasoning === null || reasoning === undefined
    ? {}
    : { completion_tokens_details: { reasoning_tokens: reasoning } }),
});

function montar(provider: Provider, extra: Partial<SavingsLayerConfig> = {}) {
  let n = 0;
  const reloj = { t: 1_780_000_000_000 };
  const layer = createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    now: () => reloj.t,
    exactCache: new InMemoryExactCache({ now: () => reloj.t }),
    exactCacheTtlMs: 60 * DIA,
    ...extra,
  });
  return { layer, reloj };
}

const openai = (fetchImpl: typeof fetch) =>
  new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl });
const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ fetchImpl });

const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: MINI,
  messages: [{ role: "user", content: PREGUNTA }],
  ...extra,
});

const trazaDeReferencia = (r: SavingsResult) => r.report.traces.find((t) => t.stage === "reference");
const trazaDelAcierto = (r: SavingsResult) => r.report.traces.find((t) => t.stage === "exact-cache");

// ─────────────────────────────────────────────────────────────────────────────
// (a) E5 ampliada
// ─────────────────────────────────────────────────────────────────────────────

describe("(a) E5 v2 · el esquema nativo y tal cual deja referencia, con la configuración por defecto", () => {
  it("Chat Completions: el esquema viaja en response_format y los mensajes salen intactos → referencia", async () => {
    const s = servidor([completion('{"answer":"Paris"}', USO_OPENAI(0))]);
    // SIN `constraintBackends`: el backend planeado es `none`. En la v1 esto no
    // dejaba nunca referencia; ahora manda lo que pasó en el cable.
    const { layer } = montar(openai(s.fetchImpl));
    const req = peticion({ temperature: 0, response: { contractId: "a:v1", schema: CONTRATO } });

    const primera = await layer.generate(req);
    // Lo que salió: los mensajes del cliente, byte a byte, sin instrucción de
    // la capa; y su esquema, tal cual, dentro de `response_format`.
    expect(s.enviados).toHaveLength(1);
    expect(s.enviados[0]!["messages"]).toEqual([{ role: "user", content: PREGUNTA }]);
    const rf = s.enviados[0]!["response_format"] as { type: string; json_schema: { schema: unknown } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.schema).toEqual(CONTRATO);
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    // El envoltorio de `response_format` (su nombre) cuenta como una pieza.
    expect(trazaDeReferencia(primera)?.detail?.["layerInsertions"]).toBe(1);
    expect(trazaDeReferencia(primera)?.detail?.["reasoningTokens"]).toBe(0);

    const hit = await layer.generate(req);
    expect(s.enviados).toHaveLength(1);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.inputTokens).toBe(1736);
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(1736 - 8);
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(Math.floor(0.95 * 282));
    expect(hit.report.cost.baselineEstimate).toBeCloseTo(
      ((1736 - 8) * 0.000075 + 267 * 0.0006) / 1000,
      10,
    );
  });

  it("un modelo que rechaza response_format: el adaptador pide el JSON por prompt → schema-in-prompt, nada acreditado", async () => {
    const s = servidor([
      {
        estado: 400,
        cuerpo: {
          error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." },
        },
      },
      completion('{"answer":"Paris"}', USO_OPENAI(0)),
    ]);
    const { layer } = montar(openai(s.fetchImpl));
    const req = peticion({ temperature: 0, response: { contractId: "a:v1", schema: CONTRATO } });
    const primera = await layer.generate(req);

    // La llamada que se cobró llevaba un mensaje de sistema que el cliente no
    // escribió: la instrucción de JSON con el esquema dentro.
    const cobrada = s.enviados[1]!;
    expect(cobrada["response_format"]).toBeUndefined();
    const mensajes = cobrada["messages"] as Array<{ role: string; content: string }>;
    expect(mensajes).toHaveLength(2);
    expect(mensajes[1]!.role).toBe("system");
    expect(mensajes[1]!.content).toContain("JSON Schema");
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "schema-in-prompt" });

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("la pista de límites que añade la capa: layer-changed-request, nunca acreditada", async () => {
    const LIMITADO: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", maxLength: 10 } },
    };
    const s = servidor([
      // 1ª petición: el proveedor impone la FORMA pero no `maxLength`…
      completion('{"answer":"Paris is the capital of France"}', USO_OPENAI(0)),
      // …la capa repara (una vez) y aprende que este contrato se incumple.
      completion('{"answer":"Paris"}', { prompt_tokens: 90, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 0 } }),
      // 2ª petición, con la pista de límites delante de la pregunta.
      completion('{"answer":"Rome"}', USO_OPENAI(0)),
    ]);
    const { layer } = montar(openai(s.fetchImpl));
    const contrato = { contractId: "limite:v1", schema: LIMITADO };
    await layer.generate(peticion({ temperature: 0, response: contrato }));

    const otra = peticion({
      temperature: 0,
      messages: [{ role: "user", content: "What is the capital of Italy?" }],
      response: contrato,
    });
    const segunda = await layer.generate(otra);
    const mensajes = s.enviados[2]!["messages"] as Array<{ role: string; content: string }>;
    expect(mensajes.some((m) => m.role === "system" && m.content.startsWith("JSON limits"))).toBe(true);
    expect(trazaDeReferencia(segunda)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(segunda)?.detail).toEqual({ reason: "layer-changed-request" });

    const hit = await layer.generate(otra);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("Anthropic: el contrato viaja como herramienta escrita por el adaptador → schema-not-verbatim", async () => {
    const s = servidor([
      {
        cuerpo: {
          content: [{ type: "tool_use", id: "t1", name: "bvsala_contract", input: { answer: "Paris" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 700, output_tokens: 40 },
        },
      },
    ]);
    const { layer } = montar(anthropic(s.fetchImpl));
    const req = peticion({
      model: "anthropic/claude-haiku-4-5",
      temperature: 0,
      response: { contractId: "a:v1", schema: CONTRATO },
    });
    const primera = await layer.generate(req);
    // Nativo sí (herramienta forzada y strict)…
    expect(s.enviados[0]!["tool_choice"]).toEqual({ type: "tool", name: "bvsala_contract" });
    // …pero la herramienta, su descripción y el prompt de herramientas que el
    // proveedor cobra con ella los puso la capa.
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "schema-not-verbatim" });

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("un proveedor de terceros que dice structuredNatively: true no puede atestiguar el cable → schema-not-verbatim", async () => {
    const provider: Provider = {
      id: "terceros",
      async generate(): Promise<ProviderResponse> {
        return {
          text: '{"answer":"Paris"}',
          usage: { inputTokens: 1736, outputTokens: 282, reasoningTokens: 0 },
          structuredNatively: true,
        };
      },
    };
    const { layer } = montar(provider);
    const req = peticion({ temperature: 0, response: { contractId: "a:v1", schema: CONTRATO } });
    const primera = await layer.generate(req);
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "schema-not-verbatim" });
    const hit = await layer.generate(req);
    expect(hit.report.cost.basis).toBe("estimated");
  });

  it("Anthropic sin esquema: el turno «(continue)» que antepone el adaptador se descuenta como una pieza", async () => {
    const s = servidor([
      {
        cuerpo: {
          content: [{ type: "text", text: "Paris." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 300, output_tokens: 20 },
        },
      },
    ]);
    const { layer } = montar(anthropic(s.fetchImpl));
    const req = peticion({
      model: "anthropic/claude-haiku-4-5",
      temperature: 0,
      messages: [
        { role: "assistant", content: "I can answer geography questions." },
        { role: "user", content: PREGUNTA },
      ],
    });
    const primera = await layer.generate(req);
    const mensajes = s.enviados[0]!["messages"] as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(mensajes[0]!.role).toBe("user");
    expect(mensajes[0]!.content[0]!.text).toBe("(continue)");
    expect(trazaDeReferencia(primera)?.detail?.["layerInsertions"]).toBe(1);

    const hit = await layer.generate(req);
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(300 - 8);
    // Sin bloque de razonamiento el adaptador declara 0, y Claude no razona sin
    // pedírselo: la salida cuenta.
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(19);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Guarda de razonamiento
// ─────────────────────────────────────────────────────────────────────────────

describe("(b) la guarda de razonamiento: sin un 0 declarado, ni un token de salida", () => {
  for (const [nombre, reasoning, motivo] of [
    ["el contador no desglosa el razonamiento", null, "reasoning-not-reported"],
    ["el contador declara razonamiento", 40, "reasoning-reported"],
  ] as const) {
    it(`${nombre} → la entrada se acredita, la salida no (${motivo})`, async () => {
      const s = servidor([completion("Paris is the capital of France.", USO_OPENAI(reasoning))]);
      const { layer } = montar(openai(s.fetchImpl));
      await layer.generate(peticion({ temperature: 0 }));
      const hit = await layer.generate(peticion({ temperature: 0 }));
      expect(hit.report.cost.basis).toBe("reference");
      expect(hit.report.cache.reference?.creditedInputTokens).toBe(1736);
      expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
      expect(hit.report.tokens.baselineOutput).toBe(0);
      expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBe(motivo);
    });
  }

  it("un 0 declarado junto a texto de razonamiento (reasoning_content) no es un 0", async () => {
    const s = servidor([
      {
        cuerpo: {
          choices: [
            {
              message: { role: "assistant", content: "Paris.", reasoning_content: "The user asks about France…" },
              finish_reason: "stop",
            },
          ],
          usage: USO_OPENAI(0),
        },
      },
    ]);
    const { layer } = montar(openai(s.fetchImpl));
    await layer.generate(peticion({ temperature: 0 }));
    const hit = await layer.generate(peticion({ temperature: 0 }));
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBe("reasoning-not-reported");
  });

  it("un modelo de razonamiento del catálogo: ni temperature 0 ni un contador a 0 acreditan salida", async () => {
    // Una pasarela que deja pasar `temperature: 0` hacia gpt-5-mini (que solo
    // admite el valor por defecto) y un contador que dice 0: la salida sigue
    // sin contar, porque el modelo no garantiza repetirla.
    const s = servidor([completion("Paris is the capital of France.", USO_OPENAI(0))]);
    const { layer } = montar(openai(s.fetchImpl));
    const req = peticion({ model: "openai/gpt-5-mini", temperature: 0 });
    await layer.generate(req);
    const hit = await layer.generate(req);
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(1736);
    expect(hit.report.cache.reference?.cachedInputPer1k).toBe(precioDeLista("gpt-5-mini")!.cachedInputPer1k);
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBe("reasoning-model");
  });

  it("con el contador a 0 y un modelo que no razona, la salida cuenta como en la v1", async () => {
    const s = servidor([completion("Paris is the capital of France.", USO_OPENAI(0))]);
    const { layer } = montar(openai(s.fetchImpl));
    await layer.generate(peticion({ temperature: 0 }));
    const hit = await layer.generate(peticion({ temperature: 0 }));
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(267);
    expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBeUndefined();
  });

  it("Anthropic con un bloque de razonamiento: el adaptador no declara 0 y la salida no cuenta", async () => {
    const s = servidor([
      {
        cuerpo: {
          content: [
            { type: "thinking", thinking: "France… capital…", signature: "sig" },
            { type: "text", text: "Paris." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 300, output_tokens: 180 },
        },
      },
    ]);
    const { layer } = montar(anthropic(s.fetchImpl));
    const req = peticion({ model: "anthropic/claude-haiku-4-5", temperature: 0 });
    await layer.generate(req);
    const hit = await layer.generate(req);
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(300);
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBe("reasoning-not-reported");
  });

  it("sin temperature 0 el motivo sigue siendo el muestreo", async () => {
    const s = servidor([completion("Paris is the capital of France.", USO_OPENAI(0))]);
    const { layer } = montar(openai(s.fetchImpl));
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(trazaDelAcierto(hit)?.detail?.["outputNotCredited"]).toBe("sampled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lo que declaran los adaptadores, suelto
// ─────────────────────────────────────────────────────────────────────────────

async function recoger(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderResponse> {
  let final: ProviderResponse | undefined;
  for await (const e of it) if (e.type === "done") final = e.response;
  if (!final) throw new Error("sin done");
  return final;
}

const sse = (trozos: unknown[]): string => trozos.map((t) => `data: ${JSON.stringify(t)}\n\n`).join("") + "data: [DONE]\n\n";

function servidorSse(cuerpo: string) {
  return (async () =>
    new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

describe("los adaptadores declaran el razonamiento y atestiguan el cable", () => {
  const REQ = { model: "gpt-4o-mini", messages: [{ role: "user" as const, content: PREGUNTA }] };

  it("Chat Completions: reasoning_tokens pasa tal cual; ausente, no se inventa", async () => {
    for (const [reasoning, esperado] of [[0, 0], [12, 12], [null, undefined]] as const) {
      const s = servidor([completion("ok", USO_OPENAI(reasoning))]);
      const r = await openai(s.fetchImpl).generate(REQ);
      expect(r.usage.reasoningTokens).toBe(esperado);
      expect("reasoningTokens" in r.usage).toBe(esperado !== undefined);
    }
  });

  it("Chat Completions en stream: el chunk final de usage trae el 0; un delta de razonamiento lo anula", async () => {
    const uso = { prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } };
    const limpio = sse([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: uso },
    ]);
    const r1 = await recoger(openai(servidorSse(limpio)).generateStream!(REQ));
    expect(r1.usage.reasoningTokens).toBe(0);
    expect(atestadoDelCable(r1)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 0 });

    const conRazonamiento = sse([
      { choices: [{ delta: { reasoning_content: "pensando…" } }] },
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: uso },
    ]);
    const r2 = await recoger(openai(servidorSse(conRazonamiento)).generateStream!(REQ));
    expect(r2.usage.reasoningTokens).toBeUndefined();
  });

  it("Chat Completions: nativo → esquema tal cual y ningún mensaje; degradado → un mensaje del adaptador", async () => {
    const nativo = servidor([completion('{"answer":"x"}', USO_OPENAI(0))]);
    const r1 = await openai(nativo.fetchImpl).generate({ ...REQ, schema: CONTRATO });
    expect(r1.structuredNatively).toBe(true);
    expect(atestadoDelCable(r1)).toEqual({ esquemaEnFormatoNativo: true, mensajesDelAdaptador: 0 });

    const degradado = servidor([
      { estado: 400, cuerpo: "Unrecognized request argument supplied: response_format" },
      completion('{"answer":"x"}', USO_OPENAI(0)),
    ]);
    const r2 = await openai(degradado.fetchImpl).generate({ ...REQ, schema: CONTRATO });
    expect(r2.structuredNatively).toBe(false);
    expect(atestadoDelCable(r2)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 1 });

    const sinEsquema = servidor([completion("ok", USO_OPENAI(0))]);
    const r3 = await openai(sinEsquema.fetchImpl).generate(REQ);
    expect(atestadoDelCable(r3)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 0 });
  });

  it("Anthropic: sin bloque de razonamiento declara 0; con él (también en stream), no dice nada", async () => {
    const texto = servidor([
      { cuerpo: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    const r1 = await anthropic(texto.fetchImpl).generate(REQ);
    expect(r1.usage.reasoningTokens).toBe(0);
    expect(atestadoDelCable(r1)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 0 });

    const redactado = servidor([
      {
        cuerpo: {
          content: [{ type: "redacted_thinking", data: "…" }, { type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 90 },
        },
      },
    ]);
    const r2 = await anthropic(redactado.fetchImpl).generate(REQ);
    expect("reasoningTokens" in r2.usage).toBe(false);

    const ev = (tipo: string, data: Record<string, unknown>): string =>
      `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
    const stream =
      ev("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }) +
      ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "ok" } }) +
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 60 } }) +
      ev("message_stop", {});
    const r3 = await recoger(anthropic(servidorSse(stream)).generateStream!(REQ));
    expect(r3.text).toBe("ok");
    expect("reasoningTokens" in r3.usage).toBe(false);
  });

  it("Anthropic: la herramienta de contrato es nativa pero no tal cual; el «(continue)» es un mensaje del adaptador", async () => {
    const contrato = servidor([
      {
        cuerpo: {
          content: [{ type: "tool_use", id: "t", name: "bvsala_contract", input: { answer: "x" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ]);
    const r1 = await anthropic(contrato.fetchImpl).generate({ ...REQ, schema: CONTRATO });
    expect(r1.structuredNatively).toBe(true);
    expect(atestadoDelCable(r1)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 0 });

    const turno = servidor([
      { cuerpo: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    const r2 = await anthropic(turno.fetchImpl).generate({
      ...REQ,
      messages: [{ role: "assistant", content: "hola" }, ...REQ.messages],
    });
    expect(atestadoDelCable(r2)).toEqual({ esquemaEnFormatoNativo: false, mensajesDelAdaptador: 1 });
  });

  it("un objeto que ningún adaptador propio firmó no tiene atestado; una copia rehecha lo hereda", () => {
    const r: ProviderResponse = { text: "x", usage: { inputTokens: 1, outputTokens: 1 } };
    expect(atestadoDelCable(r)).toBeUndefined();
    atestiguar(r, { esquemaEnFormatoNativo: true, mensajesDelAdaptador: 0 });
    const copia = heredarAtestado(r, { ...r, text: "y" });
    expect(atestadoDelCable(copia)).toEqual({ esquemaEnFormatoNativo: true, mensajesDelAdaptador: 0 });
    expect(atestadoDelCable({ ...r })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Las reglas puras de la v2
// ─────────────────────────────────────────────────────────────────────────────

describe("E5 v2 y las piezas de la capa, como reglas puras", () => {
  const HECHOS = {
    contadorSimulado: false,
    usoPrimario: { inputTokens: 500, outputTokens: 300, reasoningTokens: 0 },
    eliminatedInput: 0,
    compressedInput: 0,
    elididoLocal: 0,
    sentLocalSinSondeo: 40,
    baselineInput: 40,
    codebookAplicado: false,
    tokensDelSondeo: 0,
    sondeoAplicado: false,
    hayEsquema: true,
    esquemaNativo: true,
    esquemaEnFormatoNativo: true,
    mensajesDelAdaptador: 0,
    modeloPedido: MINI,
    modeloServido: MINI,
    cacheable: true,
    mensajesDeLaCapa: 0,
    requestId: "req-poblada",
    at: 1_000,
    textoServido: '{"answer":"ok"}',
    huella: () => "huella",
  } satisfies HechosDeLaPoblada;

  it("sin la confirmación del proveedor: schema-in-prompt; confirmado pero sin atestado: schema-not-verbatim", () => {
    expect(registroDeReferencia({ ...HECHOS, esquemaNativo: false })).toBe("schema-in-prompt");
    expect(registroDeReferencia({ ...HECHOS, esquemaNativo: false, esquemaEnFormatoNativo: true })).toBe(
      "schema-in-prompt",
    );
    expect(registroDeReferencia({ ...HECHOS, esquemaEnFormatoNativo: false })).toBe("schema-not-verbatim");
    // Sin esquema, ninguna de las dos preguntas aplica.
    const sinEsquema = registroDeReferencia({
      ...HECHOS,
      hayEsquema: false,
      esquemaNativo: false,
      esquemaEnFormatoNativo: false,
    });
    expect(typeof sinEsquema).toBe("object");
  });

  it("las piezas se suman: mensaje de datos + mensaje del adaptador + envoltorio del esquema", () => {
    const r = registroDeReferencia({ ...HECHOS, mensajesDeLaCapa: 1, mensajesDelAdaptador: 1 });
    if (typeof r !== "object") throw new Error(r);
    expect(r.v).toBe(2);
    expect(r.layerInsertions).toBe(3);
    const sinEsquema = registroDeReferencia({ ...HECHOS, hayEsquema: false });
    if (typeof sinEsquema !== "object") throw new Error(sinEsquema);
    expect(sinEsquema.layerInsertions).toBe(0);
  });

  it("el razonamiento del registro: la suma si los dos lo dicen; ausente si alguno calla", () => {
    const conReparacion = registroDeReferencia({
      ...HECHOS,
      usoReparacion: { inputTokens: 700, outputTokens: 120, reasoningTokens: 0 },
    });
    if (typeof conReparacion !== "object") throw new Error(conReparacion);
    expect(conReparacion.reasoningTokens).toBe(0);

    const reparacionCallada = registroDeReferencia({
      ...HECHOS,
      usoReparacion: { inputTokens: 700, outputTokens: 120 },
    });
    if (typeof reparacionCallada !== "object") throw new Error(reparacionCallada);
    expect("reasoningTokens" in reparacionCallada).toBe(false);

    const primariaCallada = registroDeReferencia({ ...HECHOS, usoPrimario: { inputTokens: 500, outputTokens: 300 } });
    if (typeof primariaCallada !== "object") throw new Error(primariaCallada);
    expect("reasoningTokens" in primariaCallada).toBe(false);
  });

  it("motivoSinSalida: el orden de los motivos", () => {
    expect(motivoSinSalida({ reasoningTokens: 0 }, { determinista: false, modeloRazona: true })).toBe("sampled");
    expect(motivoSinSalida({ reasoningTokens: 0 }, { determinista: true, modeloRazona: true })).toBe("reasoning-model");
    expect(motivoSinSalida({}, { determinista: true, modeloRazona: false })).toBe("reasoning-not-reported");
    expect(motivoSinSalida({ reasoningTokens: 3 }, { determinista: true, modeloRazona: false })).toBe(
      "reasoning-reported",
    );
    expect(motivoSinSalida({ reasoningTokens: 0 }, { determinista: true, modeloRazona: false })).toBeUndefined();
  });
});
