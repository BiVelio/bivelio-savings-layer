import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  CATALOGO,
  PRECIOS_AL_DIA,
  diaUtc,
  precioDeLista,
  precioDeListaPropio,
  tramosDePrecio,
  vigenciasIncoherentes,
} from "../src/pricing/catalogo.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { costeMedido } from "../gateway/medidor.js";
import { preciosPara } from "../gateway/sombra.js";
import { dineroDe, type TurnoTranscript } from "../benchmarks/anillo2/conciliacion.js";
import { createSavingsLayer } from "../src/pipeline/create.js";

/**
 * LA VIGENCIA POR FILA: UNA PETICIÓN SE TARIFA AL PRECIO DE SU DÍA.
 *
 * Google anuncia en su página oficial de precios (consultada el 2026-09-27,
 * https://ai.google.dev/gemini-api/docs/pricing) que Gemini 3.6, 3.7 y 3.8
 * Flash pasan de $0.75 / $3.75 / $0.075 a $1.50 / $7.50 / $0.15 por millón «starting
 * January 1, 2027». Sin fechas, el 1 de enero el catálogo seguiría tarifando a
 * la mitad y ningún `actual` cuadraría con la factura.
 */

const DIC_31 = Date.parse("2026-12-31T23:59:59.999Z");
const ENE_01 = Date.parse("2027-01-01T00:00:00.000Z");
const AL_DIA = Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`);
const DOBLE = { inputPer1k: 0.0015, outputPer1k: 0.0075, cachedInputPer1k: 0.00015 };

describe("la vigencia del catálogo", () => {
  it("es coherente: fechas válidas, tramos contiguos y cada fila de CATALOGO rige el día del catálogo", () => {
    expect(vigenciasIncoherentes()).toEqual([]);
  });

  it("Gemini 3.6/3.7/3.8 Flash: el precio de hoy hasta el 31-dic incluido, el doble desde el 1-ene-2027", () => {
    for (const m of ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]) {
      expect(precioDeLista(m, DIC_31), m).toBe(CATALOGO[m]);
      expect(CATALOGO[m], m).toEqual({ inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 });
      expect(precioDeLista(m, ENE_01), m).toEqual(DOBLE);
      // Con prefijo de pasarela, con `Date` en vez de epoch y para la referencia.
      expect(precioDeLista(`google/${m}`, new Date(ENE_01)), m).toEqual(DOBLE);
      expect(precioDeListaPropio(m, ENE_01), m).toEqual(DOBLE);
      expect(precioDeListaPropio(`google/${m}`, DIC_31), m).toBe(CATALOGO[m]);
      // Un alias de letra sigue heredando para tarifar, y también al precio de SU día.
      expect(precioDeLista(`${m}-latest`, ENE_01), m).toEqual(DOBLE);
      expect(tramosDePrecio(m).map((t) => t.vigenteDesde ?? null), m).toEqual([null, "2027-01-01"]);
    }
  });

  it("una fila sin vigencia rige sin límite conocido, en cualquier fecha", () => {
    for (const m of ["gpt-4o-mini", "claude-opus-5-5", "gpt-6-luna", "gemini-3.5-flash"]) {
      expect(precioDeLista(m, 0), m).toBe(CATALOGO[m]);
      expect(precioDeLista(m, Date.parse("2100-01-01T00:00:00Z")), m).toBe(CATALOGO[m]);
    }
  });

  it("sin fecha, o con una que no lo es, se usa HOY", () => {
    expect(diaUtc(Number.NaN)).toBe(diaUtc());
    expect(diaUtc(Number.POSITIVE_INFINITY)).toBe(diaUtc());
    expect(diaUtc(1e20)).toBe(diaUtc());
    expect(diaUtc(DIC_31)).toBe("2026-12-31");
    expect(diaUtc(new Date(ENE_01))).toBe("2027-01-01");
    expect(precioDeLista("gemini-3.8-flash", Number.NaN)).toBe(precioDeLista("gemini-3.8-flash"));
  });

  it("cada fila de CATALOGO es la que rige el día del catálogo (la tabla pública no adelanta precios)", () => {
    for (const k of Object.keys(CATALOGO)) expect(precioDeListaPropio(k, AL_DIA), k).toBe(CATALOGO[k]);
  });

  it("y los techos del ingest SÍ ven los tramos anunciados (leen todo precio del fichero)", () => {
    // techo-precio-lectura.test.ts lee `cachedInputPer1k:` y `outputPer1k:` de todo
    // el fichero: un precio futuro por encima del techo lo pondría rojo HOY, antes
    // de que llegue su fecha.
    //
    // Contar, no «contiene»: 0.00015 es también la lectura de la fila
    // gemini-3.5-flash, así que un `toContain` pasaría aunque la regex no viera
    // ningún tramo. Se compara el MULTICONJUNTO que lee la regex de los techos
    // (la misma expresión que techo-precio-lectura.test.ts) con el de TODOS los
    // tramos —filas de CATALOGO y anunciados—, campo a campo: cada precio del
    // catálogo, de hoy o futuro, tiene que salir tantas veces como tramos lo
    // llevan, y nada más.
    const src = readFileSync(new URL("../src/pricing/catalogo.ts", import.meta.url), "utf8");
    const anunciados = Object.keys(CATALOGO).flatMap((k) => tramosDePrecio(k).slice(1));
    expect(anunciados.length, "hay tramos anunciados que comprobar").toBeGreaterThan(0);
    for (const campo of ["cachedInputPer1k", "outputPer1k", "inputPer1k"] as const) {
      const leidos = [...src.matchAll(new RegExp(`\\b${campo}:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
      const esperados = Object.keys(CATALOGO)
        .flatMap((k) => tramosDePrecio(k))
        .map((t) => t.precio[campo])
        .filter((v): v is number => v !== undefined);
      const orden = (xs: number[]) => [...xs].sort((a, b) => a - b);
      expect(orden(leidos), campo).toEqual(orden(esperados));
      // Y lo que de verdad importa a los techos: el máximo leído cubre el de
      // todos los tramos, anunciados incluidos.
      const maxAnunciado = Math.max(...anunciados.map((t) => t.precio[campo] ?? 0));
      expect(Math.max(...leidos), campo).toBeGreaterThanOrEqual(maxAnunciado);
    }
  });
});

/** Proveedor que contesta siempre con el mismo contador. */
class Fijo implements Provider {
  readonly id = "fijo";
  constructor(private readonly usage: ProviderResponse["usage"]) {}
  async generate(_req: ProviderRequest): Promise<ProviderResponse> {
    return { text: "ok", usage: this.usage };
  }
}

function capa(provider: Provider, now: number): SavingsPipeline {
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true, now: () => now } as never);
}

const PETICION = {
  model: "google/gemini-3.8-flash",
  messages: [{ role: "user", content: "hola" }],
} as SavingsRequest;

describe("la fecha de la petición llega al precio", () => {
  it("SDK: la misma petición cuesta el doble el 1-ene-2027 que el 31-dic-2026", async () => {
    const uso = { inputTokens: 10_000, outputTokens: 1_000 };
    const antes = await capa(new Fijo(uso), DIC_31).generate(PETICION);
    const despues = await capa(new Fijo(uso), ENE_01).generate(PETICION);
    const esperadoAntes = (10_000 / 1000) * 0.00075 + (1_000 / 1000) * 0.00375;
    expect(antes.report.cost.actual).toBeCloseTo(esperadoAntes, 10);
    expect(despues.report.cost.actual).toBeCloseTo(2 * esperadoAntes, 10);
    // Baseline y real con el MISMO precio: sin nada que optimizar, 0 de ahorro.
    expect(despues.report.cost.baselineEstimate).toBeCloseTo(despues.report.cost.actual, 10);
  });

  it("gateway: costeMedido tarifa con el instante de la petición y lo deja en el registro", () => {
    const uso = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 20_000 };
    const antes = costeMedido("gemini-3.8-flash", uso, DIC_31)!;
    const despues = costeMedido("gemini-3.8-flash", uso, ENE_01)!;
    expect(antes.precio).toBe(CATALOGO["gemini-3.8-flash"]);
    expect(despues.precio).toEqual(DOBLE);
    expect(despues.costeUsd).toBeCloseTo(2 * antes.costeUsd, 12);
    expect(despues.instante).toBe(ENE_01);
  });
});

describe("una petición, un día de precio", () => {
  // Contesta según el modelo y ADELANTA EL RELOJ tras la primera llamada: la
  // escalada que cruza la medianoche UTC del día del cambio de precio.
  class CruzaLaMedianoche implements Provider {
    readonly id = "cruza-la-medianoche";
    readonly llamadas: string[] = [];
    constructor(private readonly reloj: { ahora: number }) {}
    async generate(r: ProviderRequest): Promise<ProviderResponse> {
      this.llamadas.push(r.model);
      this.reloj.ahora = ENE_01 + 1_000;
      return r.model === "barato-casero"
        ? { text: "no json", usage: { inputTokens: 1_000, outputTokens: 50 } }
        : { text: '{"answer":"ok"}', usage: { inputTokens: 10_000, outputTokens: 1_000 } };
    }
  }

  it("SDK: una escalada que cruza la medianoche del cambio tarifa al fuerte con el precio del día en que EMPEZÓ", async () => {
    // Antes, `costModel` se resolvía al empezar y el precio del fuerte tras la
    // escalada con un `now()` nuevo: el barato con un día y el fuerte con el
    // siguiente, y el `actual` de una petición del 31-dic salía al precio de enero.
    const reloj = { ahora: DIC_31 - 1_000 };
    const p = new CruzaLaMedianoche(reloj);
    const capaConCascada = createSavingsLayer({
      provider: p,
      tokenizer: new TokenizerRegistry(),
      devUnlicensed: true,
      silenceWarnings: true,
      now: () => reloj.ahora,
      // El barato con precio del cliente (sin fecha), para que la única cifra con
      // vigencia en juego sea la del fuerte.
      costModels: { "barato-casero": { inputPer1k: 0.00001, outputPer1k: 0.00005 } },
      modelCascade: { pairs: { "gemini-3.8-flash": "barato-casero" } },
    } as never);
    const res = await capaConCascada.generate({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "resume en una frase" }],
      response: {
        contractId: "answer:v1",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["answer"],
          properties: { answer: { type: "string", maxLength: 200 } },
        },
      },
      savings: { modelCascade: "on" },
    } as SavingsRequest);

    expect(p.llamadas).toEqual(["barato-casero", "gemini-3.8-flash"]);
    expect(res.report.modelCascade!.escalated).toBe(true);
    const fuerte = CATALOGO["gemini-3.8-flash"]!; // el precio del 31-dic
    const servido =
      (res.report.tokens.actualInput / 1000) * fuerte.inputPer1k +
      (res.report.tokens.actualOutput / 1000) * fuerte.outputPer1k;
    const descartado = (1_000 / 1000) * 0.00001 + (50 / 1000) * 0.00005;
    expect(res.report.cost.actual).toBeCloseTo(servido + descartado, 10);
  });

  it("el simulador de sombra y la conciliación tarifan cada turno con SU fecha, no con la de hoy", () => {
    expect(preciosPara("gemini-3.8-flash", DIC_31)!.inputPer1k).toBe(CATALOGO["gemini-3.8-flash"]!.inputPer1k);
    expect(preciosPara("gemini-3.8-flash", ENE_01)!.inputPer1k).toBe(DOBLE.inputPer1k);

    const turno = (timestamp: string) =>
      ({
        sessionId: "00000000-0000-4000-8000-000000000000",
        requestId: "req_x",
        timestamp,
        model: "gemini-3.8-flash",
        proyecto: "?",
        subagente: false,
        usage: { input_tokens: 10_000, output_tokens: 1_000 },
      }) as TurnoTranscript;
    const dic = dineroDe(turno("2026-12-31T23:59:59.000Z"))!;
    const ene = dineroDe(turno("2027-01-01T00:00:01.000Z"))!;
    expect(dic).toBeCloseTo((10_000 / 1000) * 0.00075 + (1_000 / 1000) * 0.00375, 12);
    expect(ene).toBeCloseTo(2 * dic, 12);
  });
});
