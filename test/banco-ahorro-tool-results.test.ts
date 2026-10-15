import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  BRAZOS,
  CONDICIONES,
  MODELOS,
  medirCuatroBrazos,
  vistaDe,
  type ArtefactoCuatroBrazos,
} from "../benchmarks/ahorro-tool-results/banco.js";
import { azarSembrado, corpus, FAMILIAS, generarLog } from "../benchmarks/ahorro-tool-results/corpus.js";
import { vistaPrevia } from "../src/compression/proyeccion-estable.js";

/**
 * D08 · el banco en seco de los cuatro brazos.
 *
 * Fija que el artefacto publicado es lo que calcula el código hoy (bit a bit),
 * y lo que el banco tiene que seguir enseñando: que la información sigue ahí
 * en los tres brazos ejecutados (oráculo del generador, no del lector), que
 * sin recuperar se pierden tareas, que cada original recuperado es el exacto,
 * que los ahorros negativos se publican y que P-D consta como no ejecutado.
 */

let a: ArtefactoCuatroBrazos;
beforeAll(async () => {
  a = await medirCuatroBrazos();
}, 120_000);

describe("la cifra publicada es la que calcula el código", () => {
  it("el artefacto de evidencia coincide con una tirada nueva, bit a bit", () => {
    const ruta = fileURLToPath(new URL("../benchmarks/evidencia/ahorro-tool-results-2026-10-15.json", import.meta.url));
    const publicado = JSON.parse(readFileSync(ruta, "utf8"));
    expect(publicado).toEqual(JSON.parse(JSON.stringify(a)));
  });

  it("el corpus es determinista y su hash está en el manifiesto", () => {
    expect(JSON.stringify(corpus(12, a.manifiesto.semilla))).toBe(JSON.stringify(corpus(12, a.manifiesto.semilla)));
    expect(a.manifiesto.casos).toBe(FAMILIAS.length * 12);
    expect(a.manifiesto.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("los brazos", () => {
  it("P-D consta y NO se ejecuta, con su motivo", () => {
    expect(a.brazos["P-D"].estado).toBe("no_ejecutado");
    expect(a.brazos["P-D"].motivo).toMatch(/third-party binaries/);
    for (const m of MODELOS) for (const cd of CONDICIONES) expect(Object.keys(a.resultados[m]![cd])).toEqual([...BRAZOS]);
  });

  it("la información sigue ahí: P-A, P-B y P-C resuelven todas las tareas del oráculo", () => {
    for (const b of BRAZOS) expect(a.calidad[b].correctas, b).toBe(a.calidad[b].total);
  });

  it("sin recuperar, P-C pierde tareas: las omisiones solo valen con recuperación", () => {
    expect(a.calidad["P-C"].correctasSinRecuperar!).toBeLessThan(a.calidad["P-C"].total);
    expect(a.calidad["P-C"].recuperaciones!).toBeGreaterThan(0);
  });

  it("cada original recuperado es el exacto (sha256 contra la fuente)", () => {
    expect(a.calidad["P-C"].recuperacionesExactas).toBe(a.calidad["P-C"].recuperaciones);
  });

  it("P-B (sin omisiones, función pura) nunca encarece una sesión", () => {
    for (const m of MODELOS) for (const cd of CONDICIONES) expect(a.resultados[m]![cd]["P-B"].casosConAhorroNegativo).toBe(0);
  });

  it("los ahorros negativos se publican: en no-op P-C sale más caro en todas las sesiones", () => {
    const noop = a.porFamilia["sesion-noop"]!["P-C"];
    for (const m of MODELOS) {
      for (const cd of CONDICIONES) {
        expect(noop.ahorroPctFrenteA[m]![cd]).toBeLessThan(0);
        expect(noop.casosConAhorroNegativo[m]![cd]).toBe(noop.total);
      }
    }
  });

  it("el sobrecoste de P-C está dentro de la cifra: schema en cada petición y rondas de recuperación", () => {
    const c = a.resultados["claude-sonnet-5"]!.frio["P-C"];
    expect(c.overhead.tokensEsquemaRecuperacion).toBeGreaterThan(0);
    expect(c.overhead.usdRondasRecuperacion).toBeGreaterThan(0);
    expect(c.overhead.usdRondasRecuperacion).toBeLessThan(c.usdEstimado);
    expect(a.resultados["claude-sonnet-5"]!.frio["P-A"].overhead.tokensEsquemaRecuperacion).toBe(0);
  });

  it("coste por tarea correcta: total de todas las peticiones entre tareas correctas", () => {
    for (const b of BRAZOS) {
      const r = a.resultados["claude-sonnet-5"]!.frio[b];
      expect(r.usdPorTareaCorrecta).toBeCloseTo(r.usdEstimado / a.calidad[b].correctas, 5);
    }
  });

  it("un JSON con clave duplicada nunca sale con omisiones (motivo duplicate_keys en B y en C)", () => {
    expect(a.motivos["P-B"]["identity:duplicate_keys"]).toBe(3);
    expect(a.motivos["P-C"]["identity:duplicate_keys"]).toBe(3);
  });

  it("el veredicto offline es «inconcluso» y lo dice el artefacto", () => {
    expect(a.veredicto.resultado).toBe("inconcluso");
    expect(a.advertencias.join("\n")).toMatch(/do NOT measure model quality/);
    expect(a.advertencias.join("\n")).toMatch(/budget/);
  });
});

describe("el lector del banco no se fía de la vista previa más de la cuenta", () => {
  it("con más marcadores de los que enseña la vista previa, los declara incompletos", () => {
    const v = generarLog(azarSembrado(7), { lineas: [800, 800], fallos: ["medio"], warnings: [30, 30] });
    const vista = vistaDe(vistaPrevia(v.texto, "bvr1_" + "A".repeat(32)));
    expect(vista.esVistaPrevia).toBe(true);
    expect(vista.marcadoresCompletos).toBe(false);
  });

  it("con pocos marcadores, todos los fallos del medio quedan a la vista", () => {
    const v = generarLog(azarSembrado(8), { lineas: [800, 800], fallos: ["medio", "inicio", "fin"], warnings: [0, 0], skipped: [0, 0] });
    const vista = vistaDe(vistaPrevia(v.texto, "bvr1_" + "A".repeat(32)));
    expect(vista.marcadoresCompletos).toBe(true);
    const vistos = [...new Set(vista.lineas.map((l) => /^FAIL\s+(\S+)/.exec(l)?.[1]).filter(Boolean))].sort();
    expect(vistos).toEqual(v.fallos);
  });
});
