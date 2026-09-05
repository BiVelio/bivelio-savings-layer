import { describe, expect, it } from "vitest";

import {
  KEEP_TOOL_RESULTS,
  MUNON_ELISION,
  aplicarElision,
  seleccionarElisionV0,
} from "../src/pipeline/elision.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { evaluatePolicy } from "../src/policy/policy.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * Elisión v0 en vivo — FASE 1 (fidelidad primero). La maquinaria está montada
 * pero el borrado real vive apagado (`ELISION_EN_VIVO=false` en pipeline.ts):
 * la etapa solo TRAZA lo que HABRÍA elidido, sin tocar `messages` ni acreditar.
 * Estos tests fijan las cuatro invariantes del plan:
 *   1. suelo de fidelidad ≥ KEEP_TOOL_RESULTS (nunca borrar los más nuevos);
 *   2. `allowElision` honra los vetos por turno (escritura/fresco/personalizado/
 *      estocástico) — no es un `true` cableado como la compresión;
 *   3. la etapa NO altera el tráfico ni la comisión con el flag apagado;
 *   4. cero dinero de elisión en la comisión (`eliminatedInput` es conteo puro;
 *      `basis` sigue "measured").
 */

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

const cuerpo = (bytes: number) => "x".repeat(bytes); // ASCII → exactamente `bytes` bytes

/** Transcripción de agente con `rondas` tool_results de `bytes` bytes cada uno:
 *  cada tool va precedido de un assistant con tool_calls, y cierra un assistant
 *  final. Con `rondas` ≥ 2 el más viejo tiene edad ≥ 2. */
function transcripcion(rondas: number, bytes: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "revisa el repositorio y resume" }];
  for (let j = 0; j < rondas; j++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${j}`, name: "read_file", arguments: "{}" }],
    });
    messages.push({ role: "tool", content: cuerpo(bytes), toolCallId: `c${j}`, name: "read_file" });
  }
  messages.push({ role: "assistant", content: "resumen final" });
  return messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Suelo de fidelidad y umbral (selección pura)
// ─────────────────────────────────────────────────────────────────────────────

describe("suelo de fidelidad: los KEEP_TOOL_RESULTS más nuevos nunca se eliden", () => {
  it("con exactamente KEEP_TOOL_RESULTS tool_results gordos y viejos, no se elide ninguno", () => {
    const messages = transcripcion(KEEP_TOOL_RESULTS, 4000);
    const eleccion = seleccionarElisionV0(messages); // keepUltimos por defecto = KEEP_TOOL_RESULTS
    expect(eleccion.indices).toEqual([]);
    expect(eleccion.bytesOriginales).toBe(0);
  });

  it("con KEEP_TOOL_RESULTS+2, se eliden solo los 2 más viejos (gordos y con edad ≥ 2)", () => {
    const rondas = KEEP_TOOL_RESULTS + 2;
    const messages = transcripcion(rondas, 4000);
    const eleccion = seleccionarElisionV0(messages);
    // Los dos más viejos son los índices de tool 0 y 1.
    const idxTool = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    expect(eleccion.indices).toEqual([idxTool[0], idxTool[1]]);
    expect(eleccion.bytesOriginales).toBe(2 * 4000);
  });

  it("tool_results pequeños (< 1 KB) nunca son candidatos, por viejos que sean", () => {
    const messages = transcripcion(KEEP_TOOL_RESULTS + 4, 500);
    expect(seleccionarElisionV0(messages).indices).toEqual([]);
  });

  it("el muñón conserva role/toolCallId/name y no muta el original", () => {
    const messages = transcripcion(KEEP_TOOL_RESULTS + 2, 4000);
    const { indices } = seleccionarElisionV0(messages);
    const salida = aplicarElision(messages, indices);
    for (const i of indices) {
      expect(salida[i]!.content).toBe(MUNON_ELISION);
      expect(salida[i]!.role).toBe("tool");
      expect(salida[i]!.toolCallId).toBe(messages[i]!.toolCallId); // referencia cruzada intacta
      expect(salida[i]!.name).toBe(messages[i]!.name);
      expect(messages[i]!.content).not.toBe(MUNON_ELISION); // original sin mutar
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. allowElision honra los vetos por turno
// ─────────────────────────────────────────────────────────────────────────────

const politicaDe = (req: unknown) => evaluatePolicy(canonicalize(req as never));

describe("allowElision se calcula (no está cableado): honra los vetos por turno", () => {
  it("petición de lectura limpia → allowElision true", () => {
    const p = politicaDe({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "resume el siguiente documento por favor" }],
    });
    expect(p.allowElision).toBe(true);
  });

  it("herramienta de escritura → allowElision false (esconder el resultado de una acción es inaceptable)", () => {
    const p = politicaDe({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the weekly report to the finance channel" }],
      tools: [{ id: "send_report", intents: ["send report"], risk: "write" }],
    });
    expect(p.allowElision).toBe(false);
  });

  it("muestreo estocástico (temp>0.3 sin seed) → allowElision false", () => {
    const p = politicaDe({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "escribe un poema libre" }],
      temperature: 0.9,
    });
    expect(p.allowElision).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 y 4. Integración de pipeline: trace-only, tráfico intacto, comisión intacta
// ─────────────────────────────────────────────────────────────────────────────

class ProveedorEspia implements Provider {
  readonly id = "espia-elision";
  llamadas: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas.push(r);
    return { text: "listo", usage: { inputTokens: 200, outputTokens: 10 }, finishReason: "stop" };
  }
}

const lectura: ToolDescriptor = { id: "read_file", intents: ["read a file"], risk: "read" };

/** Petición con KEEP_TOOL_RESULTS+2 tool_results gordos y viejos: hay material
 *  para elidir, así que la etapa 9-bis dispara su rama "shadow". Sin descriptor
 *  de herramienta a propósito: los tool_result son mensajes de la conversación,
 *  no necesitan un `tools[]`, y así el tool-selector no deja caer ningún esquema
 *  (que estimaría `basis` por su cuenta) — el baseline queda LIMPIO y medido, y
 *  cualquier crédito o cambio de `basis` sería atribuible SOLO a la elisión. */
function peticionConMaterial(extra: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: transcripcion(KEEP_TOOL_RESULTS + 2, 4000),
    ...extra,
  };
}

describe("integración: con el flag apagado la etapa TRAZA pero no toca nada", () => {
  it("traza «shadow» con el conteo, sin reescribir el tráfico ni mover la comisión", async () => {
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS, devUnlicensed: true });
    const res = await capa.generate(peticionConMaterial({ savings: { elision: true } }));

    const traza = res.report.traces.find((t) => t.stage === "elision");
    expect(traza).toBeDefined();
    expect(traza!.outcome).toBe("shadow");
    const detalle = traza!.detail as { elided: number; eliminatedTokens: number; live: boolean };
    expect(detalle.elided).toBe(2); // los 2 más viejos
    expect(detalle.eliminatedTokens).toBeGreaterThan(0);
    expect(detalle.live).toBe(false);

    // El proveedor recibió el tráfico SIN TOCAR: ningún cuerpo es el muñón.
    const enviadas = proveedor.llamadas[0]!.messages;
    expect(enviadas.some((m) => m.content === MUNON_ELISION)).toBe(false);
    // Y siguen estando los tool_results grandes originales.
    expect(enviadas.filter((m) => m.role === "tool" && m.content.length >= 4000).length).toBe(
      KEEP_TOOL_RESULTS + 2,
    );

    // CONTABILIDAD. El baseline es LIMPIO (sin descriptor de herramienta que
    // estime por su cuenta), así que estas cifras son atribuibles solo a la
    // elisión: con el flag apagado no acredita NADA (`eliminatedInput` es conteo
    // puro y sigue en 0) y no mueve `basis` de "measured" — el sello «verificado
    // contra tu factura» intacto, cero dinero de elisión en la comisión.
    expect(res.report.tokens.eliminatedInput).toBe(0);
    expect(res.report.cost.basis).toBe("measured");
  });

  it("sin el toggle elision, la etapa ni siquiera corre (no hay traza)", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorEspia(),
      costModels: PRECIOS,
      devUnlicensed: true,
    });
    const res = await capa.generate(peticionConMaterial()); // sin savings.elision
    expect(res.report.traces.some((t) => t.stage === "elision")).toBe(false);
  });

  it("con una herramienta de escritura, allowElision false → la etapa no corre", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorEspia(),
      costModels: PRECIOS,
      devUnlicensed: true,
    });
    const conEscritura = peticionConMaterial({
      savings: { elision: true },
      tools: [lectura, { id: "commit", intents: ["commit changes"], risk: "write" }],
    });
    const res = await capa.generate(conEscritura);
    expect(res.report.traces.some((t) => t.stage === "elision")).toBe(false);
  });
});
