import { subconjuntoBivelio, tieneDinero } from "./atributos.js";
import { sinPrefijoConocido } from "./proveedor.js";
import type { LangfuseGenerationUpdate, SavingsReportForExport } from "./tipos.js";

// La forma que acepta `generation.update()` de @langfuse/tracing: `model`,
// `usageDetails: Record<string, number>`, `costDetails: Record<string, number>`
// y `metadata`. Fijada leyendo los tipos de @langfuse/core 5.11.1 en npm
// (publicada el 2026‑09‑09; consultada el 2026‑09‑27), sin depender del paquete.
//
// `usageDetails` va en CUBOS EXCLUSIVOS, como los normaliza Langfuse («Cache
// reads and writes are subtracted from `input`»,
// https://langfuse.com/docs/observability/features/token-and-cost-tracking):
// `input` = actualInput − lecturas de caché. Las ESCRITURAS no se pueden
// separar porque el informe no las desglosa (en Anthropic van dentro de
// actualInput); Langfuse las verá como `input` normal.

/**
 * The fields to pass to a Langfuse generation's `update()` when you trace with
 * `@langfuse/tracing` by hand: `generation.update(toLangfuseGeneration(report))`.
 *
 * - `model` drops a known provider prefix (`openai/gpt-4o-mini` becomes
 *   `gpt-4o-mini`), so Langfuse can match it to its price table.
 * - `usageDetails` uses exclusive buckets: `input` excludes
 *   `cache_read_input_tokens`. Cache writes are not broken out in the report, so
 *   they stay inside `input`. Left out when the provider reported no usage.
 * - `costDetails` is `{ total: report.cost.actual }` only with
 *   `includeCost: true`, when `currency` is "USD" (Langfuse reads it as USD) and
 *   the basis has money. It includes the cache-write premium; Langfuse then
 *   uses it instead of its own estimate.
 * - `metadata` holds the savings figures (`bivelio_*`), one saving key per basis.
 */
export function toLangfuseGeneration(
  report: SavingsReportForExport,
  options?: { currency?: string; includeCost?: boolean },
): LangfuseGenerationUpdate {
  const currency = options?.currency ?? "USD";
  const out: LangfuseGenerationUpdate = {
    model: sinPrefijoConocido(report.model),
    metadata: subconjuntoBivelio(report, currency),
  };
  if (tieneDinero(report.cost.basis)) {
    const { actualInput, actualOutput, providerCachedInput } = report.tokens;
    const uso: Record<string, number> = {
      input: Math.max(0, actualInput - (providerCachedInput ?? 0)),
      output: actualOutput,
    };
    if (providerCachedInput !== undefined) uso.cache_read_input_tokens = providerCachedInput;
    out.usageDetails = uso;
    if (options?.includeCost && currency === "USD" && Number.isFinite(report.cost.actual)) {
      out.costDetails = { total: report.cost.actual };
    }
  }
  return out;
}
