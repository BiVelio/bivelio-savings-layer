import { hasValidLicense, type LicenseRow } from "@/lib/metering/entitlement";

/**
 * EL INVARIANTE DEL NEGOCIO: nadie puede estar pagando y no tener producto.
 *
 * Es exactamente el defecto que costó dos días (B1): el webhook emitía la
 * licencia, guardaba el `jti` y DESCARTABA el token, así que había clientes con
 * la suscripción cobrada y sin nada que instalar. Se arregló, y las redes que se
 * pusieron después —`ensurePrimeraLicencia`, la guardia de orden, el barrido de
 * impago— son todas REACTIVAS: actúan cuando llega un evento de Stripe. Si el
 * evento no llega, o llega y falla, nadie mira nunca.
 *
 * Esto es lo que mira. No arregla: DETECTA. Un invariante que además intentara
 * repararse solo escondería la causa, y la causa es lo que hay que arreglar.
 */

export interface SubscriptionParaInvariante {
  org_id: string;
  status: string;
  stripe_subscription_id?: string | null;
}

/** Estados en los que el cliente ESTÁ PAGANDO o su dinero está en camino. */
const PAGANDO = ["active", "trialing", "past_due"];

export interface OrgDescubierta {
  orgId: string;
  status: string;
  subId: string | null;
  /** Cuántas licencias tiene en total (0 = nunca se le emitió ninguna). */
  licencias: number;
  /** `true` si tuvo licencias y TODAS están revocadas o caducadas. */
  tuvoYPerdio: boolean;
}

/**
 * Las orgs que pagan y no tienen licencia viva.
 *
 * `licenciasPorOrg` viene ya agrupado por quien llama, porque leer las licencias
 * de cada org por separado es una consulta por org y este barrido tiene que
 * poder correr sobre toda la base.
 *
 * `incomplete` NO cuenta como pagando: ahí el primer cobro todavía no ha
 * liquidado (un adeudo SEPA tarda días) y no tener licencia es el estado
 * CORRECTO. Contarlo daría una alarma falsa cada vez que alguien compra por
 * domiciliación, y una alarma que salta sin motivo deja de mirarse.
 */
export function orgsPagandoSinLicencia(
  subs: SubscriptionParaInvariante[],
  licenciasPorOrg: Map<string, LicenseRow[]>,
  nowMs: number,
): OrgDescubierta[] {
  const fuera: OrgDescubierta[] = [];
  for (const sub of subs) {
    if (!PAGANDO.includes(sub.status)) continue;
    const licencias = licenciasPorOrg.get(sub.org_id) ?? [];
    // MISMO predicado que el candado del ingest, no una copia: si el barrido y
    // el servidor discreparan sobre qué es "una licencia viva", este invariante
    // avisaría de clientes que sí tienen producto, o —peor— callaría con los que
    // no lo tienen.
    if (hasValidLicense(licencias, nowMs)) continue;
    fuera.push({
      orgId: sub.org_id,
      status: sub.status,
      subId: sub.stripe_subscription_id ?? null,
      licencias: licencias.length,
      // Distinguir los dos casos importa para el diagnóstico: "nunca se le
      // emitió" apunta al camino de alta; "las tuvo y las perdió" apunta a una
      // revocación indebida o a una renovación que no se entregó.
      tuvoYPerdio: licencias.length > 0,
    });
  }
  return fuera;
}
