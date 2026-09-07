import { describe, it, expect } from "vitest";

import {
  APTITUD_CADUCA_TRAS_DIAS,
  APTITUD_V0,
  UMBRAL_APTITUD_PCT,
  eliden,
  veredictoDeVerja,
} from "../gateway/aptitud.js";

/**
 * LA VERJA POR MODELO. Lo que estas pruebas protegen no es una función de tres
 * líneas: es la promesa de que no se declara ahorro donde la política pierde
 * dinero. El caso que la motiva está medido dos veces (replay del corpus y
 * carril vivo, 2026-09-07): v0 da +27,4 % en fable-5 y −3,6 % en opus-4-8.
 */
describe("verja por modelo · la decisión", () => {
  const HOY = "2026-09-07";

  it("deja pasar el modelo medido con margen holgado", () => {
    const v = veredictoDeVerja("claude-fable-5", HOY);
    expect(v.aplica).toBe(true);
    expect(v.motivo).toBe("apto");
    expect(v.aptitud?.pct).toBeGreaterThan(UMBRAL_APTITUD_PCT);
  });

  it("cierra en el modelo donde la política PIERDE dinero — el caso que la motiva", () => {
    const v = veredictoDeVerja("claude-opus-4-8", HOY);
    expect(v.aplica).toBe(false);
    expect(v.motivo).toBe("pierde-dinero");
  });

  it("cierra en un modelo neutro: 0 % no compensa invalidar prefijo de caché", () => {
    expect(veredictoDeVerja("claude-sonnet-5", HOY).motivo).toBe("margen-insuficiente");
    expect(veredictoDeVerja("claude-opus-5", HOY).motivo).toBe("pierde-dinero");
  });

  it("ante un modelo DESCONOCIDO no elide — la doctrina de la duda", () => {
    expect(veredictoDeVerja("claude-modelo-que-sale-manana", HOY).motivo).toBe("sin-medicion");
    expect(eliden("claude-modelo-que-sale-manana", HOY)).toBe(false);
  });

  it("una medición caducada vuelve a ser desconocida y deja de elidir", () => {
    const dentro = "2026-12-05"; // 89 días después de la medición
    const fuera = "2026-12-07"; // 91 días
    expect(veredictoDeVerja("claude-fable-5", dentro).aplica).toBe(true);
    const v = veredictoDeVerja("claude-fable-5", fuera);
    expect(v.aplica).toBe(false);
    expect(v.motivo).toBe("medicion-caducada");
  });

  it("el umbral es un margen mínimo, no un signo: +1 % tampoco pasa", () => {
    // Comprobación de la regla, sin tocar la tabla real.
    expect(UMBRAL_APTITUD_PCT).toBeGreaterThan(1);
    const flojos = Object.entries(APTITUD_V0).filter(([, a]) => a.pct > 0 && a.pct < UMBRAL_APTITUD_PCT);
    for (const [modelo] of flojos) {
      expect(veredictoDeVerja(modelo, HOY).motivo).toBe("margen-insuficiente");
    }
  });
});

/**
 * La tabla es evidencia, no una lista de nombres: este repositorio ya se quemó
 * dos veces con cifras tecleadas sin fuente (el corpus a precio de Haiku;
 * PRIMA_1H/PRIMA_5M fuera del catálogo). Sin fecha y sin procedencia no entra.
 */
describe("verja por modelo · la tabla es auditable", () => {
  it("toda entrada lleva cifra, fecha ISO y una fuente que se puede abrir", () => {
    expect(Object.keys(APTITUD_V0).length).toBeGreaterThan(0);
    for (const [modelo, a] of Object.entries(APTITUD_V0)) {
      expect(Number.isFinite(a.pct), `${modelo}: pct no numérico`).toBe(true);
      expect(a.medidoEn, `${modelo}: fecha no ISO`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${a.medidoEn}T00:00:00Z`)), `${modelo}: fecha inválida`).toBe(false);
      expect(a.fuente.length, `${modelo}: sin procedencia`).toBeGreaterThan(20);
    }
  });

  it("la caducidad es real y generosa: ni desactiva sola en una semana ni vale para siempre", () => {
    expect(APTITUD_CADUCA_TRAS_DIAS).toBeGreaterThanOrEqual(30);
    expect(APTITUD_CADUCA_TRAS_DIAS).toBeLessThanOrEqual(365);
  });
});
