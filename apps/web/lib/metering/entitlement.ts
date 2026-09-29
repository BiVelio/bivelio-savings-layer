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
  /**
   * El plan firmado. Solo importa para distinguir la licencia gratuita «Medir»
   * (`measure`), que NO es una licencia pagada: ni cuenta para el barrido de
   * impago ni para el invariante «paga y no tiene licencia». Opcional porque las
   * consultas que no lo piden tratan la fila como pagada (lo que eran antes).
   */
  plan?: string | null;
}

/** ¿Es la licencia gratuita «Medir»? */
const esMedir = (l: LicenseRow): boolean => l.plan === "measure";

function viva(l: LicenseRow, nowMs: number): boolean {
  if (l.revoked) return false;
  const expira = Date.parse(l.expires_at);
  if (Number.isNaN(expira)) return false;
  return nowMs <= expira + (l.grace_days ?? 0) * DAY_MS;
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
  // Una licencia Medir NO es una licencia pagada: no salva de la degradación por
  // impago ni tapa el invariante «paga y no tiene licencia».
  return licenses.some((l) => !esMedir(l) && viva(l, nowMs));
}

/** ¿Tiene la org una licencia Medir viva? */
export function hasValidMeasureLicense(licenses: LicenseRow[], nowMs: number): boolean {
  return licenses.some((l) => esMedir(l) && viva(l, nowMs));
}

/** ¿ESTA suscripción concreta cubre a la org ahora mismo? */
function suscripcionCubre(sub: SubscriptionRow, nowMs: number): boolean {
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
 * ¿CUALQUIERA de las suscripciones de la org la cubre ahora mismo?
 *
 * Recibe TODAS las filas, no solo la más nueva. El candado leía una sola
 * (`order created_at desc / limit(1)`), así que una fila NO vigente más reciente
 * —la duplicada que se acaba de cancelar, la de cortesía que se retiró— hacía
 * sombra a una vigente más antigua: el cliente seguía pagando y el ingest le
 * devolvía 402. Y ese 402 NO se recupera, porque el SDK solo reencola los 5xx:
 * el lote se pierde para siempre, con él los datos que alimentan `usage_daily` →
 * asientos facturables y el extracto, y el panel se le queda a cero.
 *
 * Basta UNA vigente para dar derecho. Que esto no abra la puerta para siempre lo
 * garantiza `suscripcionCubre`, que caduca sola en `current_period_end + 3 días`.
 */
export function hasActiveSubscription(
  subscriptions: readonly SubscriptionRow[],
  nowMs: number,
): boolean {
  return subscriptions.some((s) => suscripcionCubre(s, nowMs));
}

/**
 * Por qué se decide lo que se decide. Los tres últimos son los únicos que
 * bloquean, y son los únicos que `/api/org/entitlements` devuelve al cliente:
 * `reason` presente ⇔ org bloqueada.
 */
export type EntitlementReason =
  | "valid-license"
  | "active-subscription"
  /**
   * Solo la licencia gratuita «Medir»: NO bloquea (su uso se ingiere para el
   * panel), pero la ingesta lo neutraliza para que jamás genere comisión ni una
   * referencia cobrable (`neutralizarParaMedir`), y le aplica los topes.
   */
  | "measure-license"
  | "no-license"
  | "license-revoked"
  | "license-expired";

export interface EntitlementDecision {
  blocked: boolean;
  reason: EntitlementReason;
}

/**
 * La decisión. Sin licencia válida ni suscripción que cubra → bloqueada. Una org
 * que NUNCA tuvo licencia también: no hay free tier (README, LICENSE §1-2).
 * Pilotos y probadores tienen siempre fila (trial/route.ts persiste
 * fail-closed; el webhook emite con issueLicense), y una org con suscripción
 * activa y la fila aún sin escribir no se bloquea (active-subscription).
 *
 * Antes, quien nunca tuvo licencia pasaba con `no-license-record`: la ingesta
 * le aceptaba uso y el canal no le daba `reason`, así que cualquier pasarela
 * —la publicada o una parcheada— medía y llenaba el panel gratis con solo
 * acuñar una clave bvk_. Este es el candado que lo cierra, y está aquí porque
 * el servidor no se parchea.
 */
export function decideEntitlement(
  licenses: LicenseRow[],
  subscriptions: readonly SubscriptionRow[],
  nowMs: number,
): EntitlementDecision {
  if (hasValidLicense(licenses, nowMs)) return { blocked: false, reason: "valid-license" };
  if (hasActiveSubscription(subscriptions, nowMs)) return { blocked: false, reason: "active-subscription" };
  // Después de las dos de pago: una org que paga y conserva su Medir es de pago.
  if (hasValidMeasureLicense(licenses, nowMs)) return { blocked: false, reason: "measure-license" };

  // Sin licencia válida ni suscripción que cubra: se bloquea siempre. El motivo
  // distingue a quien nunca tuvo licencia de quien la tuvo y la perdió.
  const tuvoLicencia = licenses.length > 0;
  if (!tuvoLicencia) return { blocked: true, reason: "no-license" };
  const algunaRevocada = licenses.some((l) => l.revoked);
  return {
    blocked: true,
    reason: algunaRevocada ? "license-revoked" : "license-expired",
  };
}
