/**
 * RETENCIÓN DE `bvsala.usage_ingest_seen`, en puro.
 *
 * La tabla de idempotencia del ingest crece con cada petición medida (~60
 * bytes; a un millón de peticiones al mes, ~60 MB/mes) y la migración 0009
 * documentó la purga sin programarla (CIERRE.md § 2.2). Aquí solo vive la
 * decisión de HASTA CUÁNDO se conserva; el cron `/api/cron/retencion` la
 * ejecuta cada noche.
 *
 * 30 días, como escribió 0009: el emisor del SDK reintenta un lote durante
 * horas, no semanas, así que una fila más antigua ya no protege de ningún
 * duplicado real.
 */
export const DIAS_DE_RETENCION = 30;

/** La marca de tiempo (ISO) por debajo de la cual una fila de `seen` se borra. */
export function fechaDeCorte(ahora: Date, dias: number = DIAS_DE_RETENCION): string {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`días de retención inválidos: ${dias}`);
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}
