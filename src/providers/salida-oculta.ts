// ═══════════════════════════════════════════════════════════════════════════
// LA SALIDA FACTURADA QUE `completion_tokens` NO CUENTA.
// ═══════════════════════════════════════════════════════════════════════════
//
// En el API de OpenAI `completion_tokens` YA incluye el razonamiento oculto
// (`completion_tokens_details.reasoning_tokens` es un desglose de lo que ya está
// dentro) y `total_tokens = prompt_tokens + completion_tokens`.
//
// El endpoint compatible con OpenAI de Gemini no: su `completion_tokens` son
// solo los tokens de la respuesta, el pensamiento no sale en ningún desglose y
// solo aparece en `total_tokens`. Sonda en vivo del 2026-09-29 contra
// gemini-3.5-flash, «What is 17*23?»: `{prompt_tokens: 16, completion_tokens:
// 3, total_tokens: 211}` en JSON y `{16, 3, 165}` en el último chunk del stream,
// sin `completion_tokens_details`. Y Google factura ese pensamiento como
// salida:
//   · https://ai.google.dev/gemini-api/docs/pricing («Output price (including
//     thinking tokens)», «Last updated 2026-09-24 UTC»);
//   · https://ai.google.dev/gemini-api/docs/thinking («When thinking is turned
//     on, response pricing is the sum of output tokens and thinking tokens»,
//     «Last updated 2026-09-25 UTC»);
//   · https://ai.google.dev/api/generate-content, `UsageMetadata.totalTokenCount`:
//     «Total token count for the generation request (prompt + thoughts +
//     response candidates)» («Last updated 2026-09-23 UTC»).
// Todas consultadas el 2026-09-29.
//
// Leer solo `completion_tokens` dejaba el coste de la capa en una fracción de
// la factura (bancos de gama alta contra la 0.4.31, PRs #396 y #397): en
// XSTest, el brazo B de gemini-3.1-pro-preview facturó 0,6858 $ y la capa
// informó 0,1630 $; las 211 llamadas de Flash cuyo coste no cuadraba cuadran
// exactamente al quitar el pensamiento.
//
// La regla: lo que `total_tokens` tiene de más sobre `prompt_tokens +
// completion_tokens` es salida facturada que el contador de salida no trae. Solo
// con los tres contadores presentes, enteros y no negativos; si falta uno, 0
// (no se inventa nada). Quien habla con el API oficial de OpenAI no la aplica:
// allí el hueco es 0 por definición y no hay nada que sumar dos veces.
//
// PURO Y SIN IMPORTS: la usan el adaptador compatible con OpenAI y el gateway.

function enteroNoNegativo(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Tokens de salida facturados que `completion_tokens` no incluye:
 * `total_tokens − prompt_tokens − completion_tokens` si es positivo, 0 en
 * cualquier otro caso (contadores ausentes, no enteros, o sin hueco).
 */
export function salidaOculta(
  uso: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null | undefined,
): number {
  if (!uso) return 0;
  const { prompt_tokens: p, completion_tokens: c, total_tokens: t } = uso;
  if (!enteroNoNegativo(p) || !enteroNoNegativo(c) || !enteroNoNegativo(t)) return 0;
  return Math.max(0, t - p - c);
}
