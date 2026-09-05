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
 * Elisión del lado del SDK — fidelidad primero. Dos políticas conviven:
 *   • v0 (edad × tamaño): la que corre el carril SOMBRA del gateway en modo
 *     medir-solo, y contra la que compara la verja de paridad. Los tests del
 *     bloque 1 fijan su selección pura (`seleccionarElisionV0`).
 *   • SUPERSESIÓN: la que corre EN VIVO en el pipeline (etapa 9-bis) — más
 *     conservadora y demostrable; su selección pura vive en
 *     `test/elision-supersesion.test.ts` y aquí se prueba su INTEGRACIÓN.
 *
 * Con `ELISION_EN_VIVO=false` (pipeline.ts) la etapa solo TRAZA lo que HABRÍA
 * elidido, sin tocar `messages` ni acreditar. Estos tests fijan las invariantes:
 *   1. suelo de fidelidad de v0 ≥ KEEP_TOOL_RESULTS (nunca borrar los más nuevos);
 *   2. `allowElision` honra los vetos por turno (escritura/fresco/personalizado/
 *      estocástico) — no es un `true` cableado como la compresión;
 *   3. la etapa en vivo (supersesión) NO altera el tráfico ni la comisión con el
 *      flag apagado;
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

/** Transcripción donde DOS recursos (`a.ts`, `b.ts`) se releen al final: sus
 *  lecturas viejas quedan SUPERSEDIDAS y son las únicas candidatas de la política
 *  en vivo. Entre medias, lecturas de recursos DISTINTOS que la supersesión
 *  DECLINA (una síntesis las necesita todas). Con el flag apagado todo viaja
 *  intacto; la etapa solo traza los 2 superados. Total de tool_results gordos =
 *  KEEP_TOOL_RESULTS + 4 (2 viejos + relleno + 2 vigentes). */
function transcripcionSupersedida(bytes: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "revisa el repositorio y resume" }];
  const leer = (id: string, path: string) => {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path }) }],
    });
    messages.push({ role: "tool", content: cuerpo(bytes), toolCallId: id, name: "read_file" });
  };
  leer("a1", "a.ts"); // viejo → superseded por a2
  leer("b1", "b.ts"); // viejo → superseded por b2
  for (let j = 0; j < KEEP_TOOL_RESULTS; j++) leer(`f${j}`, `filler-${j}.ts`); // distintos → declinados
  leer("a2", "a.ts"); // vigente de a
  leer("b2", "b.ts"); // vigente de b (además último tool_result → jamás)
  messages.push({ role: "assistant", content: "resumen final" });
  return messages;
}

/** Petición con material SUPERSEDIDO: hay 2 lecturas viejas re-pedidas, así que
 *  la etapa 9-bis (supersesión) elide DOS bloques. Sin descriptor de herramienta
 *  a propósito: los tool_result son mensajes de la conversación, no necesitan un
 *  `tools[]`, y así el tool-selector no deja caer ningún esquema (que estimaría
 *  `basis` por su cuenta) — el baseline queda LIMPIO y medido, y cualquier
 *  crédito o cambio de `basis` sería atribuible SOLO a la elisión. */
function peticionConMaterial(extra: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: transcripcionSupersedida(4000),
    ...extra,
  };
}

describe("integración: con el flag encendido la etapa ELIDE de verdad, sin mover la comisión", () => {
  it("aplica el muñón a los 2 supersedidos y NO acredita dinero de elisión (basis measured)", async () => {
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS, devUnlicensed: true });
    const res = await capa.generate(peticionConMaterial({ savings: { elision: true } }));

    const traza = res.report.traces.find((t) => t.stage === "elision");
    expect(traza).toBeDefined();
    expect(traza!.outcome).toBe("applied");
    const detalle = traza!.detail as { elided: number; eliminatedTokens: number; live: boolean };
    expect(detalle.elided).toBe(2); // las 2 lecturas viejas supersedidas (a1, b1)
    expect(detalle.eliminatedTokens).toBeGreaterThan(0);
    expect(detalle.live).toBe(true);

    // El proveedor recibió EXACTAMENTE 2 muñones (a1, b1); el resto del tráfico
    // intacto. Las lecturas VIGENTES (a2, b2) y los rellenos distintos viajan
    // enteros: la síntesis del estado actual conserva todo lo que necesita.
    const enviadas = proveedor.llamadas[0]!.messages;
    expect(enviadas.filter((m) => m.content === MUNON_ELISION).length).toBe(2);
    expect(enviadas.filter((m) => m.role === "tool" && m.content.length >= 4000).length).toBe(
      KEEP_TOOL_RESULTS + 2, // los KEEP_TOOL_RESULTS+4 originales menos los 2 elididos
    );

    // CONTABILIDAD. El baseline es LIMPIO, así que estas cifras son atribuibles
    // solo a la elisión: `eliminatedInput` es CONTEO puro (ahora > 0 porque el
    // borrado es real) pero `basis` NO se mueve de "measured". El borrado baja de
    // verdad `sentInputLocal`; para que eso NO infle `removedInputLocal` ni el
    // baseline reconstruido, la etapa anota los mismos tokens en `elididoLocal` y
    // el cálculo de la regla los RESTA. Resultado: cero dinero de elisión en la
    // comisión; el dólar hipotético lo mide el carril sombra, fuera de comisión.
    expect(res.report.tokens.eliminatedInput).toBeGreaterThan(0);
    expect(res.report.cost.basis).toBe("measured");
  });

  it("SIN el toggle elision (default-on), la etapa CORRE igual: el ahorro es automático", async () => {
    // El nuevo default es opt-out (`!== false`): con un token entitled y una petición
    // segura, la elisión corre sin que la app pida `savings.elision`. Es el corazón
    // del ahorro-de-entrada-automático.
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS, devUnlicensed: true });
    const res = await capa.generate(peticionConMaterial()); // sin savings.elision
    const traza = res.report.traces.find((t) => t.stage === "elision");
    expect(traza).toBeDefined();
    expect(traza!.outcome).toBe("applied");
    expect(res.report.cost.basis).toBe("measured");
  });

  it("con el opt-out explícito `savings:{elision:false}`, la etapa NO corre (kill-switch por petición)", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorEspia(),
      costModels: PRECIOS,
      devUnlicensed: true,
    });
    const res = await capa.generate(peticionConMaterial({ savings: { elision: false } }));
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
