import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  scenarios,
  conSalDeFrio,
  conMuestreoPareado,
  llevaPistaDeLimites,
  MUESTREO_PAREADO,
} from "../benchmarks/scenarios.js";
import { createSavingsLayer, TokenizerRegistry, registrarTokenizadorExacto, type Provider } from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";

/**
 * LA REGRESIÓN DEL ESCENARIO ESTRUCTURADO (2026-09-12) NO ERA DE LA CAPA.
 *
 * Entre la tirada publicada (f2f2143) y las dos del 12 (0bd1d83 + feat/banco-b1)
 * el brazo B de «Constrained structured answer» pasó de +3,0 % a −4,3 % y
 * −11,9 %, y el de «Stable-prefix agent turn» de 63 a 81 tokens de salida con
 * ~30 tokens de entrada de más. Reproducido offline con un proveedor falso: la
 * ProviderRequest que la capa construye para esos escenarios es IDÉNTICA byte a
 * byte entre esos commits. Lo que cambió fue el banco y el azar:
 *
 *   1. La memoria de contratos era UN `Set` para toda la tirada y seis
 *      escenarios comparten `contractId: "demo-answer:v1"`. El primer fallo de
 *      valor en cualquiera de ellos encendía la pista `JSON limits (not
 *      API-enforced): …` en todos los siguientes, solo en el brazo B, y en qué
 *      repetición se encendía dependía de lo que el modelo hubiera escrito antes.
 *   2. El brazo A siempre mandó `temperature: 0, seed: 7`; el B mandaba la
 *      petición del escenario tal cual, sin muestreo, así que el proveedor
 *      aplicaba el suyo por defecto. Un A/B entre una respuesta determinista y
 *      una muestreada.
 *
 * Estos tests fijan las dos cosas y el mecanismo de la capa que obliga a la
 * primera: si la capa cambia el texto de la pista, el banco dejará de verla, y
 * este test lo dirá antes que una tirada pagada.
 */

const PRECIO = { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 };
const VALIDA = '{"answer":"BV-SALA is a savings layer for LLM calls.","refs":["https://bivelio.com"]}';
// `refs` entries tienen maxLength 120: esto es un fallo de VALOR, el único que
// la memoria de contratos apunta (`esFalloDeValor` en pipeline.ts).
const INCUMPLE_VALOR = JSON.stringify({
  answer: "BV-SALA is a savings layer for LLM calls.",
  refs: ["https://bivelio.com/" + "x".repeat(130)],
});

/** Proveedor falso: no habla con nadie, devuelve las respuestas en orden y guarda lo que le llega. */
function proveedorFalso(respuestas: string[], capturadas: ProviderRequest[]): Provider {
  const cola = [...respuestas];
  return {
    id: "falso",
    generate: async (r) => {
      capturadas.push(r);
      const text = cola.length > 1 ? cola.shift()! : cola[0]!;
      const prompt = r.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      return {
        text,
        usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) },
        finishReason: "stop",
        raw: { model: "gpt-4o-mini-2024-07-18" },
      };
    },
  };
}

const registro = new TokenizerRegistry();
await registrarTokenizadorExacto(registro);

const capa = (provider: Provider, memoria: Set<string>) =>
  createSavingsLayer({ provider, defaultCostModel: PRECIO, tokenizer: registro, constraintMemory: memoria });

const constrained = scenarios.find((s) => s.name === "Constrained structured answer")!;
const prefijoEstable = scenarios.find((s) => s.name === "Stable-prefix agent turn")!;

describe("el brazo B manda el MISMO muestreo que el brazo A", () => {
  it("la petición que atraviesa la capa llega al proveedor con temperature 0 y seed 7", async () => {
    const capturadas: ProviderRequest[] = [];
    const req = conMuestreoPareado(conSalDeFrio(constrained.request, "nonce-test"));
    await capa(proveedorFalso([VALIDA], capturadas), new Set()).generate(req);
    expect(capturadas).toHaveLength(1);
    expect(capturadas[0]!.temperature).toBe(MUESTREO_PAREADO.temperature);
    expect(capturadas[0]!.seed).toBe(MUESTREO_PAREADO.seed);
  });

  it("sin `conMuestreoPareado` la capa NO manda muestreo: ese era el brazo B de las tiradas anteriores", async () => {
    const capturadas: ProviderRequest[] = [];
    await capa(proveedorFalso([VALIDA], capturadas), new Set()).generate(conSalDeFrio(constrained.request, "nonce-test"));
    expect(capturadas[0]!.temperature).toBeUndefined();
    expect(capturadas[0]!.seed).toBeUndefined();
  });

  // GUARDA DE TEXTO, a propósito: `buildNaive` no se exporta y la constante es
  // lo único que garantiza que los dos brazos no vuelvan a divergir en silencio.
  it("guarda de texto: `buildNaive` toma el muestreo de la misma constante que el brazo B", () => {
    expect(MUESTREO_PAREADO).toEqual({ temperature: 0, seed: 7 });
    const fuente = readFileSync(new URL("../benchmarks/ab-live.ts", import.meta.url), "utf8");
    const buildNaive = fuente.slice(fuente.indexOf("function buildNaive("), fuente.indexOf("type Kind ="));
    expect(buildNaive).toContain("...MUESTREO_PAREADO");
    expect(buildNaive).not.toMatch(/temperature:\s*0/);
    expect(fuente).toContain("conMuestreoPareado(");
  });
});

describe("la pista de límites solo viaja tras un fallo de valor, y SOLO a quien comparte la memoria", () => {
  it("una capa NUEVA con la MISMA memoria hereda la pista; con memoria propia, no", async () => {
    const memoria = new Set<string>();
    const req = conMuestreoPareado(conSalDeFrio(constrained.request, "nonce-test"));

    // Repetición que incumple: la capa repara (dos llamadas) y apunta el contrato.
    const rep0: ProviderRequest[] = [];
    const res0 = await capa(proveedorFalso([INCUMPLE_VALOR, VALIDA], rep0), memoria).generate(req);
    expect(res0.report.calls.actualLlm).toBe(2);
    expect(res0.report.calls.retries).toBe(1);
    expect(llevaPistaDeLimites(rep0[0]!.messages)).toBe(false);
    expect(memoria.has(constrained.request.response!.contractId!)).toBe(true);

    // Repetición siguiente, capa nueva (así las crea el banco), misma memoria: lleva la pista.
    const rep1: ProviderRequest[] = [];
    await capa(proveedorFalso([VALIDA], rep1), memoria).generate(req);
    expect(rep1).toHaveLength(1);
    expect(llevaPistaDeLimites(rep1[0]!.messages)).toBe(true);
    // Es el bloque que le cuesta al brazo B ~30 tokens en el cable: va como
    // `system`, DESPUÉS del prefijo estable y ANTES de la pregunta.
    const pista = rep1[0]!.messages.find((m) => llevaPistaDeLimites([m]))!;
    expect(pista.content).toBe("JSON limits (not API-enforced): answer<=400ch; refs<=3 items; refs entries<=120ch");
    expect(rep1[0]!.messages.length).toBe(rep0[0]!.messages.length + 1);

    // Otro escenario con el MISMO contractId y memoria PROPIA: no hereda nada.
    const otro: ProviderRequest[] = [];
    await capa(proveedorFalso([VALIDA], otro), new Set()).generate(conMuestreoPareado(prefijoEstable.request));
    expect(prefijoEstable.request.response!.contractId).toBe(constrained.request.response!.contractId);
    expect(llevaPistaDeLimites(otro[0]!.messages)).toBe(false);
  });

  it("en el prefijo estable la pista va DETRÁS del system largo: el tramo cacheable sobrevive", async () => {
    const memoria = new Set([prefijoEstable.request.response!.contractId!]);
    const capturadas: ProviderRequest[] = [];
    await capa(proveedorFalso([VALIDA], capturadas), memoria).generate(conMuestreoPareado(prefijoEstable.request));
    const msgs = capturadas[0]!.messages;
    expect(msgs[0]!.content).toBe(prefijoEstable.request.messages[0]!.content);
    expect(llevaPistaDeLimites([msgs[1]!])).toBe(true);
    expect(msgs[2]!.role).toBe("user");
  });

  // GUARDA DE TEXTO, a propósito: `runScenario` no se exporta. Lo que fija es
  // que ninguna capa del banco vuelva a recibir una memoria compartida.
  it("guarda de texto: cada capa medida del banco estrena su memoria de contratos", () => {
    const fuente = readFileSync(new URL("../benchmarks/ab-live.ts", import.meta.url), "utf8");
    // Antes: `const memoriaContratos = new Set<string>()` a nivel de módulo.
    expect(fuente).not.toMatch(/^const memoriaContratos\b/m);
    const runScenario = fuente.slice(fuente.indexOf("async function runScenario("), fuente.indexOf("// ── Quality gate"));
    expect(runScenario).toContain("const memoriaNueva = (): Set<string> => new Set<string>()");
    // Y todas las capas del escenario (sondeo, brazo B) la estrenan.
    const llamadas = runScenario.match(/nuevaCapa\([^)]*\)/g) ?? [];
    expect(llamadas.length).toBeGreaterThanOrEqual(2);
    for (const l of llamadas) expect(l).toContain("memoriaNueva()");
    // Y cuenta las repeticiones que la llevaron: sin eso la fila mezcla dos peticiones sin decirlo.
    expect(runScenario).toContain("llevaPistaDeLimites(r.messages)");
    expect(runScenario).toContain("pistaDeLimites: { reps: repsConPista, total: reps }");
  });
});
