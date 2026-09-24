/**
 * EL CSV DE LAS REPETICIONES MEDIDAS POR REFERENCIA (0029), en puro: lo que
 * descarga el enlace del extracto (`/api/org/reference-hits?periodo=` o
 * `?dia=`). Aparte de la ruta porque un route handler de Next solo puede
 * exportar sus métodos y su configuración, y porque así se prueba sin red.
 *
 * A ESCALA (revisión adversaria de PR-A): el carril cobra justo en el tráfico
 * repetido, y ahí el volumen es de millones de filas al mes (la §12 de la
 * especificación: ≈ 1 M de aciertos de FAQ en gpt-4o-mini, ≈ 26 M en el
 * arquetipo A). Cargar el mes en memoria y paginar por OFFSET (cada página
 * reordena y salta todas las anteriores: coste cuadrático) agotaba el tiempo o
 * la memoria de la función precisamente con los clientes a los que se cobra.
 * Por eso:
 *   · se lee POR DÍA y con paginación POR CLAVE (`day = d and request_id >
 *     último order by request_id limit 1000`) sobre el índice (org_id, day,
 *     request_id) de 0029: cada página cuesta lo mismo, sea la primera o la
 *     milésima;
 *   · se sirve en STREAMING, página a página, sin acumular el documento;
 *   · un período con más de MAX_FILAS_POR_DESCARGA filas no se intenta: la
 *     ruta responde 413 y el extracto ofrece la descarga día a día;
 *   · si aun así se agota el presupuesto de tiempo, el flujo se CORTA CON ERROR
 *     — la descarga falla a la vista en el navegador — en vez de terminar como
 *     un CSV truncado que pasaría por completo.
 */

/** La cabecera del CSV, en el orden de las columnas. */
export const CABECERA_CSV_REFERENCIAS =
  "request_id,day,model,cache_result,reference_request_id,reference_at,credited_input_tokens,credited_output_tokens,baseline_cost_usd";

/**
 * Las columnas de bvsala.reference_hits que se leen, en el orden del CSV. El
 * dinero se pide como TEXTO (`::text`): numeric(20,10) llega exacto
 * («0.0000050000») en vez de como número de JavaScript, que por debajo de 1e-6
 * se escribiría en notación exponencial («5e-7») y perdería la escala.
 */
export const COLUMNAS_REFERENCE_HITS =
  "request_id, day, model, cache_result, reference_request_id, reference_at, baseline_input_tokens, baseline_output_tokens, baseline_cost::text";

/** Filas por página: el tope de PostgREST (max-rows) en Supabase. */
export const TAM_PAGINA_REFERENCIAS = 1000;

/**
 * Filas máximas de UNA descarga. Con el índice de 0029 una página de 1000
 * filas cuesta decenas de milisegundos desde fra1 (junto a la base), así que
 * 1 M de filas (1000 páginas, ≈ 150 MB de CSV) cabe con holgura en
 * PRESUPUESTO_DESCARGA_MS. Por encima, la descarga va por días.
 */
export const MAX_FILAS_POR_DESCARGA = 1_000_000;

/** `maxDuration` de la ruta, en segundos (el máximo del plan Pro sin Fluid). */
export const DURACION_MAXIMA_DESCARGA_S = 300;

/** Tiempo que el flujo se concede antes de cortarse con error: el máximo de la función menos un margen. */
export const PRESUPUESTO_DESCARGA_MS = (DURACION_MAXIMA_DESCARGA_S - 30) * 1000;

/** Una fila de bvsala.reference_hits tal como la devuelve PostgREST. */
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

/** Una línea del CSV (sin fin de línea). */
export function lineaCsv(f: FilaDeReferencia): string {
  return [
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
    .join(",");
}

/** Un bloque de líneas, cada una con su CRLF (RFC 4180). */
export function bloqueCsv(filas: readonly FilaDeReferencia[]): string {
  let s = "";
  for (const f of filas) s += `${lineaCsv(f)}\r\n`;
  return s;
}

/** El documento entero en memoria: la cabecera y una línea por acierto. Solo para volúmenes pequeños y tests. */
export function csvDeReferencias(filas: readonly FilaDeReferencia[]): string {
  return `${CABECERA_CSV_REFERENCIAS}\r\n${bloqueCsv(filas)}`;
}

const DIA = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** ¿Es `YYYY-MM-DD` un día que existe (sin 31 de febrero)? */
export function esDiaValido(dia: string): boolean {
  if (!DIA.test(dia)) return false;
  return new Date(`${dia}T00:00:00Z`).toISOString().slice(0, 10) === dia;
}

/** El día siguiente, en UTC. */
export function diaSiguiente(dia: string): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Los días UTC de [desde, hasta), como YYYY-MM-DD. */
export function diasEntre(desde: string, hasta: string): string[] {
  const dias: string[] = [];
  for (let d = desde; d < hasta; d = diaSiguiente(d)) dias.push(d);
  return dias;
}

/**
 * Lee UNA página de un día: las filas de `dia` con `request_id > despuesDe`
 * (o desde el principio con null), ordenadas por request_id, como mucho
 * `tam`. Lanza si PostgREST devuelve error.
 */
export type LectorDePaginaDeReferencias = (dia: string, despuesDe: string | null, tam: number) => Promise<FilaDeReferencia[]>;

/** El flujo se cortó por tiempo: mejor una descarga fallida a la vista que un CSV truncado que pasa por completo. */
export class DescargaSinTiempoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescargaSinTiempoError";
  }
}

/**
 * Las páginas del CSV, en orden (día, request_id), como texto listo para
 * escribir (cada línea con su CRLF; sin la cabecera). Paginación por CLAVE,
 * nunca por OFFSET. Antes de cada lectura comprueba el reloj: pasado `fin`,
 * lanza DescargaSinTiempoError.
 */
export async function* paginasDeReferencias(
  dias: readonly string[],
  leer: LectorDePaginaDeReferencias,
  opciones: { fin: number; ahora?: () => number; tam?: number },
): AsyncGenerator<string, void, undefined> {
  const ahora = opciones.ahora ?? Date.now;
  const tam = opciones.tam ?? TAM_PAGINA_REFERENCIAS;
  for (const dia of dias) {
    let despuesDe: string | null = null;
    for (;;) {
      if (ahora() > opciones.fin) {
        throw new DescargaSinTiempoError(`sin tiempo para terminar la descarga (día ${dia})`);
      }
      const filas = await leer(dia, despuesDe, tam);
      if (filas.length > 0) {
        const ultimo = filas[filas.length - 1]!.request_id;
        // Defensa: una lectura que no avanza (filtro por clave ignorado)
        // repetiría la misma página para siempre. Por igualdad y no con `>`:
        // el orden lo decide la COLACIÓN de la base (la misma para el índice,
        // el ORDER BY y el `gt`), no el orden de código de JavaScript.
        if (ultimo === despuesDe) {
          throw new Error(`la paginación por clave no avanza (día ${dia}, tras ${despuesDe})`);
        }
        yield bloqueCsv(filas);
        despuesDe = ultimo;
      }
      if (filas.length < tam) break;
    }
  }
}
