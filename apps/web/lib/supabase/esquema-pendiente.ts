/**
 * EL DESPLIEGUE PUEDE ADELANTAR A LA MIGRACIÓN. Estos dos detectores dicen si
 * un error de PostgREST es «esa columna / esa tabla aún no existe» (proyecto
 * por detrás de una migración) y no un fallo real de lectura. Confundir los dos
 * casos es lo que dejaba el panel en blanco con los datos intactos.
 *
 * Vivían privados en dashboard/data.ts; salen aquí porque desde 0029 también
 * los necesitan el cierre de extractos, la purga de retención y la descarga CSV
 * de las repeticiones medidas por referencia.
 */

/** Forma mínima de un error de PostgREST (supabase-js lo devuelve como valor). */
export interface ErrorDePostgrest {
  code?: string;
  message?: string;
}

/**
 * ¿«Esa columna no existe»? `42703` es el `undefined_column` de Postgres. Se
 * mira también el mensaje porque PostgREST no siempre propaga el `code` del
 * motor —según la versión devuelve `PGRST204` o solo texto—.
 */
export function esColumnaInexistente(error: ErrorDePostgrest): boolean {
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find");
}

/** ¿«Esa tabla no existe»? `42P01` en Postgres, `PGRST205` en PostgREST. */
export function esTablaInexistente(error: ErrorDePostgrest): boolean {
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find");
}

/**
 * ¿«Esa función no existe»? `42883` (undefined_function) en Postgres,
 * `PGRST202` en PostgREST («Could not find the function … in the schema
 * cache»). Desde 0030 lo necesitan el ingest y el panel de la verificación A/B
 * (`ingest_verification_batch`, `verification_summary`): un despliegue que
 * adelanta a la migración responde 503 o «no disponible», nunca ceros.
 */
export function esFuncionInexistente(error: ErrorDePostgrest): boolean {
  if (error.code === "42883" || error.code === "PGRST202") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("could not find the function") || (m.includes("function") && m.includes("does not exist"));
}
