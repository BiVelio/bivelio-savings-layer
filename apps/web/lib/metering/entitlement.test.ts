import { describe, it, expect } from "vitest";

import { decideEntitlement, hasValidLicense, hasValidMeasureLicense, type LicenseRow, type SubscriptionRow } from "./entitlement";

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

  it("sin fila de licencia pero con suscripción ACTIVA no se bloquea (la fila aún no se ha escrito)", () => {
    // El webhook de Stripe puede ir por detrás de la suscripción: esa org paga, y
    // cerrar el free tier no puede cortarla.
    const d = decideEntitlement([], [sub()], AHORA);
    expect(d.blocked).toBe(false);
    expect(d.reason).toBe("active-subscription");
  });

  it("una suscripción CANCELADA no cubre", () => {
    const d = decideEntitlement([lic({ revoked: true })], [sub({ status: "canceled" })], AHORA);
    expect(d.blocked).toBe(true);
  });

  it("una org SIN NINGUNA licencia ni suscripción SE BLOQUEA (no hay free tier)", () => {
    // Antes pasaba con `no-license-record`: la ingesta le aceptaba uso y el panel
    // se llenaba sin pagar. Pilotos y probadores tienen siempre fila de licencia.
    const d = decideEntitlement([], [], AHORA);
    expect(d.blocked).toBe(true);
    expect(d.reason).toBe("no-license");
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
    // Con una licencia REVOCADA de por medio, para que el motivo sea
    // `license-revoked`: sin ninguna fila también se bloquearía, pero con
    // `no-license` (quien nunca tuvo licencia tampoco tiene free tier).
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

  // ── EL CONTRATO CON LA PASARELA ─────────────────────────────────────────
  // `/api/org/entitlements` devuelve `reason` SOLO si la org está bloqueada, y la
  // pasarela que verja por licencia corta las peticiones nuevas con cualquier
  // `reason` no vacío. Si
  // un motivo de concesión se confundiera con uno de bloqueo, cortaría a quien
  // paga; si un bloqueo saliera con un motivo de concesión, no cortaría a nadie.
  it("blocked ⇔ el motivo es de bloqueo, en todas las combinaciones", () => {
    const licencias: LicenseRow[][] = [
      [],
      [lic()],
      [lic({ revoked: true })],
      [lic({ expires_at: enISO(AHORA - 40 * DIA) })],
      [lic({ revoked: true }), lic({ expires_at: enISO(AHORA - 40 * DIA) })],
    ];
    const suscripciones: SubscriptionRow[][] = [[], [sub()], [sub({ status: "canceled" })]];
    const DE_BLOQUEO = ["no-license", "license-revoked", "license-expired"];
    const DE_CONCESION = ["valid-license", "active-subscription"];
    for (const l of licencias) {
      for (const s of suscripciones) {
        const d = decideEntitlement(l, s, AHORA);
        expect(d.blocked ? DE_BLOQUEO : DE_CONCESION, JSON.stringify({ l, s })).toContain(d.reason);
      }
    }
  });
});

describe("la licencia gratuita Medir (plan measure)", () => {
  const medir = (over: Partial<LicenseRow> = {}) => lic({ plan: "measure", grace_days: 30, ...over });

  it("solo Medir viva: NO se bloquea, con su propio motivo (la ingesta la neutraliza)", () => {
    expect(decideEntitlement([medir()], [], AHORA)).toEqual({ blocked: false, reason: "measure-license" });
  });

  it("Medir + licencia de pago: manda la de pago (valid-license)", () => {
    expect(decideEntitlement([medir(), lic({ plan: "pro" })], [], AHORA).reason).toBe("valid-license");
  });

  it("Medir + suscripción activa sin fila aún: manda la suscripción", () => {
    expect(decideEntitlement([medir()], [sub()], AHORA).reason).toBe("active-subscription");
  });

  it("Medir revocada (abuso) y nada más: se bloquea como cualquier revocada", () => {
    expect(decideEntitlement([medir({ revoked: true })], [], AHORA)).toEqual({ blocked: true, reason: "license-revoked" });
  });

  it("hasValidLicense NO cuenta una Medir: el barrido de impago y el invariante la tratan como «sin licencia pagada»", () => {
    expect(hasValidLicense([medir()], AHORA)).toBe(false);
    expect(hasValidMeasureLicense([medir()], AHORA)).toBe(true);
    expect(hasValidLicense([medir(), lic()], AHORA)).toBe(true);
  });

  it("una fila sin plan (consultas antiguas) sigue contando como pagada", () => {
    expect(hasValidLicense([lic()], AHORA)).toBe(true);
  });
});
