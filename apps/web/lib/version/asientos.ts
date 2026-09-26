/**
 * Agregación PURA de las filas de seat_activity (asiento-día, 0024) a un
 * asiento por máquina. Vive aparte de `dashboard/data.ts` para poder probarse
 * sin Supabase: el lector solo consulta y delega aquí.
 *
 * Por asiento:
 *   · lastSeenAt = la mayor `last_seen_at`.
 *   · versionMin / versionMax por orden semver entre las filas que traen valor.
 *     Se prefieren las filas de la VENTANA DE 7 DÍAS (la misma del aviso): si
 *     la máquina se actualizó anteayer, la explicación no debe citar la versión
 *     de hace tres semanas. Solo si en 7 días no declaró nada se cae a las 30.
 *   · sinVersion7d = alguna fila de 7 días con requests_sin_version > 0.
 *   · ahorroMedido7dUsd = Σ(measured_baseline_cost − measured_actual_cost)
 *     + Σ(reference_baseline_cost − reference_actual_cost) bajo
 *     COMISIONAR_REFERENCIA, en las filas de 7 días. Es el fold de lo MEDIDO de
 *     usage_daily al grano de asiento, con la misma regla que el titular y el
 *     extracto: lo medido por referencia (0029/0031) es medido cuando el
 *     interruptor lo comisiona. Lo estimado, nunca.
 *   · ahorroReferencia7dUsd = solo la parte de referencia de esos 7 días, siempre
 *     (para la nota de la tarjeta de máquinas), con el interruptor como esté.
 *   · surface = prefijo de versionMax.
 *
 * Nada de esto cobra: los asientos se facturan por días activos y la comisión
 * sale de usage_daily. Este dinero solo decide el aviso y la columna de la
 * tarjeta de máquinas.
 */

import { COMISIONAR_REFERENCIA } from "../billing/tarifa";
import { compararVersiones, parsearVersion, superficieDe } from "./semver";
import { DIA_MS, VENTANA_AVISO_DIAS, type AsientoVisto } from "./aviso-version";

/** Una fila de seat_activity ya normalizada por el lector. */
export interface FilaAsiento {
  seatId: string;
  isCi: boolean;
  /** ISO de la fecha (YYYY-MM-DD). */
  day: string;
  /** ISO timestamp. */
  lastSeenAt: string;
  versionMin: string | null;
  versionMax: string | null;
  requestsSinVersion: number;
  measuredBaselineCost: number;
  measuredActualCost: number;
  /** 0031: lo medido por referencia en ese asiento-día. Ausente sin 0031 (cuenta como 0). */
  referenceBaselineCost?: number;
  referenceActualCost?: number;
}

export interface OpcionesAgregado {
  /** ¿Suma lo medido por referencia a `ahorroMedido7dUsd`? Por defecto, el interruptor de cobro. */
  incluirReferencia?: boolean;
}

function menor(a: string | null, b: string | null): string | null {
  if (a === null || !parsearVersion(a)) return b;
  if (b === null || !parsearVersion(b)) return a;
  return compararVersiones(b, a) < 0 ? b : a;
}
function mayor(a: string | null, b: string | null): string | null {
  if (a === null || !parsearVersion(a)) return b;
  if (b === null || !parsearVersion(b)) return a;
  return compararVersiones(b, a) > 0 ? b : a;
}

export function agregarAsientos(
  filas: readonly FilaAsiento[],
  nowMs: number,
  { incluirReferencia = COMISIONAR_REFERENCIA }: OpcionesAgregado = {},
): AsientoVisto[] {
  const desde7d = nowMs - VENTANA_AVISO_DIAS * DIA_MS;
  interface Acum {
    seatId: string;
    isCi: boolean;
    lastSeenMs: number;
    lastSeenAt: string;
    min7: string | null;
    max7: string | null;
    min30: string | null;
    max30: string | null;
    sinVersion7d: boolean;
    conDatos7d: boolean;
    ahorro7d: number;
    ref7d: number;
  }
  const porAsiento = new Map<string, Acum>();
  for (const f of filas) {
    const acum = porAsiento.get(f.seatId) ?? {
      seatId: f.seatId,
      isCi: f.isCi,
      lastSeenMs: Number.NEGATIVE_INFINITY,
      lastSeenAt: f.lastSeenAt,
      min7: null,
      max7: null,
      min30: null,
      max30: null,
      sinVersion7d: false,
      conDatos7d: false,
      ahorro7d: 0,
      ref7d: 0,
    };
    // Un asiento es CI si CUALQUIER fila lo marcó: un job puede haber corrido
    // un turno sin la variable de entorno y no por eso deja de ser efímero.
    acum.isCi = acum.isCi || f.isCi;
    const vistoMs = Date.parse(f.lastSeenAt);
    if (!Number.isNaN(vistoMs) && vistoMs > acum.lastSeenMs) {
      acum.lastSeenMs = vistoMs;
      acum.lastSeenAt = f.lastSeenAt;
    }
    acum.min30 = menor(acum.min30, f.versionMin);
    acum.max30 = mayor(acum.max30, f.versionMax);
    // La ventana de 7 días se decide por el DÍA de la fila (grano de la tabla),
    // no por last_seen_at: una fila de hace 8 días tocada hoy sigue siendo de
    // hace 8 días.
    const diaMs = Date.parse(`${f.day}T00:00:00Z`);
    const en7d = !Number.isNaN(diaMs) && diaMs + DIA_MS > desde7d;
    if (en7d) {
      // Una fila ANTERIOR a 0024 no trae versión ni contador de sin-versión: sus
      // measured_* son los defaults (0). Sumarla como «0 € medidos en 7 días»
      // encendería el banner ámbar en todas las máquinas el día de la migración,
      // sin que ninguna haya dejado de ahorrar. No aporta dato: se salta.
      const preCanal = f.versionMin === null && f.versionMax === null && f.requestsSinVersion === 0;
      if (!preCanal) {
        acum.conDatos7d = true;
        acum.min7 = menor(acum.min7, f.versionMin);
        acum.max7 = mayor(acum.max7, f.versionMax);
        if (f.requestsSinVersion > 0) acum.sinVersion7d = true;
        acum.ahorro7d += f.measuredBaselineCost - f.measuredActualCost;
        // 0031 · la referencia del asiento-día. Mismo filtro de ventana y de
        // pre-canal que lo medido: una fila vieja no aporta ni una cosa ni la otra.
        acum.ref7d += (f.referenceBaselineCost ?? 0) - (f.referenceActualCost ?? 0);
      }
    }
    porAsiento.set(f.seatId, acum);
  }
  const asientos: AsientoVisto[] = [];
  for (const a of porAsiento.values()) {
    const versionMin = a.min7 ?? a.min30;
    const versionMax = a.max7 ?? a.max30;
    asientos.push({
      seatId: a.seatId,
      isCi: a.isCi,
      surface: superficieDe(versionMax),
      versionMin,
      versionMax,
      sinVersion7d: a.sinVersion7d,
      lastSeenAt: a.lastSeenAt,
      ahorroMedido7dUsd: a.ahorro7d + (incluirReferencia ? a.ref7d : 0),
      ahorroReferencia7dUsd: a.ref7d,
      conDatos7d: a.conDatos7d,
    });
  }
  // Los más recientes primero; la tarjeta corta por arriba.
  asientos.sort((x, y) => Date.parse(y.lastSeenAt) - Date.parse(x.lastSeenAt));
  return asientos;
}
