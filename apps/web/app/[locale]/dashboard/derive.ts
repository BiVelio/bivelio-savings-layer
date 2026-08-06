/**
 * Derivaciones puras del panel.
 *
 * Viven aparte de `data.ts` a propósito: ese fichero importa `next-intl/server`
 * y clientes de Supabase, así que no se puede cargar desde vitest. Aquí no hay
 * más que aritmética y fechas, de modo que la lógica que decide QUÉ AFIRMA el
 * panel sí se puede probar. Hasta ahora `apps/web/**` no estaba en ningún glob
 * de vitest.config.ts: el dashboard entero llegó a producción con cobertura
 * CERO.
 */

export type LicenseStatus = "active" | "grace" | "expired" | "revoked";

export interface LicenseRow {
  expires_at?: string;
  grace_days?: number;
  revoked?: boolean;
}

/**
 * Estado real de una licencia, con la misma semántica que aplica el SDK en
 * `src/license/verify.ts` (revocada > expirada > gracia). Si las dos se separan,
 * el panel acabará afirmando algo que el SDK no respalda.
 */
export function deriveLicenseStatus(row: LicenseRow | null, nowMs: number): LicenseStatus | null {
  // `null` no es "desconocido": es AUSENCIA MEDIDA. No hay licencia, y eso es un
  // hecho, no una laguna. Quien llama decide cómo contarlo.
  if (!row || !row.expires_at) return null;
  if (row.revoked) return "revoked";

  const expira = Date.parse(row.expires_at);
  if (Number.isNaN(expira)) return null;
  if (nowMs <= expira) return "active";

  const gracia = (row.grace_days ?? 0) * 86_400_000;
  return nowMs <= expira + gracia ? "grace" : "expired";
}

/** Lo que el titular de ahorro puede decir con lo que de verdad se ha medido. */
export type Verdict =
  | { kind: "empty" }                          // no hay tráfico medido
  | { kind: "unpriced" }                       // hay tráfico, pero sin baseline con el que comparar
  | { kind: "measured"; net: number; saved: number; tone: "pos" | "neg" };

/**
 * El titular era `net = baseline > 0 ? 1 - actual/baseline : 0` y se pintaba con
 * la clase `pos` fija. Dos mentiras en una línea: con filas medidas pero
 * baseline 0 salía "0.0%" en verde —un cero fabricado— y una pérdida real
 * (actual > baseline) también salía en verde.
 */
export function deriveVerdict(usage: { baselineCost: number; actualCost: number }[]): Verdict {
  if (usage.length === 0) return { kind: "empty" };
  const baseline = usage.reduce((n, r) => n + r.baselineCost, 0);
  const actual = usage.reduce((n, r) => n + r.actualCost, 0);
  if (!(baseline > 0)) return { kind: "unpriced" };
  const net = 1 - actual / baseline;
  return { kind: "measured", net, saved: baseline - actual, tone: net < 0 ? "neg" : "pos" };
}
