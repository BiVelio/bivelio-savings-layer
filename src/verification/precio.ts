import type { CostModel } from "../tokenizer/accounting.js";
import type { ProviderUsage } from "../providers/types.js";

// EL PRECIO DE UNA COPIA, con la MISMA aritmética que `SavingsLedger.estimateCost`
// aplica a `actual` (test/precio-de-uso-igual-al-ledger.test.ts lo ata bit a bit):
//
//   c = min(cached, in)
//   ((in − c)/1000)·inputPer1k + (c/1000)·(cachedInputPer1k ?? inputPer1k) + (out/1000)·outputPer1k
//
// redondeado a 1e-10, como `roundUsd`. La web porta esta función TAL CUAL para
// su comprobación de consistencia (apps/web/lib/verificacion/wire.ts).
//
// NO suma la prima de escritura de caché (`cacheWriteInputTokens`): la copia no
// lleva marcas de caché, y si un proveedor la cobrara igualmente, sumarla solo
// ENCARECERÍA la copia — el lado halagüeño para la capa. Ante la duda, fuera.
export function precioDelUso(
  usage: Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">,
  p: CostModel,
): number {
  const entrada = usage.inputTokens;
  const cached = Math.min(usage.cachedInputTokens ?? 0, entrada);
  const cachedRate = p.cachedInputPer1k ?? p.inputPer1k;
  const coste =
    (Math.max(0, entrada - cached) / 1000) * p.inputPer1k +
    (cached / 1000) * cachedRate +
    (usage.outputTokens / 1000) * p.outputPer1k;
  return Math.round(coste * 1e10) / 1e10;
}
