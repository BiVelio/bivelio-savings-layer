/**
 * ¿Tiene esta org derecho a que se le ingiera uso?
 *
 * Es el candado de servidor que la auditoría marcó como el de mayor palanca y
 * que NO existía: el ingest autenticaba la clave y metía datos, pero nunca
 * miraba si la org estaba revocada o sin suscripción. Un cliente revocado seguía
 * facturando y conservando panel. El binario es parcheable; esto no, porque
 * corre en nuestro servidor.
 *
 * La lógica REFLEJA la del SDK (`deriveStatus` en src/license/verify.ts):
 * revocada > caducada-pasada-la-gracia > vigente. Si servidor y cliente
 * discreparan, un cliente funcionaría en un sitio y no en otro — el bug
 * silencioso exacto que hay que evitar. Función pura para poder probarla sin red.
 */

export interface LicenseRow {
  revoked: boolean;
  expires_at: string; // ISO
  grace_days: number;
}

export interface SubscriptionRow {
  status: string; // 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | ...
  current_period_end: string | null; // ISO
}

const DAY_MS = 86_400_000;

/**
 * ¿Alguna licencia sigue dentro de su validez pagada (vigente o en gracia)?
 *
 * Se EXPORTA para que el barrido de impago use exactamente este predicado y no
 * una tercera versión del mismo criterio. Si el servidor y el barrido
 * discreparan sobre qué es "una licencia viva", degradaríamos a orgs a las que
 * el producto les sigue funcionando — y el panel diría "sin plan activo" a
 * alguien con el SDK corriendo.
 */
export function hasValidLicense(licenses: LicenseRow[], nowMs: number): boolean {
  return licenses.some((l) => {
    if (l.revoked) return false;
    const expira = Date.parse(l.expires_at);
    if (Number.isNaN(expira)) return false;
    const finGracia = expira + (l.grace_days ?? 0) * DAY_MS;
    return nowMs <= finGracia;
  });
}

/** ¿Una suscripción concreta cubre a la org ahora mismo? */
function subscriptionActiva(sub: SubscriptionRow, nowMs: number): boolean {
  // 'trialing' y 'past_due' siguen cubriendo (Stripe da margen antes de cancelar);
  // 'canceled', 'incomplete', 'unpaid', 'incomplete_expired' no.
  if (!["active", "trialing", "past_due"].includes(sub.status)) return false;
  if (!sub.current_period_end) return true; // sin fecha declarada, se confía en el status
  const fin = Date.parse(sub.current_period_end);
  if (Number.isNaN(fin)) return true;
  // Un pequeño margen sobre el fin de periodo para no cortar por desfase de reloj
  // con Stripe mientras se procesa la renovación.
  return nowMs <= fin + 3 * DAY_MS;
}

/**
 * ¿CUALQUIERA de las suscripciones de la org cubre ahora mismo?
 *
 * Recibe TODAS las suscripciones, no la más nueva. El candado leía antes una sola
 * fila (`order created_at desc limit 1`), así que una suscripción cancelada más
 * RECIENTE hacía sombra a una activa más vieja: al cancelar una suscripción
 * duplicada, la org perdía el ingest pese a seguir pagando la otra. Con todas a la
 * vista, basta una activa para dar derecho.
 */
export function hasActiveSubscription(subs: readonly SubscriptionRow[], nowMs: number): boolean {
  return subs.some((s) => subscriptionActiva(s, nowMs));
}

export interface EntitlementDecision {
  blocked: boolean;
  reason: string;
}

/**
 * La decisión. Se BLOQUEA solo ante una señal NEGATIVA explícita: la org tuvo
 * licencia y ahora no le queda ninguna válida NI suscripción activa. Una org sin
 * ninguna licencia (trial recién creado, free, aún sin aprovisionar) NO se
 * bloquea aquí — ese es otro control (la caducidad del trial), no este. Bloquear
 * de más rompería a clientes legítimos, que es peor que una ventana breve para
 * uno revocado, y la revocación además la refuerzan el gate del SDK y el poller.
 */
export function decideEntitlement(
  licenses: LicenseRow[],
  subscriptions: readonly SubscriptionRow[],
  nowMs: number,
): EntitlementDecision {
  if (hasValidLicense(licenses, nowMs)) return { blocked: false, reason: "valid-license" };
  if (hasActiveSubscription(subscriptions, nowMs)) return { blocked: false, reason: "active-subscription" };

  // Sin licencia válida ni suscripción. ¿Hay señal negativa explícita?
  const tuvoLicencia = licenses.length > 0;
  if (!tuvoLicencia) {
    // Nunca tuvo licencia: trial/free/sin aprovisionar. No es cosa de este candado.
    return { blocked: false, reason: "no-license-record" };
  }
  const algunaRevocada = licenses.some((l) => l.revoked);
  return {
    blocked: true,
    reason: algunaRevocada ? "license-revoked" : "license-expired",
  };
}
