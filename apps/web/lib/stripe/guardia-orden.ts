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
 * ¿Puede un `invoice.payment_failed` marcar impago esta fila? Dos vetos:
 *
 * 1. `canceled` es TERMINAL para esa suscripción de Stripe — una recreación
 *    llega como fila nueva. Un `payment_failed` posterior al `deleted` (Stripe
 *    puede emitir el fallo de la última factura DESPUÉS de cancelar, y además
 *    reintenta entregas durante días) no debe resucitarla: el hallazgo VIVO de
 *    la re-verificación del 02-09 — la fila volvía a `past_due`, el ingest de
 *    la org cancelada se reabría (entitlement cubre past_due + gracia) y el
 *    reconcile le volvía a contar asientos, aunque todas las licencias
 *    estuvieran ya revocadas.
 * 2. La guardia de orden de siempre (esStale), que este handler era el único
 *    en no aplicar.
 *
 * Primera línea en memoria; la segunda viaja en el WHERE del UPDATE (status
 * neq canceled + condicionEscritura), porque leída-y-escrita en dos pasos no
 * frena la ráfaga concurrente — la lección reproducida del 27-08.
 */
export function puedeAplicarImpago(
  filaStatus: string | null,
  filaLastEventAt: string | null,
  eventCreatedUnix: number,
): boolean {
  if (filaStatus === "canceled") return false;
  return !esStale(eventCreatedUnix, filaLastEventAt);
}

/**
 * Vencimiento de RESPALDO cuando Stripe no trae `current_period_end`:
 * «31 días» anclados al DÍA, no al segundo. El índice único de 0018
 * (org_id, expires_at, seats) frena la carrera de emisión solo si los
 * corredores calculan el MISMO expires_at — y `nowUnix() + 31d` se evaluaba
 * por handler, con segundos distintos, así que dos webhooks concurrentes de
 * la misma suscripción no colisionaban y emitían dos licencias vivas (el
 * residuo de la re-verificación del 02-09). Truncar al día los hace chocar;
 * la ventana restante (dos handlers a caballo de medianoche UTC con un
 * periodEnd nulo) es despreciable y la emisión sigue siendo idempotente.
 */
export function fallbackVencimientoUnix(nowUnix: number): number {
  return Math.floor(nowUnix / 86400) * 86400 + 31 * 86400;
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
