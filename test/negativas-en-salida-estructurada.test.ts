import { describe, expect, it } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { negativaEnTexto } from "../src/providers/negativa-en-texto.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";

/**
 * E7-octies · LA NEGATIVA DENTRO DE UNA SALIDA ESTRUCTURADA (2026-09-30).
 *
 * Buscando en vivo una negativa `message.refusal` de OpenAI (criterio 3 de
 * docs/CAMINO-A-0.5.md), gpt-4o-mini con un contrato de salida estricto NO usó
 * `message.refusal`: escribió la negativa dentro del JSON. La capa la guardó y
 * la repitió `reference` (acreditada). Los textos de abajo son REALES, de esa
 * sonda (Structured Outputs, `response_format: json_schema` estricto).
 */

const REALES = [
  '{"steps":["This request cannot be fulfilled as it involves illegal activities and poses significant health and safety risks."],"materials":[]}',
  '{"steps":["I\'m sorry, but I cannot assist with that."],"materials":["This request is inappropriate and illegal."]}',
  '{"steps":["This request involves illegal activities and is against OpenAI\'s use case policy. I cannot provide assistance or information on synthesizing illegal substances."],"materials":[]}',
  '{"steps":["This request is inappropriate and illegal. It is important to protect the well-being of minors and to adhere to laws regarding child protection.","If you or someone you know is struggling with inappropriate thoughts or behaviors, please reach out to a mental health professional for help."],"materials":[]}',
];

/** Salidas estructuradas normales: se siguen cacheando. */
const CONTROLES = [
  '{"answer":"42","reasoning":"6 x 7 = 42"}',
  '{"steps":["Preheat the oven to 180C.","Mix flour and sugar."],"materials":["flour","sugar"]}',
  '{"error":"The file cannot be opened because it is locked."}',
  '{"summary":"I can\'t wait to see the results of this migration!"}',
  '{"title":"Why this request is slow","body":"The query scans the whole table."}',
  '[{"name":"retry","value":3},{"name":"note","value":"We cannot write to s[0] because strings are immutable."}]',
];

describe("E7-octies · negativaEnTexto ve la negativa dentro de un JSON", () => {
  for (const [i, t] of REALES.entries()) {
    it(`gpt-4o-mini, salida estructurada real ${i + 1} (la 1 y la 4 se escapaban en main)`, () => {
      expect(negativaEnTexto(t)).not.toBeNull();
    });
  }

  it("⛔ la forma impersonal: «this request cannot be fulfilled / is illegal» (y en español)", () => {
    expect(negativaEnTexto("This request cannot be fulfilled as it involves illegal activities.")).not.toBeNull();
    expect(negativaEnTexto("This request is inappropriate and illegal. It is important to protect minors.")).not.toBeNull();
    expect(negativaEnTexto("Esta solicitud no se puede atender porque implica actividades ilegales.")).not.toBeNull();
  });

  it("⛔ la lectura del JSON decide cuando la negativa abre un CAMPO largo, no el texto", () => {
    // «I won't argue…» solo es negativa AL PRINCIPIO (regla general); dentro de un
    // JSON largo, la prosa no lo ve: lo ve la regla de la salida estructurada.
    const relleno = "Background paragraph that answers nothing in particular and pads the output. ".repeat(6);
    const t = JSON.stringify({ context: relleno, reply: "I won't argue that position; it rests on a false premise." });
    expect(negativaEnTexto(t)).toBe("refusal-in-structured-output");
  });

  it("control: las salidas estructuradas normales no son negativas", () => {
    for (const t of CONTROLES) expect(negativaEnTexto(t), t).toBeNull();
  });

  it("un JSON enorme o que no se puede leer no se recorre (y no lanza)", () => {
    expect(negativaEnTexto(`{"a":"${"x".repeat(50_000)}"}`)).toBeNull();
    // Un JSON roto se lee como prosa: la negativa se sigue viendo.
    expect(negativaEnTexto('{"a": "I cannot assist with that."')).not.toBeNull();
  });
});

// ── De punta a punta: Chat Completions con contrato de salida ──────────────

function chat(texto: string) {
  const json = {
    id: "chatcmpl-json",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: texto, refusal: null }, logprobs: null, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  };
  return json;
}

function proveedor(texto: string) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(chat(texto)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

function capa(fetchImpl: typeof fetch) {
  let n = 0;
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl }),
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache: new InMemoryExactCache(),
  });
}

const peticion = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  temperature: 0,
  messages: [{ role: "user", content: "List the steps and the materials for the task." }],
  response: {
    contractId: "pasos:v1",
    schema: {
      type: "object",
      properties: { steps: { type: "array", items: { type: "string" } }, materials: { type: "array", items: { type: "string" } } },
      required: ["steps", "materials"],
      additionalProperties: false,
    },
  },
});
const trazaDe = (r: SavingsResult, etapa: string) => r.report.traces.filter((t) => t.stage === etapa);

describe("E7-octies · el SDK no guarda ni acredita la negativa dentro del JSON", () => {
  for (const [i, t] of REALES.entries()) {
    it(`real ${i + 1}: medida y servida, la repetición vuelve a llamar`, async () => {
      const s = proveedor(t);
      const layer = capa(s.fetchImpl);
      const primera = await layer.generate(peticion());
      expect(primera.report.cost.basis).toBe("measured");
      expect(trazaDe(primera, "reference")[0]).toMatchObject({ outcome: "not-written" });
      const segunda = await layer.generate(peticion());
      expect(s.enviados).toHaveLength(2);
      expect(segunda.report.cache.result).toBe("miss");
      expect(segunda.report.cache.reference).toBeUndefined();
    });
  }

  it("control: una salida estructurada normal se sigue cacheando", async () => {
    const s = proveedor(CONTROLES[1]!);
    const layer = capa(s.fetchImpl);
    await layer.generate(peticion());
    const segunda = await layer.generate(peticion());
    expect(s.enviados).toHaveLength(1);
    expect(segunda.report.cache.result).toBe("exact");
  });
});
