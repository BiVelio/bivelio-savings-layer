// INTERNO: fuera del barril `src/license/index.ts` a propósito. No es API
// pública del paquete (test/api-publica-congelada.test.ts, #418); lo usan el
// verificador del SDK (verify.ts) y el de la pasarela (gateway/license.ts).

/**
 * The term of a free «Measure» license, and why it lives in its own fields.
 *
 * A measure license is signed with `expires_at = issued_at` and `grace_days = 0`,
 * and its real term in `measure_expires_at` / `measure_grace_days`. An SDK or
 * gateway that predates shadow mode (and would turn on the levers that are not
 * gated by a feature) sees it EXPIRED and fails closed; this verifier, which
 * knows the plan, reads the real term. Applied at the single point every
 * verified payload goes through.
 */
export function vigenciaEfectiva<P extends { plan?: string; expires_at: number; grace_days: number; measure_expires_at?: number; measure_grace_days?: number }>(
  p: P,
): P {
  if (p.plan !== "measure" || typeof p.measure_expires_at !== "number" || !Number.isFinite(p.measure_expires_at)) {
    return p;
  }
  const gracia = typeof p.measure_grace_days === "number" && Number.isFinite(p.measure_grace_days) ? p.measure_grace_days : 0;
  return { ...p, expires_at: p.measure_expires_at, grace_days: Math.max(0, gracia) };
}
