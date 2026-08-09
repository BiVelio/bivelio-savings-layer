import { describe, it, expect } from "vitest";

import { reconcileSeats } from "./seat-reconciliation";

/**
 * El true-up de asientos: usados (billable_seats) vs pagados (Stripe). Y la
 * robustez que exigió la auditoría — que un seat_id fijado a mano no permita
 * infra-declarar sin que salte una alarma.
 */

describe("reconciliación de asientos", () => {
  it("dentro de lo pagado: no se hace nada", () => {
    const d = reconcileSeats({ usedSeats: 3, paidSeats: 5, requests: 1000 });
    expect(d.action).toBe("none");
    expect(d.overage).toBe(0);
  });

  it("justo en el límite: no se hace nada", () => {
    expect(reconcileSeats({ usedSeats: 5, paidSeats: 5, requests: 1000 }).action).toBe("none");
  });

  it("usa MÁS de lo pagado: true-up por la diferencia", () => {
    const d = reconcileSeats({ usedSeats: 8, paidSeats: 5, requests: 5000 });
    expect(d.action).toBe("true-up");
    expect(d.overage).toBe(3);
  });

  it("sin suscripción (paid null) cuenta como 0 pagados", () => {
    const d = reconcileSeats({ usedSeats: 2, paidSeats: null, requests: 500 });
    expect(d.action).toBe("true-up");
    expect(d.overage).toBe(2);
  });

  it("colapso de seat_id: 1 asiento declarado con volumen imposible → REVISIÓN, no cobro automático", () => {
    // Paga 1, declara 1, pero hace millones de peticiones: mil máquinas con el
    // mismo BVSALA_SEAT_ID. El recuento no es fiable, así que no se cobra por él
    // automáticamente — se marca para revisión humana.
    const d = reconcileSeats({ usedSeats: 1, paidSeats: 1, requests: 5_000_000 });
    expect(d.action).toBe("review");
    expect(d.suspicious).toBe(true);
  });

  it("la revisión tiene precedencia sobre el true-up: recuento no fiable", () => {
    // Aunque parezca overage, si el volumen no cuadra el propio recuento es dudoso.
    const d = reconcileSeats({ usedSeats: 3, paidSeats: 1, requests: 10_000_000 });
    expect(d.action).toBe("review");
  });

  it("un usuario legítimamente INTENSIVO no se marca como sospechoso", () => {
    // 5 asientos, 200k peticiones al mes = 40k/asiento: mucho, pero por debajo
    // del umbral. No debe saltar (sería un susto para un buen cliente).
    const d = reconcileSeats({ usedSeats: 5, paidSeats: 5, requests: 200_000 });
    expect(d.suspicious).toBe(false);
    expect(d.action).toBe("none");
  });

  it("el umbral de sospecha es configurable", () => {
    const estricto = reconcileSeats({ usedSeats: 2, paidSeats: 2, requests: 30_000, suspiciousRequestsPerSeat: 10_000 });
    expect(estricto.action).toBe("review");
    const laxo = reconcileSeats({ usedSeats: 2, paidSeats: 2, requests: 30_000, suspiciousRequestsPerSeat: 1_000_000 });
    expect(laxo.action).toBe("none");
  });

  it("cero peticiones y cero uso: nada que reconciliar", () => {
    const d = reconcileSeats({ usedSeats: 0, paidSeats: 3, requests: 0 });
    expect(d.action).toBe("none");
    expect(d.suspicious).toBe(false);
  });
});
