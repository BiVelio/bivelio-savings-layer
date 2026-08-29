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

  it("la frontera de la gracia cae del lado generoso", () => {
    const justoEnElLimite = lic({ expires_at: enISO(AHORA - 14 * DIA), grace_days: 14 });
    expect(decideEntitlement([justoEnElLimite], [], AHORA).blocked).toBe(false);
    const unDiaMas = lic({ expires_at: enISO(AHORA - 15 * DIA), grace_days: 14 });
    expect(decideEntitlement([unDiaMas], [], AHORA).blocked).toBe(true);
  });

  // ── EL FALLO QUE MOTIVA MIRAR TODAS LAS FILAS ───────────────────────────
  // El candado leía UNA sola suscripción, la más reciente
  // (`order created_at desc / limit(1)`). Basta con que la org tenga una fila no
  // vigente más nueva —la duplicada que se acaba de cancelar, la de cortesía que
  // se retiró— para que haga sombra a la vigente y el ingest devuelva 402 a un
  // cliente que PAGA. Y ese 402 no se recupera: el SDK solo reencola los 5xx, así
  // que el lote se pierde para siempre y con él los datos que alimentan los
  // asientos facturables y el extracto.
  it("una CANCELADA más reciente no tapa a una ACTIVA: basta con que UNA cubra", () => {
    const cancelada = sub({ status: "canceled" });
    const activa = sub({ status: "active" });
    // En cualquier orden: no depende de cuál llegue primero.
    expect(decideEntitlement([], [cancelada, activa], AHORA).blocked).toBe(false);
    expect(decideEntitlement([], [activa, cancelada], AHORA).blocked).toBe(false);
  });

  it("si NINGUNA cubre, se bloquea (el arreglo no abre la puerta)", () => {
    // Con una licencia REVOCADA de por medio: sin ese registro, `decideEntitlement`
    // devuelve `no-license-record` a propósito —quien nunca tuvo licencia no es
    // cosa de este candado— y no bloquearía por otra razón.
    const d = decideEntitlement(
      [lic({ revoked: true })],
      [sub({ status: "canceled" }), sub({ status: "unpaid" })],
      AHORA,
    );
    expect(d.blocked).toBe(true);
    expect(d.reason).toBe("license-revoked");
  });

  it("una sola CADUCADA tampoco cubre: mirar todas no relaja la ventana", () => {
    const caducada = sub({ status: "active", current_period_end: enISO(AHORA - 30 * DIA) });
    const d = decideEntitlement([lic({ revoked: true })], [caducada], AHORA);
    expect(d.blocked).toBe(true);
  });
});
