import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { BatchJob } from "../src/contracts/batch.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * LAS PALANCAS DENTRO DEL LOTE, primer incremento: la compactación de la cola.
 *
 * `layer.batches.submit()` compacta los `role: "tool"` con la MISMA función pura
 * que `generate()` (opt-in, sin tocar el prefijo), de modo que un ítem del lote
 * paga el 50 % del Batch API sobre MENOS tokens. Se fija: con la palanca
 * encendida el cuerpo enviado lleva el tool_result compactado; sin ella, tal
 * cual; y el array del llamante no se muta.
 */

interface Llamada {
  url: string;
  method: string;
  json?: Record<string, unknown>;
}

function capa(conCompactacion: boolean | { profile: "lossless-data"; minSavedChars: number } | undefined) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const ruta = String(url).replace("https://api.anthropic.com/v1", "");
    llamadas.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      ...(typeof init.body === "string" ? { json: JSON.parse(init.body) as Record<string, unknown> } : {}),
    });
    if (String(init.method ?? "GET") === "POST" && ruta === "/messages/batches") {
      return new Response(JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const layer = createSavingsLayer({
    provider: new AnthropicProvider({ apiKey: "test-key", fetchImpl }),
    ...(conCompactacion !== undefined ? { toolOutputCompaction: conCompactacion } : {}),
  });
  return { llamadas, layer };
}

const INDENTADO = '{ "a": 1,   "b": 2, "c": [1,   2,  3] }';
const COMPACTO = '{"a":1,"b":2,"c":[1,2,3]}';

function peticionConHerramienta(): SavingsRequest {
  return {
    model: "anthropic/claude-haiku-4-5",
    messages: [
      { role: "system", content: "You label tickets." },
      { role: "tool", toolCallId: "tc_1", content: INDENTADO },
      { role: "user", content: "clasifica" },
    ],
  } as SavingsRequest;
}

/** Todos los textos de contenido (bloques text y tool_result) del cuerpo enviado. */
function textosDelCuerpo(reqs: { custom_id: string; params: Record<string, unknown> }[]): string[] {
  const textos: string[] = [];
  const andar = (v: unknown): void => {
    if (typeof v === "string") textos.push(v);
    else if (Array.isArray(v)) v.forEach(andar);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(andar);
  };
  andar(reqs[0]!.params);
  return textos;
}

function envio(l: { llamadas: Llamada[] }): { custom_id: string; params: Record<string, unknown> }[] {
  const ll = l.llamadas.find((x) => x.method === "POST" && x.url.includes("/messages/batches"))!;
  return ll.json!["requests"] as { custom_id: string; params: Record<string, unknown> }[];
}

const CON = { profile: "lossless-data" as const, minSavedChars: 1 };

describe("lotes · compactación de la cola (palancas dentro del lote)", () => {
  it("con la palanca encendida, el lote envía el tool_result compactado", async () => {
    const c = capa(CON);
    await c.layer.batches.submit([{ customId: "a", request: peticionConHerramienta() }]);
    const textos = textosDelCuerpo(envio(c));
    expect(textos).toContain(COMPACTO);
    expect(textos).not.toContain(INDENTADO);
  });

  it("sin palanca se envía tal cual (comportamiento de siempre)", async () => {
    const c = capa(undefined);
    await c.layer.batches.submit([{ customId: "a", request: peticionConHerramienta() }]);
    const textos = textosDelCuerpo(envio(c));
    expect(textos).toContain(INDENTADO);
    expect(textos).not.toContain(COMPACTO);
  });

  it("la petición puede APAGARLA con savings.toolOutputCompaction: false", async () => {
    const c = capa(CON);
    await c.layer.batches.submit([
      { customId: "a", request: { ...peticionConHerramienta(), savings: { toolOutputCompaction: false } } },
    ]);
    const textos = textosDelCuerpo(envio(c));
    expect(textos).toContain(INDENTADO);
  });

  it("la petición puede encenderla sola con savings.toolOutputCompaction: true", async () => {
    const c = capa(CON);
    await c.layer.batches.submit([
      { customId: "a", request: { ...peticionConHerramienta(), savings: { toolOutputCompaction: true } } },
    ]);
    const textos = textosDelCuerpo(envio(c));
    expect(textos).toContain(COMPACTO);
  });

  it("no muta los mensajes del llamante", async () => {
    const c = capa(CON);
    const request = peticionConHerramienta();
    const original = JSON.stringify(request.messages);
    await c.layer.batches.submit([{ customId: "a", request }]);
    expect(JSON.stringify(request.messages)).toBe(original);
  });

  it("el trabajo devuelto sigue siendo JSON plano, sin prompts ni respuestas", async () => {
    const c = capa(CON);
    const job = (await c.layer.batches.submit([{ customId: "a", request: peticionConHerramienta() }])) as BatchJob;
    expect(JSON.stringify(job)).not.toContain('"a": 1');
    expect(job.requests[0]).toEqual({ customId: "a", model: "anthropic/claude-haiku-4-5", batch: 0 });
  });
});
