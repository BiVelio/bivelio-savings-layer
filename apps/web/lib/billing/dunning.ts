/**
 * La decisión de impago (dunning), como función PURA para poder probarla sin red.
 *
 * QUÉ ARREGLA. El webhook prometía esto por escrito en tres sitios —
 * "invoice.payment_failed → past_due, NO revoke (14-day dunning grace)" y
 * "a nightly cron downgrades only past-grace"— y ese cron NO EXISTÍA. La columna
 * `subscriptions.past_due_since` se sellaba en cada fallo de cobro y no se leía
 * en NINGÚN sitio del repositorio. Consecuencia real: una org cuyo cobro falla se
 * queda con `plan = 'pro'` indefinidamente y el panel le pinta "Pro" con toda
 * normalidad, sin una sola señal de que hay un problema; se entera cuando el SDK
 * se le para, semanas después.
 *
 * QUIÉN MANDA AQUÍ: Stripe. Cuando termina su propio dunning emite
 * `customer.subscription.updated` (a `unpaid`/`canceled`) o `.deleted`, y esos ya
 * se manejan. Este barrido es la RED DE SEGURIDAD para cuando ese evento no
 * llega — no la autoridad. Por eso se limita a degradar el plan y dejar rastro.
 */

import { diasDeGracia, MS_POR_DIA } from "./gracia";

export type DecisionDunning =
  /** Nada que hacer: o no está en impago, o sigue dentro de la gracia. */
  | "nada"
  /** Está en impago pero nadie selló cuándo empezó: se sella ahora y se cuenta desde aquí. */
  | "sellar"
  /** Pasada la gracia: el plan deja de ser 'pro'. */
  | "degradar";

export interface EntradaDunning {
  /** `subscriptions.status` tal cual lo dejó el webhook. */
  status: string;
  /** `subscriptions.past_due_since` (ISO) o null si nunca se selló. */
  pastDueSince: string | null;
  /**
   * `subscriptions.current_period_start` (ISO). SEGUNDA RED sobre el sello: uno
   * anterior al periodo en curso es de un episodio ya cerrado y no se cuenta.
   * `selloDeImpago` ya impide que se queden rancios de aquí en adelante, pero
   * esto acota el daño de cualquier fila que YA tenga uno viejo o de cualquier
   * camino no previsto — y el error cae siempre del lado bueno: se vuelve a
   * sellar, o sea que el cliente recibe MÁS gracia, nunca menos.
   */
  periodStart?: string | null;
  /**
   * ¿Le queda a la org alguna licencia viva (vigente o en su gracia firmada)?
   *
   * Mientras la haya NO se degrada, aunque el reloj del impago haya pasado. Los
   * dos relojes son distintos —el nuestro cuenta desde que falla el cobro; el de
   * la licencia va desde `expires_at + grace_days`, FIRMADO en el token— y
   * degradar con licencia viva dejaba al panel diciendo "sin plan activo" a
   * alguien a quien el SDK le sigue funcionando. Un fallo de cobro a mitad de
   * ciclo (una factura de prorrateo, con el periodo principal pagado) cae justo
   * en ese hueco.
   */
  licenciaViva?: boolean;
  nowMs: number;
  /** Inyectable para los tests; por defecto, la constante única del producto. */
  graciaDias?: number;
}

/**
 * Nótese lo que NO hace: revocar la licencia. La licencia lleva su propia gracia
 * FIRMADA en el token (`grace_days`) y caduca sola en `period_end + gracia`, que
 * es justo cuando este barrido degrada. Revocar además sería una segunda
 * ejecución del mismo castigo por otro camino, y encima destructiva: un
 * `invoice.payment_failed` puede venir de una factura de prorrateo a mitad de
 * ciclo, con el periodo principal PAGADO y el `period_end` lejos. Degradar el
 * plan es honesto y reversible; revocar no lo es.
 */
export function decidirDunning({
  status,
  pastDueSince,
  periodStart = null,
  licenciaViva = false,
  nowMs,
  graciaDias = diasDeGracia(),
}: EntradaDunning): DecisionDunning {
  if (status !== "past_due") return "nada";

  if (!pastDueSince) return "sellar";
  const inicio = Date.parse(pastDueSince);
  // Fecha ilegible: se vuelve a sellar en vez de degradar. Un dato corrupto no
  // puede ser motivo para cortarle el servicio a nadie.
  if (Number.isNaN(inicio)) return "sellar";

  // Sello de un episodio anterior al periodo en curso: no cuenta, se abre uno
  // nuevo. Ver `periodStart` arriba.
  const arranque = periodStart ? Date.parse(periodStart) : NaN;
  if (!Number.isNaN(arranque) && inicio < arranque) return "sellar";

  // Un sello en el FUTURO (desfase de reloj o dato manipulado) tampoco degrada, y
  // no hace falta una guardia aparte: `transcurrido` sale negativo y la
  // comparación de abajo lo resuelve. Lo aclara este comentario porque una
  // guardia explícita parecía necesaria y no lo era — la mutación lo demostró.
  const transcurrido = nowMs - inicio;
  // Estrictamente MAYOR: el día de gracia exacto todavía cuenta como dentro.
  // La asimetría manda — ante la duda, el cliente sigue funcionando.
  if (transcurrido <= graciaDias * MS_POR_DIA) return "nada";

  // Pasada NUESTRA gracia, pero con licencia viva no se degrada: el producto le
  // sigue funcionando y el panel no puede decir lo contrario. Ver `licenciaViva`.
  return licenciaViva ? "nada" : "degradar";
}

/**
 * El sello de inicio de impago que debe quedar en la fila tras aplicar un estado
 * de Stripe. Es la pieza que faltaba, y su ausencia era un fallo CRÍTICO.
 *
 * `past_due_since` solo se escribía (en `invoice.payment_failed`) y NADIE la
 * borraba nunca al recuperarse el cobro. Mientras la columna era dato muerto no
 * pasaba nada; en cuanto el barrido empezó a leerla se convirtió en el
 * interruptor que corta el servicio, y entonces el sello rancio de un impago YA
 * RESUELTO hace meses hace que el SIGUIENTE impago degrade el día 1, con cero
 * gracia, mientras Stripe todavía tiene tres semanas de reintentos por delante.
 * Es justo el corte a un cliente que sí paga que toda esta gracia existe para
 * evitar.
 *
 * Regla: el sello vive exactamente lo que dura el episodio de impago.
 *   - Estado de impago  → se conserva el sello del episodio, o se abre uno nuevo.
 *   - Cualquier otro    → null. El episodio terminó.
 */
export function selloDeImpago(
  statusNuevo: string,
  selloExistente: string | null,
  ahoraIso: string,
): string | null {
  if (statusNuevo !== "past_due") return null;
  return selloExistente ?? ahoraIso;
}

/** Días que le quedan de gracia (0 si ya pasó). Para el aviso del panel. */
export function diasRestantesDeGracia(
  pastDueSince: string | null,
  nowMs: number,
  graciaDias: number = diasDeGracia(),
): number | null {
  if (!pastDueSince) return null;
  const inicio = Date.parse(pastDueSince);
  if (Number.isNaN(inicio)) return null;
  const fin = inicio + graciaDias * MS_POR_DIA;
  if (nowMs >= fin) return 0;
  return Math.ceil((fin - nowMs) / MS_POR_DIA);
}
