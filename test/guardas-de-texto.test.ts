import { describe, it, expect } from "vitest";

import {
  contarNegaciones,
  mismosDatosCriticos,
  palabras,
  tokensNumericos,
} from "../src/canonicalization/guardas-de-texto.js";
import { keyTokensMatch } from "../src/cache/semantic.js";

/**
 * Las guardas de datos críticos, centralizadas y con es/ca.
 *
 * Dos agujeros que cerraba la centralización: (1) la lista de negaciones era solo
 * inglesa, así que «factura sin IVA» ↔ «factura con IVA» pasaba la verja de la
 * caché semántica (respuesta invertida en es/ca); (2) el prefijo de rol `user:`
 * que canonicalize fusiona con la primera palabra rompía `keyTokensMatch`.
 */

describe("negación es/ca en las guardas", () => {
  it("cuenta negaciones en castellano y catalán, no solo inglés", () => {
    expect(contarNegaciones(palabras("factura sin iva"))).toBe(1);
    expect(contarNegaciones(palabras("factura con iva"))).toBe(0);
    expect(contarNegaciones(palabras("nunca puedo cancelar"))).toBe(1);
    expect(contarNegaciones(palabras("puc pagar sense targeta"))).toBe(1); // ca
    expect(contarNegaciones(palabras("no invoice"))).toBe(1); // en sigue
  });
});

describe("keyTokensMatch — la respuesta invertida ya no pasa", () => {
  it("«sin IVA» / «con IVA» se separan (es), como su control inglés", () => {
    expect(keyTokensMatch("factura sin iva", "factura con iva")).toBe(false);
    expect(keyTokensMatch("invoice without vat", "invoice with vat")).toBe(false);
  });

  it("«sense targeta» / «amb targeta» se separan (ca)", () => {
    expect(keyTokensMatch("puc pagar sense targeta", "puc pagar amb targeta")).toBe(false);
  });

  it("una paráfrasis de cortesía SÍ casa pese al prefijo de rol user:", () => {
    // El caso estrella del #87, que el prefijo de rol rompía por el camino real.
    expect(keyTokensMatch("user:resume este informe", "user:por favor resume este informe")).toBe(true);
    // Y sigue casando sin prefijo (no rompimos el camino pelado).
    expect(keyTokensMatch("resume este informe", "por favor resume este informe")).toBe(true);
  });

  it("el prefijo de rol no enmascara un cambio real de contenido", () => {
    expect(keyTokensMatch("user:reembolso 100 euros", "user:reembolso 200 euros")).toBe(false);
  });
});

describe("mismosDatosCriticos (fidelidad de compresión)", () => {
  it("una negación invertida NO conserva los datos críticos", () => {
    expect(mismosDatosCriticos("Refunds are not allowed after 30 days", "Refunds are allowed after 30 days")).toBe(false);
  });
  it("quitar relleno SÍ los conserva (la compresión debe poder)", () => {
    expect(mismosDatosCriticos("Please kindly summarize this long report for me", "summarize this report")).toBe(true);
  });
  it("cambiar o perder un número no los conserva", () => {
    expect(mismosDatosCriticos("el total es 118 euros", "el total es 119 euros")).toBe(false);
    expect(mismosDatosCriticos("30 días de plazo", "días de plazo")).toBe(false);
  });
  it("tokensNumericos capta cifras, horas y fechas", () => {
    expect(tokensNumericos("el tren de las 12:30 del 20/07/2026")).toEqual(["12:30", "20/07/2026"]);
  });
});
