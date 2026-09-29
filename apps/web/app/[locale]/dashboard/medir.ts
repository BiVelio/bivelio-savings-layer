import type { UsageRollup } from "./data";

/**
 * EL PANEL DE LA LICENCIA MEDIR — derivaciones puras (sin next-intl, testeables).
 *
 * Qué licencia manda en esta organización, visto desde el panel:
 *  · `de-pago`       — una licencia de pago viva o una suscripción que cubre.
 *                      No se le ofrece Medir ni se le enseña la tarjeta sombra.
 *  · `solo-medir`    — solo la licencia gratuita Medir: el panel enseña «esto
 *                      habrías ahorrado» y el CTA a pago.
 *  · `sin-licencia`  — nada vivo: se le ofrece el alta Medir sin tarjeta.
 */
export type EstadoMedir = "de-pago" | "solo-medir" | "sin-licencia";

export interface FilaLicenciaPanel {
  plan?: string | null;
  revoked?: boolean;
  expires_at?: string;
  grace_days?: number;
}

const DAY_MS = 86_400_000;
const CUBREN = ["active", "trialing", "past_due"];

function viva(l: FilaLicenciaPanel, nowMs: number): boolean {
  if (l.revoked) return false;
  const expira = Date.parse(l.expires_at ?? "");
  if (Number.isNaN(expira)) return false;
  return nowMs <= expira + (l.grace_days ?? 0) * DAY_MS;
}

export function estadoMedir(
  licencias: readonly FilaLicenciaPanel[],
  estadoDeSuscripcion: string | null | undefined,
  nowMs: number,
): EstadoMedir {
  const vivas = licencias.filter((l) => viva(l, nowMs));
  if (vivas.some((l) => l.plan !== "measure")) return "de-pago";
  if (estadoDeSuscripcion && CUBREN.includes(estadoDeSuscripcion)) return "de-pago";
  if (vivas.some((l) => l.plan === "measure")) return "solo-medir";
  return "sin-licencia";
}

export interface AhorroEnSombra {
  /** Lo que el carril sombra dice que NO se habría gastado (USD). null = sin dato. */
  habriasAhorradoUsd: number | null;
  /** El gasto medido del periodo (USD). */
  gastoUsd: number;
  peticiones: number;
}

/**
 * «Esto habrías ahorrado»: Σ(shadow_baseline − shadow_actual) sobre el rango,
 * y el gasto real del mismo rango como contexto. HIPOTÉTICO: se enseña aparte y
 * jamás se suma a nada medido. `null` si ninguna fila trae las columnas sombra
 * (migración 0021 ausente): «no disponible», no cero.
 */
export function ahorroEnSombra(usage: readonly UsageRollup[]): AhorroEnSombra {
  let conSombra = false;
  let ahorro = 0;
  let gasto = 0;
  let peticiones = 0;
  for (const d of usage) {
    gasto += d.actualCost;
    peticiones += d.requests;
    if (d.shadowBaselineCost != null || d.shadowActualCost != null) {
      conSombra = true;
      ahorro += (d.shadowBaselineCost ?? 0) - (d.shadowActualCost ?? 0);
    }
  }
  return { habriasAhorradoUsd: conSombra ? Math.max(0, ahorro) : null, gastoUsd: gasto, peticiones };
}
