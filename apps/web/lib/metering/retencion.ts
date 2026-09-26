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

/**
 * RETENCIÓN DE `bvsala.reference_hits` (0029): una fila por repetición medida
 * por referencia, la que baja el CSV del extracto. ≈ 15 meses: cubre el año
 * fiscal del cliente más el margen para reclamar un extracto; lo que se cobró
 * queda para siempre en los extractos sellados, que guardan los totales.
 */
export const DIAS_DE_RETENCION_REFERENCIAS = 460;

/** El día (YYYY-MM-DD, UTC) por debajo del cual una fila de reference_hits se borra. */
export function fechaDeCorteReferencias(hoy: Date, dias: number = DIAS_DE_RETENCION_REFERENCIAS): string {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`días de retención inválidos: ${dias}`);
  return new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * RETENCIÓN DE «TU PROPIO BANCO» (0030): `verification_samples` y
 * `verification_daily`, 180 días. Es un instrumento, no un registro de
 * facturación —el panel mira como mucho 120 días—, y empezar corto es el lado
 * seguro para los datos: alargarlo después es fácil. `verification_batches_seen`
 * (la idempotencia por lote) sigue el corte de 30 días de `fechaDeCorte`.
 */
export const DIAS_DE_RETENCION_VERIFICACION = 180;

/** El día (YYYY-MM-DD, UTC) por debajo del cual una fila de la verificación se borra. */
export function fechaDeCorteVerificacion(hoy: Date, dias: number = DIAS_DE_RETENCION_VERIFICACION): string {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`días de retención inválidos: ${dias}`);
  return new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
