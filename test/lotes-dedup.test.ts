import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { BatchJob } from "../src/contracts/batch.js";

/**
 * DEDUP INTRA-LOTE (opt-in via `submit(…, { deduplicate: true })`): peticiones
 * cuyo cuerpo final es idéntico se envían UNA vez y el resto se replica desde el
 * resultado de la primera. Aquí se fija: el número de líneas enviadas, el mapa
 * `duplicates`, la clonación en results() y que el summary NO cuenta dos veces la
 * misma ejecución (el dinero se cuenta sobre lo enviado). Sin la opción, NO se
 * deduplica (comportamiento de siempre).
 */

const ANTHROPIC = "https://api.anthropic.com/v1";
const USO = {
  input_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 200,
  service_tier: "batch",
};

function linea(id: string, texto: string): unknown {
  return {
    custom_id: id,
    result: {
      type: "succeeded",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: texto }], stop_reason: "end_turn", usage: USO },
    },
  };
}

function capa(resultados: unknown[]) {
  const enviadas: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const ruta = String(url).replace(ANTHROPIC, "");
    const metodo = String(init.method ?? "GET");
    if (metodo === "POST" && ruta === "/messages/batches") {
      const json = JSON.parse(String(init.body)) as { requests: { custom_id: string }[] };
      enviadas.push(...json.requests.map((r) => r.custom_id));
      return new Response(JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (metodo === "GET" && ruta === "/messages/batches/msgbatch_1") {
      return new Response(
        JSON.stringify({ id: "msgbatch_1", processing_status: "ended", request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 }, results_url: "https://evil.example/results" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (metodo === "GET" && ruta === "/messages/batches/msgbatch_1/results") {
      const jsonl = resultados.map((l) => JSON.stringify(l)).join("\n") + "\n";
      return new Response(jsonl, { status: 200, headers: { "content-type": "application/x-jsonl" } });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const layer = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "k", fetchImpl }) });
  return { layer, enviadas };
}

const peticion = (texto: string) => ({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system" as const, content: "You label tickets." },
    { role: "user" as const, content: texto },
  ],
});

describe("lotes · dedup intra-lote (opt-in)", () => {
  it("con { deduplicate: true } envía una sola vez lo idéntico y guarda el mapa", async () => {
    const c = capa([linea("a", "billing"), linea("c", "other")]);
    const job = (await c.layer.batches.submit(
      [
        { customId: "a", request: peticion("ticket 1") },
        { customId: "b", request: peticion("ticket 1") },
        { customId: "c", request: peticion("ticket 2") },
      ],
      { deduplicate: true },
    )) as BatchJob;
    expect(c.enviadas).toEqual(["a", "c"]);
    expect(job.requests.map((r) => r.customId)).toEqual(["a", "c"]);
    expect(job.duplicates).toEqual([{ customId: "b", sameAs: "a", model: "claude-haiku-4-5" }]);
  });

  it("sin la opción (default) NO deduplica: lo idéntico se envía entero", async () => {
    const c = capa([linea("a", "billing"), linea("b", "billing")]);
    const job = (await c.layer.batches.submit([
      { customId: "a", request: peticion("ticket 1") },
      { customId: "b", request: peticion("ticket 1") },
    ])) as BatchJob;
    expect(c.enviadas).toEqual(["a", "b"]);
    expect(job.duplicates).toBeUndefined();
  });

  it("results() clona el duplicado desde su origen y no dobla el dinero", async () => {
    const c = capa([linea("a", "billing"), linea("c", "other")]);
    const job = (await c.layer.batches.submit(
      [
        { customId: "a", request: peticion("ticket 1") },
        { customId: "b", request: peticion("ticket 1") },
        { customId: "c", request: peticion("ticket 2") },
      ],
      { deduplicate: true },
    )) as BatchJob;
    const r = await c.layer.batches.results(job);

    expect(r.items.map((i) => i.customId).sort()).toEqual(["a", "b", "c"]);
    const duplicado = r.items.find((i) => i.customId === "b")!;
    expect(duplicado.text).toBe("billing");
    expect(duplicado.reason).toContain("deduplicated");
    expect(duplicado.tierSaving).toEqual(r.items.find((i) => i.customId === "a")!.tierSaving);

    expect(r.summary.requestCount).toBe(3);
    expect(r.summary.succeeded).toBe(3);
    expect(r.summary.deduplicated).toBe(1);
    // El dinero se cuenta sobre lo ENVIADO: dos ejecuciones, no tres.
    expect(r.summary.credited).toBe(2);
    const a = r.items.find((i) => i.customId === "a")!.tierSaving!.amount;
    const cc = r.items.find((i) => i.customId === "c")!.tierSaving!.amount;
    expect(r.summary.tierSaving).toBeCloseTo(a + cc, 9);
  });
});
