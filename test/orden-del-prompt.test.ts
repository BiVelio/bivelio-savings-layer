import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { Retriever } from "../src/retrieval/retrieval.js";

/**
 * NINGÚN BLOQUE QUE INYECTE LA CAPA PUEDE QUEDAR DETRÁS DE LA PREGUNTA.
 *
 * `pipeline.ts` documenta desde hace tiempo la medición que lo justifica —8
 * pares por variante sobre la tabla de 50 filas, cambiando SOLO la posición:
 *
 *   pregunta primero, datos al final   403 tokens de salida · trunca 4/8
 *   datos primero, pregunta al final   193 tokens          · trunca 0/8
 *
 * …y aun así solo el payload serializado la respetaba. La evidencia de
 * retrieval y el aviso de límites JSON entraban con `messages.push`, o sea en
 * la variante mala, y nada lo impedía porque ningún test miraba la POSICIÓN:
 * los que había (`binding-limit`, `adaptive-hints`) solo comprueban que el
 * bloque EXISTA con un `.find(...)`.
 *
 * Este fichero fija la posición, que es lo que de verdad cuesta dinero.
 */

class Espia implements Provider {
  readonly id = "espia";
  enviados: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(r);
    // La primera respuesta incumple `maxLength` para que el contrato "aprenda"
    // y la siguiente petición lleve el aviso de límites.
    const texto = this.enviados.length === 1
      ? JSON.stringify({ answer: "x".repeat(3000) })
      : JSON.stringify({ answer: "ok" });
    return { text: texto, finishReason: "stop", usage: { inputTokens: 80, outputTokens: 30 } };
  }
}

const recuperador: Retriever = {
  async retrieve() {
    return [
      { id: "doc-1", text: "El importe de la factura F-2024-118 es 12.480,55 EUR.", source: "F-2024-118" },
      { id: "doc-2", text: "El vencimiento acordado es el 30 de junio.", source: "contrato" },
    ];
  },
};

/** Índice del último mensaje del usuario: la frontera que nada debe cruzar. */
const finDeLaPregunta = (r: ProviderRequest): number =>
  r.messages.map((m) => m.role).lastIndexOf("user");

const indiceDe = (r: ProviderRequest, aguja: string): number =>
  r.messages.findIndex((m) => m.content.includes(aguja));

function peticion(extra: Record<string, unknown> = {}) {
  return {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system" as const, content: "Eres un asistente de facturación." },
      { role: "user" as const, content: "¿Cuánto se debe y cuándo vence?" },
    ],
    savings: { exactCache: false as const },
    ...extra,
  };
}

const CONTRATO = {
  contractId: "orden-del-prompt:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 40 } },
  },
  maxOutputTokens: 120,
};

describe("orden del prompt: lo estable delante, la pregunta al final", () => {
  it("la evidencia de retrieval va DELANTE de la pregunta, no detrás", async () => {
    const espia = new Espia();
    const capa = createSavingsLayer({ provider: espia, retriever: recuperador });

    await capa.generate(peticion({ retrieval: { mode: "single" as const } }));

    const enviado = espia.enviados[0]!;
    const evidencia = indiceDe(enviado, "Retrieved context");
    expect(evidencia).toBeGreaterThanOrEqual(0); // se proyectó de verdad
    expect(evidencia).toBeLessThan(finDeLaPregunta(enviado));
  });

  it("el aviso de límites JSON va DELANTE de la pregunta", async () => {
    const espia = new Espia();
    const capa = createSavingsLayer({ provider: espia });

    // La primera incumple el contrato; la segunda ya lleva el aviso.
    await capa.generate(peticion({ response: CONTRATO }));
    await capa.generate(peticion({ response: CONTRATO }));

    const conAviso = espia.enviados.find((r) => indiceDe(r, "JSON limits") >= 0);
    expect(conAviso, "ninguna petición llevó el aviso de límites").toBeDefined();
    expect(indiceDe(conAviso!, "JSON limits")).toBeLessThan(finDeLaPregunta(conAviso!));
  });

  it("los tres bloques van de más estable a más variable: límites · payload · evidencia", async () => {
    const espia = new Espia();
    const capa = createSavingsLayer({ provider: espia, retriever: recuperador });

    const req = () =>
      peticion({
        response: CONTRATO,
        retrieval: { mode: "single" as const },
        structuredData: [
          { id: 1, concepto: "servicio", importe: 100 },
          { id: 2, concepto: "soporte", importe: 50 },
        ],
      });

    await capa.generate(req());
    await capa.generate(req());

    const enviado = espia.enviados.find((r) => indiceDe(r, "JSON limits") >= 0)!;
    const limites = indiceDe(enviado, "JSON limits");
    const payload = indiceDe(enviado, "concepto");
    const evidencia = indiceDe(enviado, "Retrieved context");
    const pregunta = finDeLaPregunta(enviado);

    expect(payload).toBeGreaterThanOrEqual(0);
    // Lo que depende solo del contrato primero; lo que depende de esta consulta,
    // el último. Es lo que deja crecer el prefijo cacheable del proveedor.
    expect(limites).toBeLessThan(payload);
    expect(payload).toBeLessThan(evidencia);
    expect(evidencia).toBeLessThan(pregunta);
  });

  it("verja general: NINGÚN mensaje inyectado por la capa queda tras la pregunta", async () => {
    const espia = new Espia();
    const capa = createSavingsLayer({ provider: espia, retriever: recuperador });

    const req = () =>
      peticion({
        response: CONTRATO,
        retrieval: { mode: "single" as const },
        structuredData: [{ id: 1, importe: 100 }],
      });

    await capa.generate(req());
    await capa.generate(req());

    for (const enviado of espia.enviados) {
      const originales = new Set(peticion().messages.map((m) => m.content));
      const traseros = enviado.messages
        .slice(finDeLaPregunta(enviado) + 1)
        .filter((m) => !originales.has(m.content));
      expect(
        traseros.map((m) => m.content.slice(0, 60)),
        "un bloque de la capa quedó detrás de la pregunta: mide 403 tokens de salida en vez de 193",
      ).toEqual([]);
    }
  });

  it("sin mensaje de usuario no se pierde nada (se adjunta al final)", async () => {
    const espia = new Espia();
    const capa = createSavingsLayer({ provider: espia, retriever: recuperador });

    await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "system" as const, content: "Resume la evidencia adjunta." }],
      savings: { exactCache: false as const },
      retrieval: { mode: "single" as const },
    });

    expect(indiceDe(espia.enviados[0]!, "Retrieved context")).toBeGreaterThanOrEqual(0);
  });
});
