import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest, TraceEvent } from "../src/contracts/types.js";
import type { ToolOutputCompactionSettings } from "../src/compression/cola.js";

/**
 * LA LEY DE LA CACHÉ DE PREFIJO, EN EL PIPELINE.
 *
 * En un bucle de agente el cliente reenvía el historial entero y el proveedor lo
 * lee de su caché de prefijo, que solo acierta si los bytes son IDÉNTICOS a los
 * del turno anterior. Una compactación que reescribiera un tool_result ya
 * enviado convertiría todo lo posterior en escritura (12,5× o 20× el precio de
 * la lectura). Estos tests fijan que la compactación de la cola:
 *
 *   1. compacta el tool_result el turno en que nace;
 *   2. reenvía EXACTAMENTE los mismos bytes en los turnos siguientes — también
 *      desde una instancia nueva de la capa (serverless: sin memoria);
 *   3. no toca system, user ni assistant, ni la vista de un fichero;
 *   4. cuenta lo quitado en el libro 3 y NO lo convierte en dinero ni comisión.
 */

class ProveedorEspia implements Provider {
  readonly id = "espia";
  recibidas: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.recibidas.push(r);
    return { text: "ok", usage: { inputTokens: 1000, outputTokens: 10 } };
  }
  get ultima(): ChatMessage[] {
    return this.recibidas[this.recibidas.length - 1]!.messages;
  }
}

const SISTEMA = "You are a support agent. Use the tools to answer.";
const PREGUNTA = "Which open issues mention the checkout flow?";

/** Salidas de herramienta con lo que la compactación sabe quitar. */
const salida = (turno: number): string => {
  if (turno % 3 === 0) {
    return JSON.stringify(
      { issues: Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i + turno, title: `Checkout fails on step ${i}`, labels: ["bug", "checkout"] })) },
      null,
      2,
    );
  }
  if (turno % 3 === 1) {
    return Array.from({ length: 40 }, (_, i) =>
      `\u001b[${i % 2 ? 31 : 32}m${i % 2 ? "FAIL" : "PASS"}\u001b[39m checkout.spec.ts > case ${i} (turn ${turno})`,
    ).join("\n");
  }
  return [`poll ${turno}`, ...Array(40).fill("Waiting for the payment sandbox to become ready (HTTP 503)...")].join("\n");
};

/** La conversación tal como la guarda el CLIENTE (siempre con los originales). */
function historial(turnos: number): ChatMessage[] {
  const m: ChatMessage[] = [
    { role: "system", content: SISTEMA },
    { role: "user", content: PREGUNTA },
  ];
  for (let t = 0; t < turnos; t++) {
    m.push({ role: "assistant", content: "", toolCalls: [{ id: `c${t}`, name: "search_issues", arguments: `{"query":"checkout ${t}"}` }] });
    m.push({ role: "tool", toolCallId: `c${t}`, name: "search_issues", content: salida(t) });
  }
  return m;
}

const peticion = (turnos: number, savings: SavingsRequest["savings"] = { toolOutputCompaction: true }): SavingsRequest => ({
  model: "anthropic/claude-sonnet-5",
  messages: historial(turnos),
  savings: { exactCache: false, ...savings },
});

const capa = (proveedor: Provider, toolOutputCompaction?: boolean | ToolOutputCompactionSettings) =>
  createSavingsLayer({
    exactTokenizer: false,
    provider: proveedor,
    ...(toolOutputCompaction !== undefined ? { toolOutputCompaction } : {}),
  });

const traza = (trazas: TraceEvent[]): TraceEvent | undefined => trazas.find((e) => e.stage === "tool-output-compaction");

describe("apagada por defecto", () => {
  it("sin pedirla, el proveedor recibe los tool_results tal cual y no hay traza", async () => {
    const p = new ProveedorEspia();
    const r = await capa(p).generate(peticion(3, {}));
    const tools = p.ultima.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools).toEqual([salida(0), salida(1), salida(2)]);
    expect(traza(r.report.traces)).toBeUndefined();
    expect(r.report.tokens.compressedInput).toBe(0);
  });
});

describe("la cola se compacta al nacer y el prefijo no se mueve", () => {
  it("cada turno enviado EMPIEZA por los bytes exactos del turno anterior, con una capa nueva por turno", async () => {
    const enviados: ChatMessage[][] = [];
    for (let turnos = 1; turnos <= 6; turnos++) {
      // Una instancia NUEVA por turno: así corre en serverless, sin memoria.
      const p = new ProveedorEspia();
      await capa(p).generate(peticion(turnos));
      enviados.push(p.ultima);
    }
    for (let i = 1; i < enviados.length; i++) {
      const previo = enviados[i - 1]!;
      const actual = enviados[i]!;
      expect(actual.slice(0, previo.length)).toEqual(previo);
    }
    // Y de verdad se compactó: ni un escape de color ni un JSON indentado.
    const ultimo = enviados[enviados.length - 1]!.filter((m) => m.role === "tool").map((m) => m.content);
    expect(ultimo.some((c) => c.includes("\u001b"))).toBe(false);
    expect(ultimo.some((c) => c.includes('\n  "issues"'))).toBe(false);
    expect(ultimo.some((c) => c.includes("[previous line repeated 39 more times]"))).toBe(true);
  });

  it("la traza separa lo NUEVO de lo que se reenvía igual que cuando nació", async () => {
    const p = new ProveedorEspia();
    const r = await capa(p).generate(peticion(3));
    const t = traza(r.report.traces)!;
    expect(t.outcome).toBe("applied");
    expect(t.detail?.compacted).toBe(3);
    expect(Number(t.detail?.tailSavedTokens)).toBeGreaterThan(0);
    expect(Number(t.detail?.replayedSavedTokens)).toBeGreaterThan(0);
    expect(t.detail?.cacheWriteMultiplier).toBe(1.25);
    expect(t.detail?.transforms).toEqual({ json: 1, ansi: 1, "repeated-lines": 1 });
  });

  it("system, user y assistant salen intactos", async () => {
    const p = new ProveedorEspia();
    await capa(p).generate(peticion(3));
    const original = historial(3);
    const noTool = (ms: ChatMessage[]) => ms.filter((m) => m.role !== "tool").map((m) => m.content);
    expect(noTool(p.ultima)).toEqual(noTool(original));
  });
});

describe("lo que no se toca", () => {
  it("la vista de un fichero sale verbatim aunque sea JSON indentado", async () => {
    const p = new ProveedorEspia();
    const pkg = JSON.stringify({ name: "x", dependencies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`dep-${i}`, `^${i}.0.0`])) }, null, 2);
    const messages: ChatMessage[] = [
      { role: "user", content: "bump the deps" },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"package.json"}' }] },
      { role: "tool", toolCallId: "r1", name: "read_file", content: pkg },
    ];
    const r = await capa(p).generate({ model: "openai/gpt-4o-mini", messages, savings: { toolOutputCompaction: true, exactCache: false } });
    expect(p.ultima.find((m) => m.role === "tool")!.content).toBe(pkg);
    expect(traza(r.report.traces)?.detail?.fileViewsKeptVerbatim).toBe(1);
    expect(r.report.tokens.compressedInput).toBe(0);
  });

  it("`savings.toolOutputCompaction: false` gana a la capa, y `exceptTools` también se respeta", async () => {
    const p1 = new ProveedorEspia();
    await capa(p1, true).generate(peticion(2, { toolOutputCompaction: false }));
    expect(p1.ultima.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([salida(0), salida(1)]);

    const p2 = new ProveedorEspia();
    await capa(p2, { exceptTools: ["search_issues"] }).generate(peticion(2, {}));
    expect(p2.ultima.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([salida(0), salida(1)]);
  });

  it("encendida en la capa, corre sin pedirla en la petición", async () => {
    const p = new ProveedorEspia();
    const r = await capa(p, true).generate(peticion(2, {}));
    expect(traza(r.report.traces)?.outcome).toBe("applied");
  });
});

describe("contabilidad: conteo en el libro 3, ni un céntimo reclamado", () => {
  it("compressedInput cuenta lo quitado; el baseline no crece y el basis sigue siendo `measured`", async () => {
    const p = new ProveedorEspia();
    const r = await capa(p).generate(peticion(3));
    const t = traza(r.report.traces)!;
    expect(r.report.tokens.compressedInput).toBe(Number(t.detail?.before) - Number(t.detail?.after));
    expect(r.report.tokens.compressedInput).toBeGreaterThan(0);
    // La factura baja por su cuenta; el informe no se la atribuye.
    expect(r.report.cost.baselineEstimate).toBeCloseTo(r.report.cost.actual, 12);
    expect(r.report.cost.netSavings).toBeCloseTo(0, 12);
    expect(r.report.cost.basis).toBe("measured");
  });
});
