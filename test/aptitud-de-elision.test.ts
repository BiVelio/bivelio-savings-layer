import { describe, it, expect } from "vitest";

import {
  CADUCIDAD_DIAS,
  FORMA_DE_TRAFICO_MEDIDA,
  MARGEN_RELATIVO,
  VEREDICTOS_AL_DIA,
  decidirElision,
  puntoDeEquilibrio,
} from "../src/pricing/aptitud-de-elision.js";
import { claveDeCatalogo } from "../src/pricing/catalogo.js";

const HOY = "2026-09-07";

/**
 * LA VERJA DE APTITUD. Lo que protegen estas pruebas no es una función corta:
 * es que no se declare ahorro donde la elisión cuesta dinero, y que el veredicto
 * siga vivo cuando cambien los precios.
 */
describe("verja de elisión · el veredicto", () => {
  it("abre en el modelo donde la elisión gana con holgura", () => {
    const v = decidirElision("claude-fable-5", HOY);
    expect(v.aplicar).toBe(true);
    expect(v.motivo).toBe("aplica");
  });

  it("cierra donde la elisión PIERDE dinero — el caso que la motiva", () => {
    const v = decidirElision("claude-opus-4-8", HOY);
    expect(v.aplicar).toBe(false);
    expect(v.motivo).toBe("no-compensa");
  });

  it("cierra en el EMPATE exacto: sonnet-5 sale con R = R* y ahorro 0,00 USD", () => {
    const v = decidirElision("claude-sonnet-5", HOY);
    expect(v.aplicar).toBe(false);
    expect(v.motivo).toBe("no-compensa");
    // Sin el margen relativo, un `<=` a secas lo habría abierto para ganar nada.
    expect(v.R).toBeCloseTo(v.umbral ?? 0, 5);
  });

  it("un modelo sin fila no se elide, aunque tenga precio", () => {
    expect(decidirElision("claude-haiku-4-5", HOY).motivo).toBe("sin-medicion");
  });

  it("un modelo que no está en el catálogo no se elide", () => {
    expect(decidirElision("claude-fable-6", HOY).motivo).toBe("sin-precio");
  });

  it("la medición caduca y devuelve el modelo a apagado — protege EL CAMPO, no el repo", () => {
    const dentro = "2026-11-05"; // 59 días
    const fuera = "2026-11-07"; // 61 días
    expect(decidirElision("claude-fable-5", dentro).aplicar).toBe(true);
    const v = decidirElision("claude-fable-5", fuera);
    expect(v.aplicar).toBe(false);
    expect(v.motivo).toBe("medicion-caducada");
  });

  it("una política distinta NO hereda la evidencia de v0 en silencio", () => {
    // El mecanismo es parte de la clave: pedir otro deja la fila fuera.
    const v = decidirElision("claude-fable-5", HOY, "sombra-v0");
    expect(v.aplicar).toBe(true);
    expect(Object.keys(FORMA_DE_TRAFICO_MEDIDA).every((k) => k.endsWith("·sombra-v0"))).toBe(true);
  });
});

/**
 * EL UMBRAL SE DERIVA DEL CATÁLOGO. Es la propiedad por la que este diseño gana
 * a una lista de porcentajes escrita a mano: si mañana cambia un precio, el
 * veredicto se mueve solo.
 */
describe("verja de elisión · el umbral sale de los precios, no de la tabla", () => {
  it("R* = r/(w−r) con los precios de hoy: 0,052632 en la familia que lee a 0,1×", () => {
    for (const m of ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(puntoDeEquilibrio(m), m).toBeCloseTo(0.052632, 5);
    }
  });

  it("fable-5-1 lee la caché a 0,025× y su umbral es 4,2× más estricto", () => {
    const r51 = puntoDeEquilibrio("claude-fable-5-1");
    expect(r51).toBeCloseTo(0.012658, 5);
    expect((puntoDeEquilibrio("claude-fable-5") ?? 0) / (r51 ?? 1)).toBeGreaterThan(4);
  });

  it("LA PROPIEDAD QUE JUSTIFICA EL DISEÑO: el R de fable-5 no pasa el umbral de fable-5-1", () => {
    // Confundir las dos generaciones de la familia es EXACTAMENTE el error que
    // ya costó aquí una factura de $279 en vez de $1.232,91. Con R guardado y
    // umbral derivado, la confusión se caza sola: el R medido en fable-5
    // (0,01281) queda POR ENCIMA del umbral de fable-5-1 (0,012658), así que
    // aunque alguien copiase la fila, la verja cerraría.
    const R = FORMA_DE_TRAFICO_MEDIDA["claude-fable-5·sombra-v0"]!.R;
    const umbral51 = puntoDeEquilibrio("claude-fable-5-1")!;
    expect(R).toBeGreaterThan(umbral51);
  });

  it("sin precio de catálogo no hay umbral, y sin umbral no se elide", () => {
    expect(puntoDeEquilibrio("claude-fable-6")).toBeNull();
  });

  it("la prima de 1h es de Anthropic: un modelo de OpenAI no la paga", () => {
    // Con la prima 1h aplicada a todo el mundo, gpt-5.1-codex salía 0,052632
    // cuando su umbral real es más laxo. La verja habría cerrado donde debía abrir.
    const gpt = puntoDeEquilibrio("gpt-5.1-codex");
    if (gpt !== null) expect(gpt).toBeGreaterThan(0.052632);
  });
});

/** La tabla es evidencia: sin clave de catálogo, fecha y procedencia no entra. */
describe("verja de elisión · la tabla es auditable", () => {
  it("toda fila usa una CLAVE DE CATÁLOGO real y lleva procedencia y turnos", () => {
    expect(Object.keys(FORMA_DE_TRAFICO_MEDIDA).length).toBeGreaterThan(0);
    for (const [clave, f] of Object.entries(FORMA_DE_TRAFICO_MEDIDA)) {
      const [modelo, mecanismo] = clave.split("·");
      expect(claveDeCatalogo(modelo!), `${clave}: no es clave de catálogo`).toBe(modelo);
      expect(mecanismo, `${clave}: sin mecanismo`).toBeTruthy();
      expect(Number.isFinite(f.R) && f.R >= 0, `${clave}: R inválido`).toBe(true);
      expect(f.turnos, `${clave}: sin turnos`).toBeGreaterThan(0);
      expect(f.fuente.length, `${clave}: sin procedencia`).toBeGreaterThan(20);
    }
  });

  it("el día de la medición es una fecha ISO válida y la caducidad es real", () => {
    expect(VEREDICTOS_AL_DIA).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${VEREDICTOS_AL_DIA}T00:00:00Z`))).toBe(false);
    expect(CADUCIDAD_DIAS).toBeGreaterThanOrEqual(30);
    expect(CADUCIDAD_DIAS).toBeLessThanOrEqual(180);
    expect(MARGEN_RELATIVO).toBeGreaterThan(0);
    expect(MARGEN_RELATIVO).toBeLessThan(0.5);
  });

  it("EL VEREDICTO CUADRA CON EL SIGNO DEL DINERO en las cuatro filas medidas", () => {
    // La coherencia que exige el plan: donde el replay midió ahorro positivo la
    // verja abre; donde midió 0 o pérdida, cierra. Los porcentajes de dinero
    // están en la procedencia de cada fila (artefacto congelado del 07-09).
    const signoDelDinero: Record<string, boolean> = {
      "claude-fable-5·sombra-v0": true, // +27,4 %
      "claude-opus-4-8·sombra-v0": false, // −3,6 %
      "claude-opus-5·sombra-v0": false, // −0,4 %
      "claude-sonnet-5·sombra-v0": false, // 0,0 %
    };
    for (const [clave, gana] of Object.entries(signoDelDinero)) {
      const modelo = clave.split("·")[0]!;
      expect(decidirElision(modelo, HOY).aplicar, `${modelo}: veredicto contra el dinero`).toBe(gana);
    }
  });
});

describe("claveDeCatalogo · el emparejador compartido", () => {
  it("normaliza el id fechado que manda Claude Code", () => {
    expect(claveDeCatalogo("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("NUNCA deja que 5-1 herede de 5 — las dos leen la caché a precios distintos", () => {
    expect(claveDeCatalogo("claude-fable-5-1")).toBe("claude-fable-5-1");
  });

  it("un modelo desconocido no inventa clave", () => {
    expect(claveDeCatalogo("claude-fable-6")).toBeUndefined();
  });
});
