import { describe, it, expect } from "vitest";

import { motivoDeReemision } from "./reemision";

/**
 * Cuándo la licencia tiene que volver a emitirse. Cada caso de aquí es dinero:
 * re-emitir de menos deja al cliente con una licencia que caduca antes de lo que
 * ha pagado; re-emitir de más le rompe la continuidad del token sin ganar nada.
 */

const DIA = 86_400;
const AHORA = Math.floor(Date.parse("2026-08-12T00:00:00Z") / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const licenciaMensual = { seats: 3, expiresAt: iso(AHORA + 30 * DIA) };

describe("cuándo se re-emite la licencia", () => {
  it("sin cambios: no se toca", () => {
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 30 * DIA,
        licencia: licenciaMensual,
      }),
    ).toBeNull();
  });

  it("cambian los asientos: se re-emite", () => {
    expect(
      motivoDeReemision({
        asientosNuevos: 8,
        finDePeriodoUnix: AHORA + 30 * DIA,
        licencia: licenciaMensual,
      }),
    ).toBe("asientos");
  });

  it("MENSUAL → ANUAL con los mismos asientos: se re-emite — este era el agujero", () => {
    // La cantidad no cambia, así que la condición vieja no hacía nada y la
    // licencia conservaba la caducidad mensual: el cliente pagaba doce meses y el
    // SDK se le paraba hacia el día 51.
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 365 * DIA,
        licencia: licenciaMensual,
      }),
    ).toBe("periodo");
  });

  it("también al revés: anual → mensual acorta la licencia como toca", () => {
    const anual = { seats: 3, expiresAt: iso(AHORA + 365 * DIA) };
    expect(
      motivoDeReemision({ asientosNuevos: 3, finDePeriodoUnix: AHORA + 30 * DIA, licencia: anual }),
    ).toBe("periodo");
  });

  it("la renovación normal, que mueve el periodo un mes, también re-emite", () => {
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 60 * DIA,
        licencia: licenciaMensual,
      }),
    ).toBe("periodo");
  });

  it("los asientos mandan sobre el periodo en el motivo, para que el rastro sea legible", () => {
    expect(
      motivoDeReemision({
        asientosNuevos: 8,
        finDePeriodoUnix: AHORA + 365 * DIA,
        licencia: licenciaMensual,
      }),
    ).toBe("asientos");
  });

  it("una diferencia de segundos NO dispara una re-emisión", () => {
    // Sin tolerancia, un redondeo re-emitiría en cada evento de Stripe, y esos
    // eventos llegan por muchos motivos.
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 30 * DIA + 30,
        licencia: licenciaMensual,
      }),
    ).toBeNull();
  });

  it("sin licencia viva no se re-emite: eso es una EMISIÓN y va por otro camino", () => {
    expect(
      motivoDeReemision({ asientosNuevos: 3, finDePeriodoUnix: AHORA + 30 * DIA, licencia: null }),
    ).toBeNull();
  });

  it("sin fecha con la que comparar, ante la duda NO se re-emite", () => {
    // Re-emitir de más rompe la continuidad del token del cliente sin ganar nada.
    expect(
      motivoDeReemision({ asientosNuevos: 3, finDePeriodoUnix: null, licencia: licenciaMensual }),
    ).toBeNull();
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 365 * DIA,
        licencia: { seats: 3, expiresAt: null },
      }),
    ).toBeNull();
    expect(
      motivoDeReemision({
        asientosNuevos: 3,
        finDePeriodoUnix: AHORA + 365 * DIA,
        licencia: { seats: 3, expiresAt: "no-es-una-fecha" },
      }),
    ).toBeNull();
  });
});
