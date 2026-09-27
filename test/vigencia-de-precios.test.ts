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

  it("los tramos anunciados no cambian lo que lee el vigía: su regex solo ve las filas de CATALOGO", () => {
    // La misma expresión que scripts/vigia-precios.mjs. Si un tramo futuro casara,
    // pisaría la fila de hoy en su mapa y el vigía compararía el precio de 2027
    // contra la referencia de 2026: rojo falso cada semana.
    const src = readFileSync(new URL("../src/pricing/catalogo.ts", import.meta.url), "utf8");
    const rx = /"([a-z0-9.\-]+)":\s*\{\s*inputPer1k:\s*([\d.]+),\s*outputPer1k:\s*([\d.]+)(?:,\s*cachedInputPer1k:\s*([\d.]+))?/g;
    const vistos = new Map<string, { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number }>();
    for (const m of src.matchAll(rx)) {
      vistos.set(m[1]!, {
        inputPer1k: Number(m[2]),
        outputPer1k: Number(m[3]),
        ...(m[4] !== undefined ? { cachedInputPer1k: Number(m[4]) } : {}),
      });
    }
    expect([...vistos.keys()].sort()).toEqual(Object.keys(CATALOGO).sort());
    for (const [k, v] of vistos) expect(v, k).toEqual(CATALOGO[k]);
  });

  it("y los techos del ingest SÍ ven los tramos anunciados (leen todo precio del fichero)", () => {
    // techo-precio-lectura.test.ts lee `cachedInputPer1k:` y `outputPer1k:` de todo
    // el fichero: un precio futuro por encima del techo lo pondría rojo HOY, antes
    // de que llegue su fecha.
    const src = readFileSync(new URL("../src/pricing/catalogo.ts", import.meta.url), "utf8");
    const lecturas = [...src.matchAll(/\bcachedInputPer1k:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(lecturas).toContain(DOBLE.cachedInputPer1k);
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
