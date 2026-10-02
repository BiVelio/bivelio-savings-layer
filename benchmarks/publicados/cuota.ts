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

/**
 * LA SOBRECARGA DEL PROVEEDOR TAMPOCO ES UN FALLO DE LA CAPA.
 * ---------------------------------------------------------------------------
 * Hallazgo del run 36998187601 (banco semanal en vivo, 0.5.0-rc.1): GSM8K con
 * claude-opus-5-5, brazo B, posición 6: `provider 529 overloaded_error` tras
 * 108 s, es decir, tras agotar la escalera ENTERA de `conReintentos` (6 intentos,
 * esperas de 2/5/10/20/40 s). Los cuatro brazos usan ese mismo envoltorio POR
 * DEBAJO de la capa (gsm8k/arnes.ts: `conContador(conReintentos(o.crudo()))`),
 * así que la capa no reintenta menos que A: recibe el error cuando ya no queda
 * reintento. Y A vio la misma sobrecarga: su posición 11 tardó 71 s (S, 73 s;
 * E, 57 s; mediana del banco, 2 s), la misma escalera, que esta vez acabó en 200.
 * Un 529 que sobrevive a todos los reintentos dice algo del proveedor en ese
 * minuto, no de lo que la capa hizo con la petición.
 *
 * Qué cuenta como sobrecarga, y NADA MÁS: el código 529 (Anthropic,
 * `overloaded_error`) y un 503 cuyo cuerpo dice «overloaded» (Google, «The model
 * is overloaded»). Un 500, 502 o 504 sin más, un 400 o un timeout siguen siendo
 * errores normales, y cuentan como `capa-falla` si solo los ve la capa.
 */
const SOBRECARGA_529 = /\b(?:provider|HTTP|status|code)["'\s:=]*529\b|overloaded_error/i;
const SOBRECARGA_503 = /\b(?:provider|HTTP|status|code)["'\s:=]*503\b/i;

/** ¿Es este error del proveedor una sobrecarga (529, o 503 «overloaded»)? */
export function esSobrecargaDelProveedor(error: string | null | undefined, status?: number | null): boolean {
  if (status === 529) return true;
  if (typeof error !== "string") return false;
  if (SOBRECARGA_529.test(error)) return true;
  return (status === 503 || SOBRECARGA_503.test(error)) && /\boverloaded\b/i.test(error);
}

/**
 * Lo que saca un ítem de la comparación en los dos brazos: la cuota (429) o la
 * sobrecarga (529) del proveedor. Mismo trato, misma condición: solo si el brazo
 * con la capa no mandó más peticiones que A (`cuotaAtribuible`, extraer.ts).
 */
export function esErrorNoMedibleDelProveedor(error: string | null | undefined, status?: number | null): boolean {
  return esErrorDeCuota(error, status) || esSobrecargaDelProveedor(error, status);
}
