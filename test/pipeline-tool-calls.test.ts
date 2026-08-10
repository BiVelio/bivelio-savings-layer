import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { evaluatePolicy } from "../src/policy/policy.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * El arreglo del adaptador (content:null + tool_calls) moría una capa más
 * arriba: el pipeline construía la respuesta solo con `{text, data, rendered}`
 * y `SavingsResult` ni declaraba `toolCalls`, así que el cliente recibía cadena
 * vacía como si fuera la respuesta buena, la acción se perdía entera, el turno
 * se cacheaba 24 h y la repetición acreditaba 100 % de ahorro sobre una acción
 * que nunca se ejecutó. El test del adaptador afirmaba sobre provider.generate()
 * y no sobre layer.generate(), por eso los 428 tests pasaban igualmente.
 */

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

class ProveedorConHerramientas implements Provider {
  readonly id = "espia-tools";
  llamadas: ProviderRequest[] = [];
  constructor(private readonly respuesta: () => ProviderResponse) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas.push(r);
    return this.respuesta();
  }
}

const turnoDeHerramienta = (): ProviderResponse => ({
  text: "",
  usage: { inputTokens: 120, outputTokens: 18 },
  finishReason: "tool_calls",
  toolCalls: [{ id: "call_1", name: "send_invoice", arguments: '{"id":"F-2026-1"}' }],
});

const enviarFactura: ToolDescriptor = {
  id: "send_invoice",
  intents: ["send invoice"],
  risk: "write",
};

// Herramienta de LECTURA y texto sin marcadores de frescura/personalización:
// la única razón para no cachear este turno es que es una petición de acción.
const consultaCapital: ToolDescriptor = {
  id: "lookup_capital",
  intents: ["capital lookup"],
  risk: "read",
};

describe("las tool calls llegan al llamante (layer.generate, no solo el adaptador)", () => {
  it("propaga toolCalls y finishReason en el resultado público", async () => {
    const proveedor = new ProveedorConHerramientas(turnoDeHerramienta);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice to accounting" }],
      tools: [enviarFactura],
    });

    expect(res.toolCalls).toBeDefined();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]!.name).toBe("send_invoice");
    expect(res.toolCalls![0]!.arguments).toBe('{"id":"F-2026-1"}');
    expect(res.finishReason).toBe("tool_calls");
    expect(res.text).toBe("");
  });

  it("un turno de tool calls NO se cachea: la repetición vuelve al proveedor", async () => {
    const proveedor = new ProveedorConHerramientas(turnoDeHerramienta);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const peticion: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital of France lookup" }],
      tools: [consultaCapital],
    };
    const primera = await capa.generate(peticion);
    const segunda = await capa.generate(peticion);

    expect(primera.toolCalls).toHaveLength(1);
    // ANTES: la segunda salía de caché con "" y una llamada "100 % evitada".
    expect(proveedor.llamadas).toHaveLength(2);
    expect(segunda.report.cache.result).toBe("miss");
    expect(segunda.toolCalls).toHaveLength(1);
  });

  it("control: la misma petición con respuesta de TEXTO sí se cachea (la caché no quedó rota)", async () => {
    const proveedor = new ProveedorConHerramientas(() => ({
      text: "Paris",
      usage: { inputTokens: 50, outputTokens: 3 },
      finishReason: "stop",
    }));
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const peticion: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital of France lookup" }],
      tools: [consultaCapital],
    };
    await capa.generate(peticion);
    const segunda = await capa.generate(peticion);
    expect(proveedor.llamadas).toHaveLength(1);
    expect(segunda.report.cache.result).toBe("exact");
  });

  it("con contrato de salida, un turno de tool calls NO dispara la reparación pagada", async () => {
    const proveedor = new ProveedorConHerramientas(turnoDeHerramienta);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice to accounting" }],
      tools: [enviarFactura],
      response: {
        contractId: "factura:v1",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
    });

    // ANTES: "" no validaba contra el contrato y se pagaba una segunda llamada
    // condenada a fallar (el modelo no puede dar la respuesta final antes de
    // conocer el resultado de la herramienta).
    expect(proveedor.llamadas).toHaveLength(1);
    expect(res.report.calls.retries).toBe(0);
    expect(res.report.calls.actualLlm).toBe(1);
    expect(res.toolCalls).toHaveLength(1);
  });
});

/**
 * `allowExactCache` no miraba `hasWriteTools` aunque el contrato promete
 * literalmente "Write/destructive tools are never cached" y la semántica y el
 * singleflight ya lo cumplían. Con texto imperativo léxicamente neutro («send
 * the weekly report») la segunda petición salía de caché con netSavings=1 y la
 * acción no se ejecutaba.
 */
describe("la caché exacta nunca sirve peticiones con herramientas de escritura", () => {
  it("dos peticiones idénticas con un tool write van las dos al proveedor", async () => {
    const proveedor = new ProveedorConHerramientas(() => ({
      text: "done",
      usage: { inputTokens: 80, outputTokens: 5 },
      finishReason: "stop",
    }));
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const peticion: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the weekly report to the finance channel" }],
      tools: [{ id: "send_report", intents: ["send report"], risk: "write" }],
    };
    await capa.generate(peticion);
    const segunda = await capa.generate(peticion);

    expect(proveedor.llamadas).toHaveLength(2);
    expect(segunda.report.cache.result).toBe("miss");
  });

  it("evaluatePolicy lo dice explícitamente y con razón", () => {
    const politica = evaluatePolicy(
      canonicalize({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "send the weekly report to the finance channel" }],
        tools: [{ id: "send_report", intents: ["send report"], risk: "write" }],
      } as never),
    );
    expect(politica.allowExactCache).toBe(false);
    expect(politica.reasons.join("; ")).toContain("exact cache off (side effects must execute)");
  });

  it("las herramientas de solo lectura NO pierden la caché", () => {
    const politica = evaluatePolicy(
      canonicalize({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "capital of France lookup" }],
        tools: [consultaCapital],
      } as never),
    );
    expect(politica.allowExactCache).toBe(true);
  });
});

/**
 * `savings:{router:false}` sustituía la clasificación por defaultRoute()
 * (NO_RETRIEVAL) y el selector solo deja pasar write/destructive con
 * TOOL_ACTION: apagar el router — el "shadow mode" que el propio docstring
 * recomienda — tiraba las herramientas de escritura en silencio. El mismo fallo
 * que se cerró para `retrieval:"off"`, por la palanca hermana.
 */
describe("router:false no tira las herramientas del llamante", () => {
  it("el proveedor recibe el tool write con el router apagado", async () => {
    const proveedor = new ProveedorConHerramientas(turnoDeHerramienta);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice to accounting" }],
      tools: [enviarFactura],
      savings: { router: false },
    });

    const enviadas = proveedor.llamadas[0]!.tools ?? [];
    expect(enviadas.map((t) => t.id)).toContain("send_invoice");
    // Y el informe no vende como ahorro la herramienta "quitada".
    expect(res.report.calls.baselineTools).toBe(1);
    expect(res.report.calls.actualTools).toBe(1);
  });

  it("con el router ENCENDIDO el selector sigue filtrando por intent (no se rompió)", async () => {
    const proveedor = new ProveedorConHerramientas(() => ({
      text: "ok",
      usage: { inputTokens: 40, outputTokens: 4 },
    }));
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const irrelevante: ToolDescriptor = { id: "book_room", intents: ["book a room"], risk: "read" };
    await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "summarize the following text please" }],
      tools: [irrelevante],
    });
    expect(proveedor.llamadas[0]!.tools ?? []).toHaveLength(0);
  });
});
