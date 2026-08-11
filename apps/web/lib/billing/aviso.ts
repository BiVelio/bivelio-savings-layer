/**
 * Qué aviso de cobro merece ver el cliente, como función PURA.
 *
 * QUÉ ARREGLA. El panel no tenía forma de decir que algo iba mal con el dinero.
 * `past_due` mapea a plan "pro", así que la tarjeta de cuenta pintaba "Pro", los
 * asientos y el precio con toda normalidad mientras corrían los días de gracia;
 * y `ctx.license` (con sus estados grace/expired/revoked) se calculaba y no lo
 * leía ni un componente. El cliente se enteraba cuando el SDK se le paraba.
 *
 * El orden importa y es deliberado: primero lo que el cliente PUEDE ARREGLAR
 * (una tarjeta que no pasa), después el estado de la licencia. Enseñar "licencia
 * caducada" a quien lo que tiene es una tarjeta caducada le manda a la pantalla
 * equivocada.
 */

import { diasRestantesDeGracia } from "./dunning";
import { diasDeGracia, MS_POR_DIA } from "./gracia";

export type Aviso =
  /** El cobro falló y la gracia sigue corriendo: acción = actualizar la tarjeta. */
  | { tipo: "pastDue"; dias: number | null }
  /** El cobro falló y la gracia terminó. */
  | { tipo: "pastDueEnded" }
  /** Pago por domiciliación en vuelo (SEPA): NO volver a comprar. */
  | { tipo: "incomplete" }
  /** La licencia caducó pero aún funciona. */
  | { tipo: "grace"; dias: number; expiresAt: string }
  | { tipo: "expired"; expiresAt: string }
  | { tipo: "revoked" };

export interface EntradaAviso {
  subscription: { status: string; pastDueSince: string | null } | null;
  license: { status: "active" | "grace" | "expired" | "revoked"; expiresAt: string | null; graceDays: number } | null;
  nowMs: number;
  graciaDias?: number;
}

export function decidirAviso({
  subscription,
  license,
  nowMs,
  graciaDias = diasDeGracia(),
}: EntradaAviso): Aviso | null {
  // 1. Problemas de dinero, que son los accionables.
  if (subscription?.status === "past_due") {
    // EL RELOJ QUE SE ENSEÑA ES EL QUE DE VERDAD CORTA EL SERVICIO, que es el de
    // la LICENCIA: `expires_at + grace_days`, ambos FIRMADOS en el token que el
    // SDK verifica sin red. El de la constante de producto solo decide cuándo
    // degradamos nosotros el plan, y los dos pueden no coincidir — una licencia
    // emitida antes de que la gracia subiera a 21 lleva 14 firmados dentro, y
    // ninguna variable de entorno de hoy cambia un token de ayer. Enseñar el
    // número equivocado es prometer, en los 12 idiomas, servicio que ya no hay.
    const dias = diasHastaQueParaElSDK(license, nowMs) ?? diasRestantesDeGracia(subscription.pastDueSince, nowMs, graciaDias);
    // `dias === null` = ni licencia ni sello con el que contar. Se avisa igual,
    // sin cifra: lo accionable es "tu tarjeta no pasa", no cuántos días quedan.
    if (dias === 0) return { tipo: "pastDueEnded" };
    return { tipo: "pastDue", dias };
  }
  if (subscription?.status === "incomplete") return { tipo: "incomplete" };

  // 2. Estado de la licencia.
  if (license?.status === "revoked") return { tipo: "revoked" };
  if (license?.status === "expired" && license.expiresAt) {
    return { tipo: "expired", expiresAt: license.expiresAt };
  }
  if (license?.status === "grace" && license.expiresAt) {
    const finGracia = Date.parse(license.expiresAt) + (license.graceDays ?? 0) * MS_POR_DIA;
    const dias = Number.isNaN(finGracia) ? 0 : Math.max(0, Math.ceil((finGracia - nowMs) / MS_POR_DIA));
    return { tipo: "grace", dias, expiresAt: license.expiresAt };
  }

  // Todo en orden: no se pinta nada. Un panel que grita cuando no pasa nada
  // enseña a ignorarlo, y entonces no sirve el día que sí pasa.
  return null;
}

/**
 * Días hasta que el SDK deja de funcionar, según el reloj de la propia licencia
 * (`expires_at + grace_days`, los dos firmados en el token). `null` cuando no hay
 * licencia con la que contar; 0 cuando ya pasó.
 */
function diasHastaQueParaElSDK(
  license: EntradaAviso["license"],
  nowMs: number,
): number | null {
  if (!license?.expiresAt) return null;
  const expira = Date.parse(license.expiresAt);
  if (Number.isNaN(expira)) return null;
  const fin = expira + (license.graceDays ?? 0) * MS_POR_DIA;
  if (nowMs >= fin) return 0;
  return Math.ceil((fin - nowMs) / MS_POR_DIA);
}
