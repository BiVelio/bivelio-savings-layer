/**
 * LA CUOTA DEL PROVEEDOR NO ES UN FALLO DE LA CAPA.
 * ---------------------------------------------------------------------------
 * Hallazgo del run 36786990486 (banco semanal en vivo): la clave de Gemini
 * agotó su cuota diaria de gemini-3.1-pro-preview (`generate_requests_per_model_per_day`,
 * límite 250, compartida con otros bancos) y dos de esos 429 cayeron por azar
 * en el brazo B de MT-Bench: el banco lo contó como `capa-falla` y bloqueó la
 * release. Un 429 por cuota o por límite de tasa dice algo de la CLAVE, no de
 * lo que la capa hizo con la petición.
 *
 * Lo comparten los arneses (GSM8K excluye esos ítems de su comparación) y el
 * extractor del banco semanal (benchmarks/banco-semanal/extraer.ts), que los
 * excluye en los dos brazos y los cuenta aparte.
 *
 * Qué cuenta como cuota: el código HTTP 429 (en el `status` o en el texto del
 * error tal como lo escribe cada arnés: «provider 429», «HTTP 429», `"code": 429`)
 * o el cuerpo de error del proveedor con `RESOURCE_EXHAUSTED` (Google),
 * «exceeded your current quota» (Google, OpenAI) o «rate limit» (OpenAI,
 * Anthropic `rate_limit_error`). Nada más: un 400, un 5xx o un timeout siguen
 * siendo errores normales.
 */

const CUOTA = /\b(?:provider|HTTP|status|code)["'\s:=]*429\b|RESOURCE_EXHAUSTED|exceeded your (?:current )?quota|rate[ _-]?limit/i;

/** ¿Es este error del proveedor un 429 por cuota o por límite de tasa? */
export function esErrorDeCuota(error: string | null | undefined, status?: number | null): boolean {
  if (status === 429) return true;
  return typeof error === "string" && CUOTA.test(error);
}
