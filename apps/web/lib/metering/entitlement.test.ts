import { describe, it, expect } from "vitest";

import { decideEntitlement, type LicenseRow, type SubscriptionRow } from "./entitlement";

/**
 * El candado de servidor que faltaba: el ingest no comprobaba entitlement, así
 * que un cliente revocado seguía facturando y conservando panel. Esta es la
 * decisión, y refleja la lógica del SDK (revocada > caducada-pasada-gracia >
 * vigente). Si las dos discrepan, un cliente funciona en un sitio y no en otro.
 */

const AHORA = Date.UTC(2026, 7, 15);
const DIA = 86_400_000;
const enISO = (ms: number) => new Date(ms).toISOString();

const lic = (over: Partial<LicenseRow> = {}): LicenseRow => ({
  revoked: false,
  expires_at: enISO(AHORA + 30 * DIA),
  grace_days: 14,
  ...over,
});
const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: "active",
  current_period_end: enISO(AHORA + 30 * DIA),
  ...over,
});

describe("entitlement del ingest", () => {
  it("una licencia vigente NO se bloquea", () => {
    expect(decideEntitlement([lic()], [], AHORA).blocked).toBe(false);
  });

  it("una licencia REVOCADA sin suscripción SE BLOQUEA (el ataque)", () => {
    const d = decideEntitlement([lic({ revoked: true })], [], AHORA);
    expect(d.blocked).toBe(true);
    expect(d.reason).toBe("license-revoked");
  });

  it("una licencia caducada PASADA LA GRACIA se bloquea", () => {
    const caducada = lic({ expires_at: enISO(AHORA - 20 * DIA), grace_days: 14 });
    expect(decideEntitlement([caducada], [], AHORA).blocked).toBe(true);
  });

  it("una licencia caducada pero DENTRO de la gracia NO se bloquea", () => {
    // Tarjeta falló, 14 días para renovar: sigue facturando.
    const enGracia = lic({ expires_at: enISO(AHORA - 5 * DIA), grace_days: 14 });
    expect(decideEntitlement([enGracia], [], AHORA).blocked).toBe(false);
  });

  it("revocada pero con suscripción ACTIVA no se bloquea (la sub cubre)", () => {
    expect(decideEntitlement([lic({ revoked: true })], [sub()], AHORA).blocked).toBe(false);
  });

  it("sin licencia válida pero con suscripción activa no se bloquea", () => {
    expect(decideEntitlement([], [sub()], AHORA).blocked).toBe(false);
  });

  it("una suscripción CANCELADA no cubre", () => {
    const d = decideEntitlement([lic({ revoked: true })], [sub({ status: "canceled" })], AHORA);
    expect(d.blocked).toBe(true);
  });

  it("una org SIN NINGUNA licencia (trial/free) NO se bloquea aquí", () => {
    // Este candado para revocados/caducados, no la caducidad del trial.
    const d = decideEntitlement([], [], AHORA);
    expect(d.blocked).toBe(false);
    expect(d.reason).toBe("no-license-record");
  });

  it("con varias licencias, basta UNA válida para no bloquear", () => {
    const licencias = [lic({ revoked: true }), lic({ expires_at: enISO(AHORA - 40 * DIA) }), lic()];
    expect(decideEntitlement(licencias, [], AHORA).blocked).toBe(false);
  });

  it("past_due y trialing siguen cubriendo; unpaid no", () => {
    expect(decideEntitlement([], [sub({ status: "past_due" })], AHORA).blocked).toBe(false);
    expect(decideEntitlement([], [sub({ status: "trialing" })], AHORA).blocked).toBe(false);
    expect(decideEntitlement([lic({ revoked: true })], [sub({ status: "unpaid" })], AHORA).blocked).toBe(true);
  });

  it("una suscripción cancelada NO hace sombra a otra activa de la misma org", () => {
    // El fallo #9: el candado leía solo la suscripción más NUEVA. Al cancelar una
    // duplicada (la más reciente), la org perdía el ingest pese a seguir pagando
    // la otra. Con todas a la vista, basta una activa para dar derecho —da igual
    // que la cancelada sea posterior.
    const revocadas = [lic({ revoked: true })];
    const cancelada = sub({ status: "canceled" });
    const activa = sub({ status: "active" });
    expect(decideEntitlement(revocadas, [cancelada, activa], AHORA).blocked).toBe(false);
    // Y sin ninguna activa, sí se bloquea (no rompimos el corte legítimo).
    expect(decideEntitlement(revocadas, [cancelada], AHORA).blocked).toBe(true);
  });

  it("la frontera de la gracia cae del lado generoso", () => {
    const justoEnElLimite = lic({ expires_at: enISO(AHORA - 14 * DIA), grace_days: 14 });
    expect(decideEntitlement([justoEnElLimite], [], AHORA).blocked).toBe(false);
    const unDiaMas = lic({ expires_at: enISO(AHORA - 15 * DIA), grace_days: 14 });
    expect(decideEntitlement([unDiaMas], [], AHORA).blocked).toBe(true);
  });
});
