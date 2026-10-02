import type { CostBasis } from "../tokenizer/accounting.js";
import { BV_SALA_VERSION } from "../version.js";
import { formatearDecimal } from "./csv.js";
import { sinPrefijoConocido } from "./proveedor.js";
import type {
  SavingsAttributeOptions,
  SavingsReportForExport,
  SavingsSpanAttributes,
} from "./tipos.js";

// ── Claves GenAI ─────────────────────────────────────────────────────────────
// De las GenAI semantic conventions v1.41.1 (2026‑05‑11), la última versión
// PUBLICADA. La 1.42.0 las marca obsoletas en el núcleo y las mueve a
// open-telemetry/semantic-conventions-genai, que aún no tiene ninguna release
// (manifest `1.42.0-dev`). Solo se usan claves que existen en las DOS: en
// particular NO se emite `cache_creation.input_tokens` (renombrada
// `cache_write` en el repo nuevo) porque el informe no desglosa las escrituras,
// y NO hay atributo de coste (`gen_ai.usage.cost.*` es la PR abierta #443).
//   https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml
//   https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/registry.yaml
// Consultados el 2026‑09‑27.
export const GEN_AI = {
  operacion: "gen_ai.operation.name",
  proveedor: "gen_ai.provider.name",
  modeloPedido: "gen_ai.request.model",
  temperatura: "gen_ai.request.temperature",
  semilla: "gen_ai.request.seed",
  maxTokens: "gen_ai.request.max_tokens",
  stream: "gen_ai.request.stream",
  conversacion: "gen_ai.conversation.id",
  modeloRespuesta: "gen_ai.response.model",
  motivosDeFin: "gen_ai.response.finish_reasons",
  primerTrozo: "gen_ai.response.time_to_first_chunk",
  entrada: "gen_ai.usage.input_tokens",
  salida: "gen_ai.usage.output_tokens",
  lecturaDeCache: "gen_ai.usage.cache_read.input_tokens",
} as const;

// `error.type` es del registry general (no GenAI) y es estable.
export const ERROR_TYPE = "error.type";

// ── Claves propias ───────────────────────────────────────────────────────────
// `com.bivelio.*`: OTel recomienda el dominio inverso para los atributos que
// distribuye una empresa, y no reutilizar espacios de nombres de semconv
// (docs/general/naming.md de semantic-conventions v1.44.0, consultado el
// 2026‑09‑27). Ninguna clave es a la vez hoja y espacio de nombres; por eso
// `model.id` y no `model`.
const P = "com.bivelio.";
export const CLAVE_REQUEST_SENT = `${P}stream.request_sent`;

// Los tres basis cuyo dinero se exporta, cada uno en SU clave. `unmeasured` no
// tiene dinero que reclamar y `shadow` es hipotético: ninguno de los dos saca
// dinero, y ninguna clave suma bases.
export type BasisConDinero = "measured" | "reference" | "estimated";

export function tieneDinero(basis: CostBasis): basis is BasisConDinero {
  return basis === "measured" || basis === "reference" || basis === "estimated";
}

/** Redondeo a 1e-10, el mismo que `roundUsd`; y sin `-0`. */
export function redondear(n: number): number {
  const r = Math.round(n * 1e10) / 1e10;
  return r === 0 ? 0 : r;
}

/** El dinero ahorrado de un informe: `baselineEstimate − actual`. Con signo. */
export function ahorroDe(report: SavingsReportForExport): number {
  return redondear(report.cost.baselineEstimate - report.cost.actual);
}

function poner(destino: SavingsSpanAttributes, clave: string, valor: unknown): void {
  if (typeof valor === "string" || typeof valor === "boolean") destino[clave] = valor;
  else if (typeof valor === "number" && Number.isFinite(valor)) destino[clave] = valor;
}

/**
 * El subconjunto de cifras que se copia en Langfuse y Datadog, con claves
 * `bivelio_*`. Las mismas reglas de omisión que los atributos: sin dinero con
 * `unmeasured` ni `shadow`, y el ahorro en la clave de SU basis.
 */
export function subconjuntoBivelio(
  report: SavingsReportForExport,
  currency: string,
): Record<string, string | number> {
  const { cost, tokens, calls, cache } = report;
  const s: Record<string, string | number> = {
    bivelio_request_id: report.requestId,
    bivelio_basis: cost.basis,
    bivelio_currency: currency,
  };
  if (tieneDinero(cost.basis)) {
    s.bivelio_baseline_cost = cost.baselineEstimate;
    s.bivelio_actual_cost = cost.actual;
    s[`bivelio_saved_${cost.basis}`] = ahorroDe(report);
    s.bivelio_net_savings_ratio = cost.netSavingsRatio;
  }
  s.bivelio_avoided_calls = calls.avoidedLlm;
  s.bivelio_eliminated_input_tokens = tokens.eliminatedInput;
  s.bivelio_compressed_input_tokens = tokens.compressedInput;
  if (tokens.providerCachedInput !== undefined) {
    s.bivelio_provider_cached_input_tokens = tokens.providerCachedInput;
  }
  s.bivelio_cache_result = cache.result;
  if (report.qualityStatus !== undefined) s.bivelio_quality_status = report.qualityStatus;
  // Nada que no sea finito: un NaN en metadata es peor que su ausencia.
  for (const [k, v] of Object.entries(s)) if (typeof v === "number" && !Number.isFinite(v)) delete s[k];
  return s;
}

/**
 * Los atributos GenAI que salen del INFORME: el modelo que respondió y el uso.
 * Sin uso con `unmeasured` (ausente no es 0: doctrina de `ProviderUsage`) ni con
 * `shadow` (no es una llamada que ocurriera). En una llamada evitada el uso es
 * 0, y es verdad: no se facturó ningún token.
 */
export function atributosGenAiDelInforme(report: SavingsReportForExport): SavingsSpanAttributes {
  const a: SavingsSpanAttributes = {};
  poner(a, GEN_AI.modeloRespuesta, sinPrefijoConocido(report.model));
  if (tieneDinero(report.cost.basis)) {
    poner(a, GEN_AI.entrada, report.tokens.actualInput);
    poner(a, GEN_AI.salida, report.tokens.actualOutput);
    if (report.tokens.providerCachedInput !== undefined) {
      poner(a, GEN_AI.lecturaDeCache, report.tokens.providerCachedInput);
    }
  }
  return a;
}

/**
 * The `com.bivelio.*` attributes for one report: the four ledgers, the basis,
 * the cost and the ids. Money is in `options.currency` (default "USD"), and the
 * money saved goes in one key per basis (`com.bivelio.cost.saved.measured`,
 * `.reference`, `.estimated`), so a sum over one key never mixes measured and
 * estimated money. `unmeasured` and `shadow` reports carry their counters and
 * no money. Nothing here is content: only ids, counts, money and enums.
 */
export function savingsSpanAttributes(
  report: SavingsReportForExport,
  options?: SavingsAttributeOptions,
): SavingsSpanAttributes {
  const currency = options?.currency ?? "USD";
  const { cost, tokens, calls, cache } = report;
  const a: SavingsSpanAttributes = {};

  poner(a, `${P}request_id`, report.requestId);
  poner(a, `${P}sdk.version`, BV_SALA_VERSION);
  poner(a, `${P}model.id`, report.model);
  poner(a, `${P}model.requested_id`, report.modelCascade?.requestedModel);

  poner(a, `${P}cost.basis`, cost.basis);
  poner(a, `${P}cost.currency`, currency);
  if (tieneDinero(cost.basis)) {
    poner(a, `${P}cost.baseline`, cost.baselineEstimate);
    poner(a, `${P}cost.actual`, cost.actual);
    // `netSavings` es una PROPORCIÓN (1 − actual/baseline); el dinero es la
    // diferencia. Las dos salen, cada una con su nombre, para que nadie sume
    // proporciones creyendo que suma dólares.
    poner(a, `${P}cost.saved.${cost.basis}`, ahorroDe(report));
    poner(a, `${P}cost.net_savings_ratio`, cost.netSavingsRatio);
    poner(a, `${P}cost.eliminated_input_floor`, cost.eliminatedInputFloorCost);
  }

  poner(a, `${P}calls.baseline`, calls.baselineLlm);
  poner(a, `${P}calls.actual`, calls.actualLlm);
  poner(a, `${P}calls.avoided`, calls.avoidedLlm);
  poner(a, `${P}calls.retries`, calls.retries);

  poner(a, `${P}tokens.baseline_input`, tokens.baselineInput);
  poner(a, `${P}tokens.actual_input`, tokens.actualInput);
  poner(a, `${P}tokens.eliminated_input`, tokens.eliminatedInput);
  poner(a, `${P}tokens.compressed_input`, tokens.compressedInput);
  poner(a, `${P}tokens.provider_cached_input`, tokens.providerCachedInput);
  poner(a, `${P}tokens.baseline_output`, tokens.baselineOutput);
  poner(a, `${P}tokens.actual_output`, tokens.actualOutput);
  poner(a, `${P}tokens.eliminated_output`, tokens.eliminatedOutput);

  poner(a, `${P}cache.result`, cache.result);
  poner(a, `${P}cache.reference_request_id`, cache.reference?.requestId);
  poner(a, `${P}cache.reference_rejected`, cache.referenceRejected);
  poner(a, `${P}quality.status`, report.qualityStatus);
  poner(a, `${P}latency.preprocessing_ms`, report.latencyMs?.preprocessing);
  poner(a, `${P}latency.provider_ms`, report.latencyMs?.provider);

  const espejo = options?.langfuse?.metadata || options?.datadog?.metadata;
  const sub = espejo ? subconjuntoBivelio(report, currency) : undefined;
  if (sub && options?.langfuse?.metadata) {
    // Como su SDK: `langfuse.observation.metadata.<clave>` con valor string, que
    // Langfuse convierte en metadata de primer nivel y filtrable.
    for (const [k, v] of Object.entries(sub)) {
      a[`langfuse.observation.metadata.${k}`] = typeof v === "number" ? formatearDecimal(v) : v;
    }
  }
  // Langfuse lee `cost_details` en USD y lo prefiere a su propia estimación:
  // solo se escribe cuando el dinero ES en USD y el basis tiene dinero.
  if (options?.langfuse?.cost && currency === "USD" && tieneDinero(cost.basis) && Number.isFinite(cost.actual)) {
    a["langfuse.observation.cost_details"] = JSON.stringify({ total: cost.actual });
  }
  if (sub && options?.datadog?.metadata) {
    const bivelio: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(sub)) bivelio[k.replace(/^bivelio_/, "")] = v;
    a["_dd.ml_obs.metadata"] = JSON.stringify({ bivelio });
  }
  return a;
}
