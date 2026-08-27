/**
 * LA GUARDIA DE ORDEN DEL WEBHOOK, en dos piezas puras.
 *
 * Stripe no garantiza orden y reintenta durante días lo que respondió 5xx. La
 * primera línea de defensa (esStale) descarta en memoria lo claramente viejo.
 * Pero leída-y-escrita en dos pasos NO basta: en una ráfaga concurrente (el
 * caso reproducido el 2026-08-27: `payment_failed` y `deleted` entregados a la
 * vez), ambos manejadores leen el mismo `last_event_at` viejo, ambos pasan la
 * guardia, y gana el último en ESCRIBIR — la fila quedó en `past_due` con la
 * suscripción cancelada en Stripe.
 *
 * La segunda línea es comparar-y-escribir EN LA MISMA instrucción SQL: el
 * UPDATE lleva la condición de frescura en el WHERE (condicionEscritura), así
 * el que pierde la carrera afecta 0 filas en vez de pisar al ganador. El
 * desempate a MISMO instante: `canceled` es pegajoso — un evento del mismo
 * segundo no lo sobreescribe (los reintentos del propio `deleted` reescriben
 * lo mismo, inofensivo; un `payment_failed` gemelo en tiempo ya no lo pisa).
 * Un evento ESTRICTAMENTE más nuevo siempre gana, como hasta ahora.
 */

/** ¿Este evento es claramente viejo respecto a lo último aplicado? */
export function esStale(eventCreatedUnix: number, lastEventAt: string | null): boolean {
  if (!lastEventAt) return false;
  return eventCreatedUnix * 1000 < new Date(lastEventAt).getTime();
}

/**
 * La condición de frescura para el `.or()` de PostgREST del UPDATE guardado.
 * Comillas alrededor del timestamp: lleva `:` y PostgREST parte por comas y
 * puntos sin ellas.
 */
export function condicionEscritura(eventCreatedIso: string): string {
  return (
    `last_event_at.is.null,` +
    `last_event_at.lt."${eventCreatedIso}",` +
    `and(last_event_at.eq."${eventCreatedIso}",status.neq.canceled)`
  );
}

/**
 * Referencia ejecutable de la MISMA regla que condicionEscritura expresa en
 * PostgREST — es lo que prueban los tests de orden, mutación mediante.
 */
export function ganaLaEscritura(
  eventCreatedIso: string,
  filaLastEventAt: string | null,
  filaStatus: string | null,
): boolean {
  if (!filaLastEventAt) return true;
  const evento = new Date(eventCreatedIso).getTime();
  const fila = new Date(filaLastEventAt).getTime();
  if (fila < evento) return true;
  if (fila === evento) return filaStatus !== "canceled";
  return false;
}
