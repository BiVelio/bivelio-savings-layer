/**
 * EL CSV DE LAS REPETICIONES MEDIDAS POR REFERENCIA (0029), en puro: lo que
 * descarga el enlace del extracto (`/api/org/reference-hits?periodo=`). Aparte
 * de la ruta porque un route handler de Next solo puede exportar sus métodos y
 * su configuración, y porque así se prueba sin red.
 */

/** La cabecera del CSV, en el orden de las columnas. */
export const CABECERA_CSV_REFERENCIAS =
  "request_id,day,model,cache_result,reference_request_id,reference_at,credited_input_tokens,credited_output_tokens,baseline_cost_usd";

/** Las columnas de bvsala.reference_hits que se leen, en el orden del CSV. */
export const COLUMNAS_REFERENCE_HITS =
  "request_id, day, model, cache_result, reference_request_id, reference_at, baseline_input_tokens, baseline_output_tokens, baseline_cost";

/** Una fila de bvsala.reference_hits tal como la devuelve PostgREST (numeric puede llegar como texto). */
export interface FilaDeReferencia {
  request_id: string;
  day: string;
  model: string;
  cache_result: string;
  reference_request_id: string | null;
  reference_at: string | null;
  baseline_input_tokens: number | string;
  baseline_output_tokens: number | string;
  baseline_cost: number | string;
}

/**
 * Una celda del CSV. Dos defensas:
 *   · INYECCIÓN DE FÓRMULAS: todo valor que empiece por `=`, `+`, `-` o `@` se
 *     prefija con `'`, o una hoja de cálculo lo ejecutaría al abrir el fichero.
 *   · RFC 4180: comillas, comas y saltos de línea van entre comillas dobles.
 */
export function celdaCsv(valor: unknown): string {
  let s = valor === null || valor === undefined ? "" : String(valor);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** El documento entero: la cabecera y una línea por acierto, con fin de línea CRLF (RFC 4180). */
export function csvDeReferencias(filas: FilaDeReferencia[]): string {
  const lineas = [CABECERA_CSV_REFERENCIAS];
  for (const f of filas) {
    lineas.push(
      [
        f.request_id,
        f.day,
        f.model,
        f.cache_result,
        f.reference_request_id,
        f.reference_at,
        f.baseline_input_tokens,
        f.baseline_output_tokens,
        f.baseline_cost,
      ]
        .map(celdaCsv)
        .join(","),
    );
  }
  return `${lineas.join("\r\n")}\r\n`;
}
