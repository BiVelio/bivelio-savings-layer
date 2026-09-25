/**
 * EL CSV DE «TU PROPIO BANCO», en puro: una fila por petición comprobada, con
 * los dos lados del par. Lo que descarga el enlace del panel
 * (`/api/org/verification-pairs?range=` o `?dia=`).
 *
 * Mismo diseño a escala que el CSV de las repeticiones medidas por referencia
 * (lib/metering/referencias-csv.ts, de donde se reutilizan la celda, los días y
 * los topes): lectura por día con paginación POR CLAVE sobre el índice
 * (org_id, day, request_id) de 0030, en streaming, 413 por encima de un millón.
 *
 * NO HAY COLUMNAS CON SIGNO: cada lado va por separado (tokens, coste, tarifas)
 * y la diferencia se deriva de A y B. Así una celda nunca empieza por «-» (y si
 * alguna lo hiciera, `celdaCsv` la prefija con `'`).
 */
import { bloqueGenerico, type FilaCsv } from "./csv-bloque";

export const CABECERA_CSV_VERIFICACION =
  "request_id,day,at,stratum,outcome,requested_model,served_model,cache_result," +
  "naive_input_tokens,naive_cached_input_tokens,naive_output_tokens,naive_cost_usd,naive_finish_reason,naive_contract," +
  "optimized_input_tokens,optimized_cached_input_tokens,optimized_output_tokens,optimized_cost_usd," +
  "input_per_1k,cached_input_per_1k,output_per_1k";

/**
 * Las columnas de bvsala.verification_samples que se leen, en el orden del CSV.
 * Dinero y tarifas como TEXTO (`::text`): numeric(20,10) exacto, sin notación
 * exponencial.
 */
export const COLUMNAS_VERIFICATION_SAMPLES =
  "request_id, day, at, stratum, outcome, requested_model, served_model, cache_result, " +
  "naive_input_tokens, naive_cached_input_tokens, naive_output_tokens, naive_cost::text, naive_finish_reason, naive_contract, " +
  "optimized_input_tokens, optimized_cached_input_tokens, optimized_output_tokens, optimized_cost::text, " +
  "input_per_1k::text, cached_input_per_1k::text, output_per_1k::text";

/** El orden de las celdas: las claves de la fila tal como las devuelve PostgREST. */
export const ORDEN_DE_CELDAS = [
  "request_id",
  "day",
  "at",
  "stratum",
  "outcome",
  "requested_model",
  "served_model",
  "cache_result",
  "naive_input_tokens",
  "naive_cached_input_tokens",
  "naive_output_tokens",
  "naive_cost",
  "naive_finish_reason",
  "naive_contract",
  "optimized_input_tokens",
  "optimized_cached_input_tokens",
  "optimized_output_tokens",
  "optimized_cost",
  "input_per_1k",
  "cached_input_per_1k",
  "output_per_1k",
] as const;

export type FilaDeVerificacion = FilaCsv & Partial<Record<(typeof ORDEN_DE_CELDAS)[number], unknown>>;

/** Un bloque de líneas del CSV, cada una con su CRLF. */
export function bloqueCsvVerificacion(filas: readonly FilaDeVerificacion[]): string {
  return bloqueGenerico(filas, ORDEN_DE_CELDAS);
}

/** El documento entero en memoria: solo para volúmenes pequeños y tests. */
export function csvDeVerificacion(filas: readonly FilaDeVerificacion[]): string {
  return `${CABECERA_CSV_VERIFICACION}\r\n${bloqueCsvVerificacion(filas)}`;
}

export type LectorDePaginaDeVerificacion = (dia: string, despuesDe: string | null, tam: number) => Promise<FilaDeVerificacion[]>;
