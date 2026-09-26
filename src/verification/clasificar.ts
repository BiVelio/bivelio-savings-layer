import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import type { VerificationExclusion, VerificationStratum } from "../contracts/verification.js";
import type { CostModel } from "../tokenizer/accounting.js";

/** Por dónde salió la petición servida: el camino optimizado o el rescate (fail-open). */
export type ViaDeServicio = "optimizado" | "fail-open";

export type Clase = { estrato: VerificationStratum } | { excluida: VerificationExclusion };

// LA POBLACIÓN DE LA VERIFICACIÓN (D5): peticiones servidas INTACTAS por el
// optimizador, incluido el estrato `unchanged` (mirar solo donde la capa actúa
// sería la cifra halagüeña). Todo lo demás se EXCLUYE, se cuenta y se enseña.
//
// Orden fijo: la primera regla que se cumple gana. El precio es el CONOCIDO
// (cliente o catálogo), NUNCA el `DEFAULT_COST_MODEL` ilustrativo: una copia
// valorada con un precio inventado no es una medición.
//
// SIMETRÍA: las reglas que miran la RESPUESTA (cortada, parada, contrato) se le
// aplican también a la copia, en el panel (`motivoDeNoComparable`, apps/web/lib/
// verificacion/banco-propio.ts). Si solo se aplicaran aquí, la selección sería
// de un lado y se inventaría ahorro: con el mismo tope, la copia cortada es la
// salida más cara. Quien cambie una de las dos, cambia las dos.
export function clasificar(ctx: {
  request: SavingsRequest;
  result: SavingsResult<unknown>;
  via: ViaDeServicio;
  precio: (model: string) => CostModel | undefined;
  tope?: number;
}): Clase {
  const { request, result, via } = ctx;
  const r = result.report;
  if (via === "fail-open") return { excluida: "fail_open" };
  if (request.savings?.verification === false) return { excluida: "opted_out" };
  const fin = result.finishReason;
  if (fin === "length") return { excluida: "truncated" };
  if (fin !== undefined && fin !== "stop" && fin !== "tool_calls") return { excluida: "incomplete" };
  if (r.constraints.structurallyValid === false || r.qualityStatus === "rejected") {
    return { excluida: "contract_failed" };
  }
  if (r.cost.basis === "unmeasured") return { excluida: "unmeasured" };
  if (r.calls.actualRetrieval > 0) return { excluida: "retrieval" };
  if (ctx.precio(request.model) === undefined || ctx.precio(r.model) === undefined) {
    return { excluida: "no_price" };
  }
  if (ctx.tope !== undefined && r.cost.baselineEstimate > ctx.tope) return { excluida: "over_cap" };

  if (r.calls.avoidedLlm > 0) return { estrato: "avoided_call" };
  if (r.model !== request.model) return { estrato: "cheaper_model" };
  if (r.tokens.eliminatedInput > 0) return { estrato: "tokens_removed" };
  if (r.tokens.compressedInput > 0) return { estrato: "tokens_compressed" };
  return { estrato: "unchanged" };
}
