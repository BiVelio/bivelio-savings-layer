import { describe, it, expect } from "vitest";

import { decidirAviso } from "./aviso";

/**
 * Qué ve el cliente cuando el dinero va mal. Los dos errores que se prueban aquí
 * son opuestos y los dos caros: callar cuando hay que avisar (el cliente descubre
 * el problema cuando el SDK se para) y avisar de lo que no es (mandarle a renovar
 * una licencia cuando lo que tiene es una tarjeta que no pasa).
 */

const DIA = 86_400_000;
const AHORA = Date.parse("2026-08-11T12:00:00Z");
const haceDias = (n: number) => new Date(AHORA - n * DIA).toISOString();
const enDias = (n: number) => new Date(AHORA + n * DIA).toISOString();

const licenciaSana = { status: "active" as const, expiresAt: enDias(20), graceDays: 21 };
/** Caso típico del impago de RENOVACIÓN: la licencia caduca justo al fallar el cobro. */
const licenciaQueCaducaHoy = { status: "grace" as const, expiresAt: haceDias(0), graceDays: 21 };

describe("qué aviso ve el cliente", () => {
  it("todo en orden: no se pinta nada", () => {
    expect(
      decidirAviso({
        subscription: { status: "active", pastDueSince: null },
        license: licenciaSana,
        nowMs: AHORA,
      }),
    ).toBeNull();
  });

  it("sin suscripción ni licencia: tampoco se inventa un aviso", () => {
    expect(decidirAviso({ subscription: null, license: null, nowMs: AHORA })).toBeNull();
  });

  it("cobro fallido: avisa con los días que le quedan DE SERVICIO", () => {
    // Falla la renovación: la licencia caduca hoy y le quedan sus 21 firmados.
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(5) },
      license: licenciaQueCaducaHoy,
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a).toEqual({ tipo: "pastDue", dias: 21 });
  });

  it("con la licencia aún lejos de caducar, la cifra es la suya, no la del impago", () => {
    // Impago a mitad de ciclo (una factura de prorrateo) con el periodo principal
    // pagado: al cliente le quedan 41 días de servicio de verdad, y eso es lo que
    // se le dice. El reloj del impago diría 16, y sería mentira por defecto.
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(5) },
      license: licenciaSana,
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a).toEqual({ tipo: "pastDue", dias: 41 });
  });

  it("cobro fallido y servicio ya cortado: el aviso cambia", () => {
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(40) },
      license: { status: "expired", expiresAt: haceDias(40), graceDays: 21 },
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a).toEqual({ tipo: "pastDueEnded" });
  });

  it("cobro fallido sin sello NI licencia: avisa igual, sin cifra", () => {
    // Lo importante es «tu tarjeta no pasa», no cuántos días quedan.
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: null },
      license: null,
      nowMs: AHORA,
    });
    expect(a).toEqual({ tipo: "pastDue", dias: null });
  });

  it("los días que enseña son los de la LICENCIA, no los de la constante", () => {
    // Una licencia emitida antes de que la gracia subiera lleva 14 días FIRMADOS
    // dentro, y ninguna variable de entorno de hoy cambia un token de ayer. Con
    // la constante en 21 el aviso prometía servicio que ya no existía.
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(1) },
      license: { status: "grace", expiresAt: haceDias(10), graceDays: 14 },
      nowMs: AHORA,
      graciaDias: 21,
    });
    // 10 días caducada + 14 firmados = 4 días de servicio, no los 20 del reloj nuestro.
    expect(a).toEqual({ tipo: "pastDue", dias: 4 });
  });

  it("si el SDK ya se paró, el aviso no promete días que no hay", () => {
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(1) },
      license: { status: "expired", expiresAt: haceDias(40), graceDays: 14 },
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a).toEqual({ tipo: "pastDueEnded" });
  });

  it("sin licencia con la que contar, cae al reloj del impago", () => {
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(5) },
      license: null,
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a).toEqual({ tipo: "pastDue", dias: 16 });
  });

  it("el dinero manda sobre la licencia", () => {
    // Con la tarjeta fallando Y la licencia caducada, el aviso útil es el de la
    // tarjeta: mandarle a «renovar licencia» es mandarle a la pantalla equivocada.
    const a = decidirAviso({
      subscription: { status: "past_due", pastDueSince: haceDias(2) },
      license: { status: "expired", expiresAt: haceDias(1), graceDays: 21 },
      nowMs: AHORA,
      graciaDias: 21,
    });
    expect(a?.tipo).toBe("pastDue");
  });

  it("pago SEPA en vuelo: se le dice que NO vuelva a comprar", () => {
    const a = decidirAviso({
      subscription: { status: "incomplete", pastDueSince: null },
      license: null,
      nowMs: AHORA,
    });
    expect(a).toEqual({ tipo: "incomplete" });
  });

  it("licencia en gracia: cuenta los días que le quedan", () => {
    const a = decidirAviso({
      subscription: { status: "active", pastDueSince: null },
      license: { status: "grace", expiresAt: haceDias(1), graceDays: 21 },
      nowMs: AHORA,
    });
    expect(a).toEqual({ tipo: "grace", dias: 20, expiresAt: haceDias(1) });
  });

  it("licencia caducada y revocada tienen avisos distintos", () => {
    const caducada = decidirAviso({
      subscription: null,
      license: { status: "expired", expiresAt: haceDias(30), graceDays: 21 },
      nowMs: AHORA,
    });
    expect(caducada?.tipo).toBe("expired");

    const revocada = decidirAviso({
      subscription: null,
      license: { status: "revoked", expiresAt: enDias(10), graceDays: 21 },
      nowMs: AHORA,
    });
    expect(revocada).toEqual({ tipo: "revoked" });
  });

  it("una cancelada no dispara el aviso de impago", () => {
    // Ahí el camino es comprar de nuevo, no arreglar una tarjeta.
    const a = decidirAviso({
      subscription: { status: "canceled", pastDueSince: haceDias(60) },
      license: null,
      nowMs: AHORA,
    });
    expect(a).toBeNull();
  });
});
