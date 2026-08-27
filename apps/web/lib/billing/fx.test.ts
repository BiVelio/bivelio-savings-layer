import { describe, it, expect } from "vitest";

import { fxDesdeXmlBce, obtenerFxCierre, FxNoDisponible } from "./fx";

/**
 * EL FX DEL CIERRE, DEL BCE. Antes se sellaba la fila inmutable con 0,9 fijo y
 * Stripe cobraba esa cifra de mentira. Aquí se prueba el parseo del XML real
 * (incluida la fecha, que va en la fuente) y el fail-closed: sin BCE fiable NO
 * se inventa un cambio, se lanza para que el cron aborte y reintente.
 */

const XML_BCE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-08-31'>
      <Cube currency='USD' rate='1.0857'/>
      <Cube currency='JPY' rate='161.4'/>
      <Cube currency='GBP' rate='0.8542'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("fxDesdeXmlBce", () => {
  it("lee el USD/EUR y devuelve su inverso, con la fecha en la fuente", () => {
    const fx = fxDesdeXmlBce(XML_BCE);
    expect(fx.eurPorUsd).toBeCloseTo(1 / 1.0857, 10);
    expect(fx.fuente).toContain("BCE 2026-08-31");
    expect(fx.fuente).toContain("1.0857");
  });

  it("tolera comillas dobles y orden de atributos distinto", () => {
    const xml = `<Cube time="2026-08-31"><Cube rate="1.1" currency="USD"/></Cube>`;
    expect(fxDesdeXmlBce(xml).eurPorUsd).toBeCloseTo(1 / 1.1, 10);
  });

  it("⛔ un XML sin USD lanza FxNoDisponible (nunca un cambio inventado)", () => {
    const xml = `<Cube time='2026-08-31'><Cube currency='JPY' rate='161.4'/></Cube>`;
    expect(() => fxDesdeXmlBce(xml)).toThrow(FxNoDisponible);
  });

  it("⛔ un rate no numérico o <= 0 lanza", () => {
    expect(() => fxDesdeXmlBce(`<Cube currency='USD' rate='x'/>`)).toThrow(FxNoDisponible);
    expect(() => fxDesdeXmlBce(`<Cube currency='USD' rate='0'/>`)).toThrow(FxNoDisponible);
  });
});

describe("obtenerFxCierre — fail-closed", () => {
  it("con el BCE respondiendo, devuelve el cambio", async () => {
    const fetchOk = (async () => ({ ok: true, text: async () => XML_BCE })) as unknown as typeof fetch;
    const fx = await obtenerFxCierre(fetchOk);
    expect(fx.eurPorUsd).toBeCloseTo(1 / 1.0857, 10);
  });

  it("⛔ BCE caído (HTTP 503) → FxNoDisponible, no un cambio de relleno", async () => {
    const fetch503 = (async () => ({ ok: false, status: 503, text: async () => "" })) as unknown as typeof fetch;
    await expect(obtenerFxCierre(fetch503)).rejects.toBeInstanceOf(FxNoDisponible);
  });

  it("⛔ error de red → FxNoDisponible", async () => {
    const fetchRed = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(obtenerFxCierre(fetchRed)).rejects.toBeInstanceOf(FxNoDisponible);
  });
});
