import { describe, it, expect } from "vitest";

import { formatearPrecio } from "./precio";

/**
 * El precio de suscripción no tenía NINGÚN test — ese vacío es exactamente cómo la web
 * llegó a anunciar dólares mientras Stripe cobraba euros.
 */
describe("formatearPrecio", () => {
  const cuatroEuros = { amount: 400, currency: "eur" };
  const treintaYNueve = { amount: 3900, currency: "eur" };

  it("usa la moneda que le llega, no una fija", () => {
    // Lo que rompió el producto fue tener el símbolo escrito a mano.
    expect(formatearPrecio("es", cuatroEuros)).toContain("€");
    expect(formatearPrecio("es", cuatroEuros)).not.toContain("$");
    expect(formatearPrecio("en", { amount: 400, currency: "usd" })).toContain("$");
  });

  it("coloca el símbolo según el idioma", () => {
    // En español el símbolo va detrás; en inglés, delante. Antes los 12 idiomas
    // decían "€4", que solo es correcto en inglés.
    const es = formatearPrecio("es", cuatroEuros);
    const en = formatearPrecio("en", cuatroEuros);
    expect(es.trim().endsWith("€")).toBe(true);
    expect(en.trim().startsWith("€")).toBe(true);
  });

  it("oculta los decimales cuando el importe es entero", () => {
    expect(formatearPrecio("en", cuatroEuros)).toBe("€4");
    expect(formatearPrecio("en", treintaYNueve)).toBe("€39");
  });

  it("muestra los decimales cuando de verdad los hay", () => {
    expect(formatearPrecio("en", { amount: 450, currency: "eur" })).toBe("€4.50");
  });

  it("una moneda SIN decimales no se divide entre 100", () => {
    // Stripe expresa el yen en unidades enteras. Dividir entre 100 daría un importe
    // cien veces menor, y en silencio.
    expect(formatearPrecio("en", { amount: 500, currency: "jpy" })).toContain("500");
    expect(formatearPrecio("en", { amount: 500, currency: "jpy" })).not.toContain("5.00");
  });

  it("es determinista: el mismo locale da siempre el mismo texto", () => {
    // La garantía que evita el error de hidratación #418.
    const a = formatearPrecio("de", cuatroEuros);
    const b = formatearPrecio("de", cuatroEuros);
    expect(a).toBe(b);
  });
});
