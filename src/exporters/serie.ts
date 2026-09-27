import {
  agregar,
  dineroDe,
  etiquetas,
  isoUtc,
  textoEstable,
  validarGranularidad,
  validarMoneda,
} from "./agregado.js";
import type { SavingsRecord, SavingsSeriesOptions, SavingsSeriesRow } from "./tipos.js";

// La serie existe porque Vantage ignora las columnas `x_` de un Custom Provider
// y en Finout y CloudZero el ahorro encaja como telemetría o métrica, no como
// coste (docs de cada uno, consultadas el 2026‑09‑27). Es el MISMO agregado que
// FOCUS (agregado.ts), sin la parte de cuenta y proveedor.

// Las claves fijas de una fila: una dimensión con uno de estos nombres chocaría
// al aplanar la fila en columnas (lo que hace quien la sube como CSV).
const CLAVES_FIJAS: ReadonlySet<string> = new Set<keyof SavingsSeriesRow>([
  "periodStart",
  "periodEnd",
  "date",
  "model",
  "basis",
  "currency",
  "requests",
  "providerCalls",
  "avoidedCalls",
  "baselineCost",
  "actualCost",
  "measuredSavings",
  "referenceSavings",
  "estimatedSavings",
  "eliminatedInputFloorCost",
  "baselineInputTokens",
  "actualInputTokens",
  "eliminatedInputTokens",
  "compressedInputTokens",
  "providerCachedInputTokens",
  "baselineOutputTokens",
  "actualOutputTokens",
  "eliminatedOutputTokens",
  "dimensions",
]);

const FN = "toSavingsSeries";

/**
 * Savings per period (UTC day by default), model, basis and your own
 * dimensions: the series to load as a business metric or telemetry stream in a
 * FinOps tool. Same aggregation as {@link toFocusRows}.
 *
 * Each saving column holds money of its own basis only, and `shadow` reports
 * are left out. For a metric that should match your provider invoice, use
 * `measuredSavings` and `referenceSavings`; `estimatedSavings` has its own
 * column on purpose. Throws a TypeError on an invalid `at`, currency or
 * dimension.
 */
export function toSavingsSeries(
  records: Iterable<SavingsRecord>,
  options?: SavingsSeriesOptions,
): SavingsSeriesRow[] {
  const g = validarGranularidad(options?.granularity, FN);
  const currency = validarMoneda(options?.currency, FN);
  const dimensiones = options?.dimensions;
  const grupos = agregar(records, g, FN, (r) => {
    const d = dimensiones ? etiquetas(dimensiones(r), "dimensions", FN) : {};
    for (const k of Object.keys(d)) {
      if (CLAVES_FIJAS.has(k)) throw new TypeError(`[bvsala] ${FN}: dimension "${k}" repeats a column of the series`);
    }
    return { clave: textoEstable(d), extra: d };
  });
  return grupos.map((grupo) => {
    const dinero = dineroDe(grupo);
    const inicio = isoUtc(grupo.inicio);
    return {
      periodStart: inicio,
      periodEnd: isoUtc(grupo.fin),
      date: inicio.slice(0, 10),
      model: grupo.modelo,
      basis: grupo.basis,
      currency,
      requests: grupo.peticiones,
      providerCalls: grupo.llamadas,
      avoidedCalls: grupo.evitadas,
      baselineCost: dinero.baseline,
      actualCost: dinero.actual,
      measuredSavings: dinero.measured,
      referenceSavings: dinero.reference,
      estimatedSavings: dinero.estimated,
      eliminatedInputFloorCost: dinero.suelo,
      baselineInputTokens: grupo.tokens.baselineInput,
      actualInputTokens: grupo.tokens.actualInput,
      eliminatedInputTokens: grupo.tokens.eliminatedInput,
      compressedInputTokens: grupo.tokens.compressedInput,
      providerCachedInputTokens: grupo.tokens.providerCachedInput ?? null,
      baselineOutputTokens: grupo.tokens.baselineOutput,
      actualOutputTokens: grupo.tokens.actualOutput,
      eliminatedOutputTokens: grupo.tokens.eliminatedOutput,
      dimensions: Object.freeze({ ...grupo.extra }),
    };
  });
}
