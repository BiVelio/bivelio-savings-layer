import { beforeEach, describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { ToolSelector } from "../src/router/tool-selector.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * EL LIBRO 2 ESTABA MUERTO.
 *
 * `SavingsLedger.eliminate()` no tenía ni un llamante en todo `src/` —solo
 * `test/tokenizer.test.ts`—, así que `report.tokens.eliminatedInput` salía 0 en
 * TODA petición y `src/metering/emitter.ts` enviaba 0 al panel del cliente.
 * Mientras tanto el README anuncia `eliminated_tokens` como uno de los cuatro
 * libros, y el banco etiqueta con él dos escenarios enteros.
 *
 * El ahorro existía —el baseline SÍ cuenta las herramientas declaradas, así que
 * podarlas se veía en el total— pero no estaba atribuido a ningún libro. Un
 * campo publicado sin productor es una promesa que el cliente no puede
 * verificar.
 *
 * Lo delató la propia medición LIVE: `benchmarks/out/ab-live.json` trae el
 * escenario «Tool-heavy request» etiquetado `ledger: eliminated_tokens` con
 * `attribution.eliminatedInputTokens: 0`.
 */

class Mudo implements Provider {
  readonly id = "mudo";
  enviados: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(r);
    return { text: "hecho", finishReason: "stop", usage: { inputTokens: 120, outputTokens: 10 } };
  }
}

/** Herramientas con descripciones largas: es donde de verdad duele no podarlas. */
const HERRAMIENTAS: NonNullable<SavingsRequest["tools"]> = [
  {
    id: "buscar_factura",
    intents: ["buscar", "factura", "importe"],
    risk: "read",
    description: "Busca una factura por número, cliente o rango de fechas y devuelve su detalle completo.",
    parameters: { type: "object", properties: { numero: { type: "string" }, cliente: { type: "string" } } },
  },
  {
    id: "exportar_contabilidad",
    intents: ["exportar", "contabilidad", "asiento"],
    risk: "read",
    description:
      "Exporta los asientos contables de un periodo al formato del ERP, incluyendo desgloses de IVA, " +
      "retenciones, cuentas de contrapartida y el diario completo con todos sus apuntes.",
    parameters: {
      type: "object",
      properties: { desde: { type: "string" }, hasta: { type: "string" }, formato: { type: "string" } },
    },
  },
  {
    id: "planificar_ruta_reparto",
    intents: ["ruta", "reparto", "logistica"],
    risk: "read",
    description:
      "Calcula la ruta óptima de reparto para una flota dada, con ventanas horarias, capacidad por " +
      "vehículo, restricciones de acceso urbano y previsión de tráfico.",
    parameters: {
      type: "object",
      properties: { vehiculos: { type: "array" }, paradas: { type: "array" } },
    },
  },
];

const peticion = (tools?: SavingsRequest["tools"]): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "¿Cuál es el importe de la factura F-118?" }],
  savings: { exactCache: false },
  ...(tools ? { tools } : {}),
});

// Una instancia por prueba: el selector congela conjuntos por catálogo.
const PODA_ = () => new ToolSelector({ maxTools: 8 });
let PODA = PODA_();
beforeEach(() => {
  PODA = PODA_();
});

describe("libro 2 — tokens eliminados", () => {
  it("SIN `maxTools` (0.4.33) no hay poda: todas viajan y el libro 2 no acredita nada", async () => {
    const espia = new Mudo();
    const capa = createSavingsLayer({ provider: espia });

    const res = await capa.generate(peticion(HERRAMIENTAS));

    expect((espia.enviados[0]!.tools ?? []).length).toBe(HERRAMIENTAS.length);
    expect(res.report.calls.actualTools).toBe(res.report.calls.baselineTools);
    expect(res.report.tokens.eliminatedInput).toBe(0);
    expect(res.report.traces.some((t) => t.stage === "tool-selector")).toBe(false);
  });

  it("podar herramientas ALIMENTA el libro, ya no sale 0", async () => {
    // La poda por relevancia es opt-in desde 0.4.33 (`maxTools`).
    const capa = createSavingsLayer({ provider: new Mudo(), toolSelector: PODA });

    const res = await capa.generate(peticion(HERRAMIENTAS));

    // La pregunta solo casa con `buscar_factura`; las otras dos se descartan.
    expect(res.report.calls.actualTools).toBeLessThan(res.report.calls.baselineTools);
    expect(res.report.tokens.eliminatedInput).toBeGreaterThan(0);
  });

  it("cuenta EXACTAMENTE los tokens de las herramientas descartadas, con su envoltorio", async () => {
    const espia = new Mudo();
    const capa = createSavingsLayer({ provider: espia, toolSelector: PODA });

    const res = await capa.generate(peticion(HERRAMIENTAS));

    // Reconstruimos el mismo envoltorio que factura el proveedor. Si el conteo
    // divergiera del ensamblador del baseline, el sesgo volvería a colarse como
    // ahorro — es el bug de las 785 vs 262 que documenta `assemblePromptText`.
    const enviadas = new Set((espia.enviados[0]!.tools ?? []).map((t) => t.id));
    const descartadas = HERRAMIENTAS.filter((t) => !enviadas.has(t.id));
    expect(descartadas.length).toBeGreaterThan(0);

    const esperado = descartadas
      .map((t) =>
        JSON.stringify({
          type: "function",
          function: {
            name: t.id,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.parameters ?? { type: "object", properties: {} },
          },
        }),
      )
      .reduce((n, texto) => n + Math.ceil(texto.length / 4), 0);

    // El estimador por defecto es ~4 caracteres por token; comparamos con holgura
    // porque lo que se fija aquí es el ORDEN DE MAGNITUD y que no sea 0, no la
    // regla del tokenizador.
    expect(res.report.tokens.eliminatedInput).toBeGreaterThan(esperado * 0.5);
    expect(res.report.tokens.eliminatedInput).toBeLessThan(esperado * 2);
  });

  it("sin herramientas que podar, el libro sigue a 0 (no inventa ahorro)", async () => {
    const capa = createSavingsLayer({ provider: new Mudo() });

    const res = await capa.generate(peticion());

    expect(res.report.tokens.eliminatedInput).toBe(0);
  });

  it("una llamada EVITADA no toca el libro 2: los libros son disjuntos", async () => {
    const capa = createSavingsLayer({ provider: new Mudo() });
    const req: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "¿Cuánto es 7 * 6?" }],
      tools: HERRAMIENTAS,
    };

    const res = await capa.generate(req);

    // La resuelve un resolver determinista: es libro 1, no libro 2. Apuntarla en
    // los dos contaría el mismo ahorro dos veces, y el panel enseña los cuatro
    // en fila — quien los lea los suma con la vista.
    expect(res.report.calls.avoidedLlm).toBe(1);
    expect(res.report.tokens.eliminatedInput).toBe(0);
  });

  it("el libro llega al informe que se publica, no se queda dentro", async () => {
    const capa = createSavingsLayer({ provider: new Mudo(), toolSelector: PODA });

    const res = await capa.generate(peticion(HERRAMIENTAS));

    // Es el campo que `metering/emitter.ts` envía como `eliminatedInputTokens`.
    expect(res.report.tokens).toHaveProperty("eliminatedInput");
    expect(Number.isInteger(res.report.tokens.eliminatedInput)).toBe(true);
    expect(res.report.tokens.eliminatedInput).toBeGreaterThan(0);
  });
});
