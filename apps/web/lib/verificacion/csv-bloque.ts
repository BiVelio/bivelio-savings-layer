import { celdaCsv, DescargaSinTiempoError, TAM_PAGINA_REFERENCIAS } from "@/lib/metering/referencias-csv";

/** Una fila con su clave de paginación. */
export interface FilaCsv {
  request_id: string;
}

/** Líneas CSV (RFC 4180, CRLF) de `filas`, con las celdas en `orden`. */
export function bloqueGenerico<F extends FilaCsv>(filas: readonly F[], orden: readonly string[]): string {
  let s = "";
  for (const f of filas) {
    s += `${orden.map((k) => celdaCsv((f as unknown as Record<string, unknown>)[k])).join(",")}\r\n`;
  }
  return s;
}

/**
 * Las páginas del CSV, en orden (día, request_id), como texto listo para
 * escribir. Paginación POR CLAVE, nunca por OFFSET; antes de cada lectura mira
 * el reloj y, pasado `fin`, corta CON ERROR (mejor una descarga fallida a la
 * vista que un CSV truncado que pasa por completo). El mismo algoritmo que
 * `paginasDeReferencias`, genérico en la fila.
 */
export async function* paginasPorClave<F extends FilaCsv>(
  dias: readonly string[],
  leer: (dia: string, despuesDe: string | null, tam: number) => Promise<F[]>,
  bloque: (filas: readonly F[]) => string,
  opciones: { fin: number; ahora?: () => number; tam?: number },
): AsyncGenerator<string, void, undefined> {
  const ahora = opciones.ahora ?? Date.now;
  const tam = opciones.tam ?? TAM_PAGINA_REFERENCIAS;
  for (const dia of dias) {
    let despuesDe: string | null = null;
    for (;;) {
      if (ahora() > opciones.fin) throw new DescargaSinTiempoError(`sin tiempo para terminar la descarga (día ${dia})`);
      const filas = await leer(dia, despuesDe, tam);
      if (filas.length > 0) {
        const ultimo = filas[filas.length - 1]!.request_id;
        if (ultimo === despuesDe) throw new Error(`la paginación por clave no avanza (día ${dia}, tras ${despuesDe})`);
        yield bloque(filas);
        despuesDe = ultimo;
      }
      if (filas.length < tam) break;
    }
  }
}
