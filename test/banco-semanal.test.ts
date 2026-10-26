import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extraerBfcl,
  extraerGsm8k,
  extraerMtBench,
  extraerXstest,
  MINIMO_COMPARABLE_TRAS_CUOTA,
  MINIMO_DE_TURNOS_JUZGADOS,
  type Medicion,
  type PreguntaCrudaMtBench,
} from "../benchmarks/banco-semanal/extraer.js";
import { esErrorDeCuota, esErrorNoMedibleDelProveedor, esSobrecargaDelProveedor } from "../benchmarks/publicados/cuota.js";
import { conReintentos } from "../benchmarks/publicados/gsm8k/arnes.js";
import { resumir as resumirGsm8k, type Ensayo } from "../benchmarks/publicados/gsm8k/medir.js";
import { resumenMarkdown } from "../benchmarks/banco-semanal/resumen.js";
import { claveQueFalta, filtrarCeldas, jornadaDelBanco, motivoDeAplazamiento, redactar, valoresSecretos } from "../benchmarks/banco-semanal/orquestador.js";
import {
  argumentosDe,
  BATERIAS,
  CajaGlobal,
  CUOTA_DIARIA,
  FRACCION_USABLE_DE_LA_CUOTA,
  jornadaPorDefecto,
  MARGEN_DE_CIERRE_MS,
  MODELOS_DEL_BANCO,
  peticionesMaximas,
  PLAZO_DE_CELDA_MS,
  PRESUPUESTO_SEMANAL_USD,
  planificar,
  reparto,
  TECHO_DE_CELDA_USD,
  TopeGlobalAgotado,
  SUBMUESTRA_POR_MODELO,
  submuestraDe,
  tocaEnLaJornada,
  validarPlan,
  type Celda,
} from "../benchmarks/banco-semanal/plan.js";
import { evaluarPuerta, leerRuns, MAX_DIAS, ultimoBancoEnVivo, type RunDelBanco } from "../benchmarks/banco-semanal/puerta.js";
import { soporte, type ListasDeLosArneses } from "../benchmarks/banco-semanal/soporte.js";
import { evaluar, fueraDeTolerancia, infraccionesDe, type ResultadoDeCelda } from "../benchmarks/banco-semanal/umbrales.js";

/**
 * EL BANCO SEMANAL, sin red y sin gastar: el reparto de los 50 $, la caja
 * global, los umbrales que hacen fallar el trabajo, la lectura de los
 * artefactos de cada arnés (con las tiradas publicadas de verdad), la puerta de
 * publish.yml y el propio YAML (como texto: no hay parser de YAML entre las
 * dependencias, igual que en test/cadena-de-suministro.test.ts).
 */

const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
const artefacto = (nombre: string): unknown => JSON.parse(leer(`../docs/benchmarks/2026-09-28/${nombre}`));
const modelo = (id: string) => MODELOS_DEL_BANCO.find((m) => m.id === id)!;

describe("banco semanal · el reparto de los 50 $", () => {
  const plan = planificar();
  const r = reparto(plan);

  it("diez modelos por cuatro baterías, los que decidió el dueño", () => {
    expect(MODELOS_DEL_BANCO.map((m) => m.corto).sort()).toEqual(
      [
        "claude-haiku-4-5",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "claude-sonnet-5-5",
        "gemini-3.1-pro-preview",
        "gemini-3.8-flash",
        "gpt-4o-mini",
        "gpt-5.4-mini",
        "gpt-5.5",
        "gpt-5.6-sol",
      ].sort(),
    );
    expect(plan).toHaveLength(40);
    expect(new Set(plan.map((c) => `${c.bateria}/${c.modelo.id}`)).size).toBe(40);
  });

  it("lo asignado cabe en los 50 $ con margen, y ninguna celda pasa del techo de los arneses", () => {
    expect(validarPlan(plan)).toEqual([]);
    expect(r.asignadoUsd).toBeCloseTo(44.2, 6);
    expect(r.margenUsd).toBeCloseTo(5.8, 6);
    expect(r.asignadoUsd).toBeLessThanOrEqual(PRESUPUESTO_SEMANAL_USD);
    for (const c of plan) {
      expect(c.topeUsd).toBeGreaterThan(0);
      expect(c.topeUsd).toBeLessThanOrEqual(TECHO_DE_CELDA_USD);
      expect(c.reservaUsd).toBeCloseTo(c.topeUsd + c.topeJuezUsd, 9);
    }
    // Por batería: 3 baratas × 0,75 + ... ; MT-Bench lleva además el juez (10 × 0,40).
    expect(r.porBateria.gsm8k).toBeCloseTo(4 * 0.75 + 3 * 1.1 + 3 * 1.25, 6);
    expect(r.porBateria["mt-bench"]).toBeCloseTo(r.porBateria.gsm8k + 4, 6);
    expect(r.juezUsd).toBeCloseTo(4, 6);
    expect(r.porModelo["openai/gpt-4o-mini"]).toBeCloseTo(4 * 0.75 + 0.4, 6);
    expect(r.porModelo["anthropic/claude-opus-5-5"]).toBeCloseTo(4 * 1.25 + 0.4, 6);
  });

  it("un plan que se pasa de los 50 $ o de una celda no se acepta", () => {
    const caro: Celda[] = plan.map((c) => ({ ...c, reservaUsd: 2 }));
    expect(validarPlan(caro).some((e) => /presupuesto semanal/.test(e))).toBe(true);
    const celdaEnorme: Celda[] = [{ ...plan[0]!, topeUsd: 1.3, reservaUsd: 1.3 }];
    expect(validarPlan(celdaEnorme).some((e) => /fuera de/.test(e))).toBe(true);
  });

  it("las caras miran una submuestra menor que las baratas", () => {
    const vivo = (b: string, id: string) => argumentosDe(plan.find((c) => c.bateria === b && c.modelo.id === id)!, "vivo", "/tmp/x", "abc123");
    expect(vivo("gsm8k", "openai/gpt-4o-mini")).toEqual(expect.arrayContaining(["--n-unicos", "100"]));
    expect(vivo("gsm8k", "openai/gpt-5.5")).toEqual(expect.arrayContaining(["--n-unicos", "40"]));
    expect(vivo("mt-bench", "anthropic/claude-opus-5-5")).toContain("--max-preguntas=16");
    expect(vivo("xstest", "openai/gpt-4o-mini").some((a) => a.startsWith("--n="))).toBe(false);
    expect(vivo("xstest", "anthropic/claude-opus-5-5")).toContain("--n=100");
    expect(vivo("bfcl", "openai/gpt-5.5")).toContain("--multi=0");
  });

  // Run 36771607171: XSTest · gemini-3.1-pro-preview («media», 200 ítems) agotó los
  // 75 min de la celda; runs 36786990486 y 36795672930: su cuota de 250 peticiones
  // al día. Su submuestra la fijan el reloj y la cuota, y todo XSTest para de
  // empezar ítems con margen antes del plazo de la celda.
  it("gemini-3.1-pro-preview mira su submuestra propia y todo XSTest lleva su plazo de cierre", () => {
    const vivo = (b: string, id: string) => argumentosDe(plan.find((c) => c.bateria === b && c.modelo.id === id)!, "vivo", "/tmp/x", "abc123");
    const pro = "google/gemini-3.1-pro-preview";
    expect(vivo("xstest", pro)).toContain("--n=24");
    expect(vivo("gsm8k", pro)).toEqual(expect.arrayContaining(["--n-unicos", "12"]));
    expect(vivo("mt-bench", pro)).toContain("--max-preguntas=16");
    expect(vivo("bfcl", pro)).toEqual(expect.arrayContaining(["--n=12", "--multi=2", "--repes=3"]));
    // Los demás «media» siguen con la submuestra de su gama.
    expect(vivo("xstest", "anthropic/claude-sonnet-5")).toContain("--n=200");
    expect(vivo("gsm8k", "anthropic/claude-sonnet-5")).toEqual(expect.arrayContaining(["--n-unicos", "60"]));
    const plazoMin = (PLAZO_DE_CELDA_MS - MARGEN_DE_CIERRE_MS) / 60_000;
    expect(plazoMin).toBe(60);
    for (const m of MODELOS_DEL_BANCO) expect(vivo("xstest", m.id)).toContain(`--plazo-min=${plazoMin}`);
    expect(validarPlan(plan)).toEqual([]);
    expect(Object.keys(SUBMUESTRA_POR_MODELO).every((id) => MODELOS_DEL_BANCO.some((m) => m.id === id))).toBe(true);
  });
});

describe("banco semanal · la cuota diaria de peticiones (runs 36786990486 y 36795672930)", () => {
  const plan = planificar();
  const pro = modelo("google/gemini-3.1-pro-preview");
  const celdaPro = (b: string) => plan.find((c) => c.bateria === b && c.modelo.id === pro.id)!;

  it("la cuenta del peor caso de cada arnés, con la submuestra de gemini-3.1-pro-preview", () => {
    // GSM8K: 3 de sonda + 2 × 12 únicos × 4 brazos. BFCL: 12 × 4 categorías × 2 + 3 × 2 + 2 × 12.
    expect(peticionesMaximas("gsm8k", pro)).toBe(3 + 2 * 12 * 4);
    expect(peticionesMaximas("bfcl", pro)).toBe(96 + 6 + 24);
    expect(peticionesMaximas("xstest", pro)).toBe(4 * 24);
    expect(peticionesMaximas("mt-bench", pro)).toBe(4 * 16);
    // Con las submuestras de su gama («media») no cabía ni con el banco solo para él.
    const gama = BATERIAS.reduce((t, b) => t + peticionesMaximas(b, { ...pro, id: "x/sin-submuestra-propia" }), 0);
    expect(gama).toBeGreaterThan(250);
    expect(submuestraDe({ ...pro, id: "x/sin-submuestra-propia" }).xstestN).toBe(200);
  });

  it("cada jornada cabe en el 80 % de la cuota, y entre todas cada batería va una vez", () => {
    const cuota = CUOTA_DIARIA[pro.id]!;
    expect(cuota.peticiones).toBe(250);
    expect(cuota.jornadas.flat().sort()).toEqual([...BATERIAS].sort());
    for (const js of cuota.jornadas) {
      const pide = js.reduce((t, b) => t + peticionesMaximas(b, pro), 0);
      expect(pide).toBeLessThanOrEqual(Math.floor(cuota.peticiones * FRACCION_USABLE_DE_LA_CUOTA));
    }
  });

  it("validarPlan rechaza una jornada que no cabe o un reparto que se deja una batería", () => {
    const cuota = CUOTA_DIARIA[pro.id]! as { peticiones: number; jornadas: readonly (readonly string[])[] };
    const original = cuota.jornadas;
    try {
      (cuota as { jornadas: unknown }).jornadas = [["bfcl", "mt-bench", "gsm8k", "xstest"]];
      expect(validarPlan(plan).some((e) => /jornada 1 .* pide hasta \d+ peticiones y caben 200 de 250/.test(e))).toBe(true);
      (cuota as { jornadas: unknown }).jornadas = [["bfcl"], ["gsm8k"]];
      expect(validarPlan(plan).some((e) => /no reparten cada batería exactamente una vez/.test(e))).toBe(true);
    } finally {
      (cuota as { jornadas: unknown }).jornadas = original;
    }
    expect(validarPlan(plan)).toEqual([]);
  });

  it("la jornada rota cada semana; --jornada la elige (desde 1) y rechaza lo que no existe", () => {
    const cuota = CUOTA_DIARIA[pro.id]!;
    const lunes = new Date("2026-10-05T04:17:00Z");
    const otroLunes = new Date("2026-10-12T04:17:00Z");
    expect(jornadaPorDefecto(cuota, lunes)).not.toBe(jornadaPorDefecto(cuota, otroLunes));
    expect(jornadaDelBanco(undefined, lunes)).toBe(jornadaPorDefecto(cuota, lunes));
    expect(jornadaDelBanco("", lunes)).toBe(jornadaPorDefecto(cuota, lunes));
    expect(jornadaDelBanco("2", lunes)).toBe(1);
    expect(() => jornadaDelBanco("3", lunes)).toThrow(/no es una jornada/);
    expect(() => jornadaDelBanco("uno", lunes)).toThrow(/no es una jornada/);
  });

  it("en vivo, la batería de otra jornada no se lanza y dice cuál es la suya; en seco y para los demás modelos, todo se lanza", () => {
    expect(tocaEnLaJornada(celdaPro("bfcl"), 0)).toBe(true);
    expect(tocaEnLaJornada(celdaPro("gsm8k"), 0)).toBe(false);
    expect(motivoDeAplazamiento(celdaPro("bfcl"), 0, "vivo")).toBeNull();
    const m = motivoDeAplazamiento(celdaPro("xstest"), 0, "vivo");
    expect(m).toMatch(/250 peticiones al día/);
    expect(m).toMatch(/--jornada 2/);
    expect(motivoDeAplazamiento(celdaPro("xstest"), 0, "seco")).toBeNull();
    const flash = plan.find((c) => c.bateria === "xstest" && c.modelo.id === "google/gemini-3.8-flash")!;
    expect(motivoDeAplazamiento(flash, 0, "vivo")).toBeNull();
  });

  it("una celda aplazada es un aviso, no cuenta como intentada, y no tapa una batería sin medir", () => {
    const aplazada: ResultadoDeCelda = { bateria: "xstest", modelo: pro.id, estado: "aplazada-por-cuota", motivo: "jornada 2" };
    const v = evaluar([aplazada], null);
    expect(v.ok).toBe(true);
    expect(v.avisos.some((a) => /aplazada por cuota diaria/.test(a))).toBe(true);
    // Si lo que sí tocaba no se pudo medir, la batería sigue cayendo.
    const sinClave: ResultadoDeCelda = { bateria: "bfcl", modelo: pro.id, estado: "sin-clave", motivo: "sin clave" };
    expect(evaluar([aplazada, sinClave], null).infracciones.map((i) => i.regla)).toEqual(["bateria-sin-medir"]);
  });
});

describe("banco semanal · los argumentos de cada arnés", () => {
  const plan = planificar();
  const celda = (b: string, id = "openai/gpt-4o-mini") => plan.find((c) => c.bateria === b && c.modelo.id === id)!;

  it("en vivo: el fuente de main y el tope de la celda, que el arnés solo puede bajar", () => {
    expect(argumentosDe(celda("gsm8k"), "vivo", "/d", "r")).toEqual([
      "benchmarks/publicados/gsm8k/arnes.ts",
      "--desde-fuente",
      "--modelos",
      "openai/gpt-4o-mini",
      "--n-unicos",
      "100",
      "--presupuesto",
      "0.75",
    ]);
    const bfcl = argumentosDe(celda("bfcl"), "vivo", "/d", "r");
    expect(bfcl).toEqual(expect.arrayContaining(["--fuente-de-main", "--tope=0.75", "--salida=/d", "--comparar=", "--semilla=20260928"]));
    expect(bfcl).not.toContain("--mock");
    const xs = argumentosDe(celda("xstest"), "vivo", "/d", "r");
    expect(xs).toEqual(expect.arrayContaining(["--fuente-de-main", "--vivo", "--modelos=gpt-4o-mini", "--tope=0.75", "--salida=/d"]));
    const mt = argumentosDe(celda("mt-bench"), "vivo", "/d", "r");
    expect(mt).toEqual(expect.arrayContaining(["--fuente-de-main", "--tope=0.75", "--tope-juez=0.40", "--sufijo=bs-r-gpt-4o-mini", "--salida=/d"]));
    expect(mt).not.toContain("--mock");
  });

  it("en seco: ningún arnés sale a un proveedor", () => {
    for (const b of BATERIAS) {
      const a = argumentosDe(celda(b), "seco", "/d", "r");
      expect(a).not.toContain("--vivo");
      expect(a).not.toContain("--desde-fuente");
    }
    expect(argumentosDe(celda("gsm8k"), "seco", "/d", "r")).toContain("--seco");
    expect(argumentosDe(celda("bfcl"), "seco", "/d", "r")).toContain("--mock");
    expect(argumentosDe(celda("mt-bench"), "seco", "/d", "r")).toContain("--mock");
  });

  it("--modelos y --baterias filtran, y rechazan lo que no existe", () => {
    const plan = planificar();
    expect(filtrarCeldas(plan, "gpt-4o-mini,anthropic/claude-sonnet-5", "bfcl")).toHaveLength(2);
    expect(() => filtrarCeldas(plan, "gpt-3")).toThrow(/no es un modelo del banco/);
    expect(() => filtrarCeldas(plan, undefined, "mmlu")).toThrow(/no es una batería/);
  });
});

describe("banco semanal · la caja global", () => {
  it("reserva el tope entero antes de lanzar, y aborta lo que no cabe", () => {
    const caja = new CajaGlobal(3);
    caja.reservar(1.25, "a");
    caja.reservar(1.25, "b");
    expect(() => caja.reservar(1.25, "c")).toThrow(TopeGlobalAgotado);
    // Una vez abortada, nada más se lanza aunque se libere dinero.
    caja.liquidar(1.25, 0.1, "a");
    expect(() => caja.reservar(0.01, "d")).toThrow(TopeGlobalAgotado);
    expect(caja.motivoDelAborto).toMatch(/c reservaría 1\.25/);
  });

  it("una celda sin artefacto se cuenta ENTERA; lo gastado de verdad libera el resto", () => {
    const caja = new CajaGlobal(2);
    caja.reservar(1, "a");
    caja.liquidar(1, null, "a");
    expect(caja.gastado).toBe(1);
    caja.reservar(1, "b");
    caja.liquidar(1, 0.25, "b");
    expect(caja.gastado).toBe(1.25);
    expect(caja.reservado).toBe(0);
    caja.reservar(0.75, "c");
    expect(caja.motivoDelAborto).toBeNull();
  });

  it("un gasto por encima de la reserva no se esconde y aborta el resto", () => {
    const caja = new CajaGlobal(50);
    caja.reservar(0.75, "a");
    caja.liquidar(0.75, 0.9, "a");
    expect(caja.gastado).toBeCloseTo(0.9, 9);
    expect(caja.motivoDelAborto).toMatch(/gastó 0\.9000 \$ con una reserva de 0\.75/);
    expect(() => caja.reservar(0.1, "b")).toThrow(TopeGlobalAgotado);
  });

  it("el plan entero cabe en la caja aunque todas las celdas gasten su tope", () => {
    const caja = new CajaGlobal();
    for (const c of planificar()) caja.reservar(c.reservaUsd, c.bateria);
    expect(caja.motivoDelAborto).toBeNull();
    expect(caja.reservado).toBeCloseTo(44.2, 6);
  });
});

describe("banco semanal · qué sabe medir cada arnés", () => {
  const listas: ListasDeLosArneses = {
    hostsGsm8k: ["api.openai.com", "api.anthropic.com"],
    hostsBfcl: ["api.anthropic.com", "api.openai.com"],
    modelosXstest: ["gpt-4o-mini"],
    modelosMtBench: ["claude-haiku-4-5"],
  };
  it("con las listas del propio arnés: sin soporte no se lanza, y se dice por qué", () => {
    expect(soporte("gsm8k", modelo("openai/gpt-5.5"), listas).ok).toBe(true);
    expect(soporte("gsm8k", modelo("google/gemini-3.8-flash"), listas)).toEqual({ ok: false, motivo: expect.stringMatching(/generativelanguage/) });
    expect(soporte("bfcl", modelo("google/gemini-3.1-pro-preview"), listas).ok).toBe(false);
    expect(soporte("xstest", modelo("openai/gpt-4o-mini"), listas).ok).toBe(true);
    expect(soporte("xstest", modelo("openai/gpt-5.5"), listas).ok).toBe(false);
    expect(soporte("mt-bench", modelo("anthropic/claude-haiku-4-5"), listas).ok).toBe(true);
  });
  it("las listas de verdad salen de los arneses (y el día que aprendan un modelo, el banco lo mide)", () => {
    expect(soporte("xstest", modelo("openai/gpt-4o-mini")).ok).toBe(true);
    expect(soporte("mt-bench", modelo("anthropic/claude-sonnet-5")).ok).toBe(true);
  });
  it("hoy los cuatro arneses miden las cuarenta celdas: Gemini en BFCL y MT-Bench, y la gama alta en MT-Bench (run 36611942632)", () => {
    const sin = planificar().filter((c) => !soporte(c.bateria, c.modelo).ok).map((c) => `${c.bateria}/${c.modelo.id}`);
    expect(sin).toEqual([]);
    for (const id of ["openai/gpt-5.5", "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "google/gemini-3.8-flash", "google/gemini-3.1-pro-preview"]) {
      expect(soporte("mt-bench", modelo(id))).toEqual({ ok: true });
    }
    expect(soporte("bfcl", modelo("google/gemini-3.1-pro-preview"))).toEqual({ ok: true });
  });
});

function medicionLimpia(extra: Partial<Medicion> = {}): Medicion {
  return {
    bateria: "gsm8k",
    modelo: "openai/gpt-4o-mini",
    estado: "medido",
    gastoUsd: 0.5,
    n: 100,
    cortadaPorTope: false,
    respuestasDeOtraPregunta: 0,
    fallosDeLaCapa: 0,
    ejemplosDeFallos: [],
    exactitud: [{ brazo: "B", metrica: "exactitud", valor: -0.01, ic95: { point: -0.01, lower: -0.05, upper: 0 }, peorSignificativo: false }],
    informeVsFactura: [{ brazo: "B", informeUsd: 0.2, facturaUsd: 0.2, llamadas: 100 }],
    ...extra,
  };
}

describe("banco semanal · los umbrales", () => {
  it("una medición limpia no infringe nada (un IC que toca el 0 no es significativo)", () => {
    expect(infraccionesDe(medicionLimpia(), 0.75)).toEqual([]);
  });

  it.each([
    ["otra-pregunta", { respuestasDeOtraPregunta: 1 }],
    ["llamada-cambiada", { bateria: "bfcl" as const, llamadasCambiadas: 1 }],
    ["negativa-cacheada", { bateria: "xstest" as const, negativasCacheadas: 1 }],
    ["negativa-acreditada", { bateria: "xstest" as const, negativasAcreditadas: 1 }],
    ["capa-falla", { fallosDeLaCapa: 1, ejemplosDeFallos: ["B pos 3: TypeError"] }],
    [
      "exactitud-peor",
      { exactitud: [{ brazo: "B", metrica: "exactitud", valor: -0.05, ic95: { point: -0.05, lower: -0.09, upper: -0.01 }, peorSignificativo: true }] },
    ],
    ["informe-vs-factura", { informeVsFactura: [{ brazo: "B", informeUsd: 0.1, facturaUsd: 0.2, llamadas: 10 }] }],
    ["tope-excedido", { gastoUsd: 0.77 }],
  ])("%s: una sola vez basta para fallar", (regla, extra) => {
    const inf = infraccionesDe(medicionLimpia(extra as Partial<Medicion>), 0.75);
    expect(inf.map((i) => i.regla)).toEqual([regla]);
  });

  it("informe vs factura: ±2 % relativo, con 0,0001 $ de holgura absoluta", () => {
    expect(fueraDeTolerancia(1.02, 1)).toBe(false);
    expect(fueraDeTolerancia(0.98, 1)).toBe(false);
    expect(fueraDeTolerancia(1.0201, 1)).toBe(true);
    expect(fueraDeTolerancia(0.9799, 1)).toBe(true);
    expect(fueraDeTolerancia(0.00005, 0)).toBe(false);
    expect(fueraDeTolerancia(0.0002, 0)).toBe(true);
  });

  it("un modelo no medible no infringe calidad, pero sí el tope si lo pasó", () => {
    const nm = medicionLimpia({ estado: "no-medible", respuestasDeOtraPregunta: 3, motivo: "clave inválida" });
    expect(infraccionesDe(nm, 0.75)).toEqual([]);
    expect(infraccionesDe({ ...nm, gastoUsd: 1 }, 0.75).map((i) => i.regla)).toEqual(["tope-excedido"]);
  });

  it("evaluar: sin soporte y no medible avisan; arnés caído, tope global y batería vacía fallan", () => {
    const medida = (bateria: ResultadoDeCelda["bateria"], m: Partial<Medicion> = {}): ResultadoDeCelda => ({
      bateria,
      modelo: "openai/gpt-4o-mini",
      estado: "medida",
      topeUsd: 0.75,
      medicion: medicionLimpia({ bateria, ...m }),
    });
    const limpio = evaluar(
      [
        medida("gsm8k"),
        { bateria: "gsm8k", modelo: "google/gemini-3.8-flash", estado: "sin-soporte", motivo: "verja" },
        medida("bfcl"),
        medida("bfcl", { estado: "no-medible", motivo: "401" }),
      ],
      null,
    );
    expect(limpio.ok).toBe(true);
    expect(limpio.avisos.join("\n")).toMatch(/sin soporte[\s\S]*no medible — 401/);

    const caido = evaluar([medida("gsm8k"), { bateria: "xstest", modelo: "x", estado: "arnes-falla", motivo: "exit 1", topeUsd: 0.75 }], null);
    expect(caido.infracciones.map((i) => i.regla).sort()).toEqual(["arnes-falla", "bateria-sin-medir"]);

    const vacia = evaluar([medida("mt-bench", { estado: "no-medible", motivo: "401" })], null);
    expect(vacia.ok).toBe(false);
    expect(vacia.infracciones[0]!.regla).toBe("bateria-sin-medir");

    const abortado = evaluar([medida("gsm8k"), { bateria: "bfcl", modelo: "y", estado: "omitida-por-tope-global", motivo: "tope" }], "tope global: …");
    expect(abortado.infracciones.map((i) => i.regla)).toContain("tope-global");

    // Una batería entera sin soporte no es «sin medir»: no se intentó.
    expect(evaluar([medida("gsm8k"), { bateria: "bfcl", modelo: "g", estado: "sin-soporte", motivo: "m" }], null).ok).toBe(true);
  });

  it("sin la clave de su proveedor, la celda es «no medible» (aviso), no un arnés caído — la tirada del 2026-09-29", () => {
    // Lo que pasó: XSTest con Gemini y sin GEMINI_API_KEY salió con 1 sin artefacto
    // y tumbó el banco como `arnes-falla`, aunque la capa no falló en ninguna celda.
    const sinClave = (bateria: ResultadoDeCelda["bateria"], modelo: string): ResultadoDeCelda => ({
      bateria,
      modelo,
      estado: "sin-clave",
      motivo: "sin BVSALA_DEMO_GOOGLE_API_KEY en el entorno",
    });
    const medidaXs: ResultadoDeCelda = {
      bateria: "xstest",
      modelo: "openai/gpt-4o-mini",
      estado: "medida",
      topeUsd: 0.75,
      medicion: medicionLimpia({ bateria: "xstest" }),
    };
    const v = evaluar([medidaXs, sinClave("xstest", "google/gemini-3.8-flash"), sinClave("xstest", "google/gemini-3.1-pro-preview")], null);
    expect(v.ok).toBe(true);
    expect(v.avisos.join("\n")).toMatch(/xstest · google\/gemini-3\.8-flash: no medible — sin BVSALA_DEMO_GOOGLE_API_KEY/);
    // Cuenta como intentada: una batería que se queda entera sin claves sigue fallando.
    expect(evaluar([sinClave("bfcl", "google/gemini-3.8-flash")], null).infracciones.map((i) => i.regla)).toEqual(["bateria-sin-medir"]);
  });

  it("claveQueFalta decide con el mismo enrutado que los arneses, y solo en vivo", () => {
    const gemini = MODELOS_DEL_BANCO.find((m) => m.familia === "google")!;
    const gpt = MODELOS_DEL_BANCO.find((m) => m.familia === "openai")!;
    const claude = MODELOS_DEL_BANCO.find((m) => m.familia === "anthropic")!;
    // El entorno del workflow, con el secreto de Google sin dar de alta (llega vacío).
    const workflow = {
      BVSALA_DEMO_ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
      BVSALA_DEMO_OPENAI_BASE_URL: "https://api.openai.com/v1",
      BVSALA_DEMO_BASE_URL: "https://api.openai.com/v1",
      BVSALA_DEMO_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
      BVSALA_DEMO_ANTHROPIC_API_KEY: "x".repeat(20),
      BVSALA_DEMO_OPENAI_API_KEY: "y".repeat(20),
      BVSALA_DEMO_API_KEY: "y".repeat(20),
      BVSALA_DEMO_GOOGLE_API_KEY: "",
    };
    expect(claveQueFalta(gemini, "vivo", workflow)).toBe("BVSALA_DEMO_GOOGLE_API_KEY");
    expect(claveQueFalta(gpt, "vivo", workflow)).toBeNull();
    expect(claveQueFalta(claude, "vivo", workflow)).toBeNull();
    // En seco no hay claves y no hacen falta.
    expect(claveQueFalta(gemini, "seco", {})).toBeNull();
    // Sin endpoint directo de su familia, el modelo sale por la pasarela: manda SU clave.
    const pasarela = { BVSALA_DEMO_BASE_URL: "https://ai-gateway.example/v1" };
    expect(claveQueFalta(gemini, "vivo", pasarela)).toBe("BVSALA_DEMO_API_KEY");
    expect(claveQueFalta(gemini, "vivo", { ...pasarela, BVSALA_DEMO_API_KEY: "z".repeat(20) })).toBeNull();
  });
});

describe("banco semanal · la lectura de los artefactos (tiradas publicadas de verdad)", () => {
  it("GSM8K 0.4.31: gpt-4o-mini limpio, Claude no medible (clave rechazada aquel día)", () => {
    const art = artefacto("gsm8k-0431.json");
    const m = extraerGsm8k(art, modelo("openai/gpt-4o-mini"));
    expect(m.estado).toBe("medido");
    expect(m.respuestasDeOtraPregunta).toBe(0);
    expect(m.fallosDeLaCapa).toBe(0);
    expect(m.exactitud.map((e) => e.brazo).sort()).toEqual(["B", "E", "S"]);
    expect(m.informeVsFactura.every((f) => f.llamadas > 0 && !fueraDeTolerancia(f.informeUsd, f.facturaUsd))).toBe(true);
    expect(infraccionesDe(m, 0.8)).toEqual([]);
    expect(extraerGsm8k(art, modelo("anthropic/claude-haiku-4-5")).estado).toBe("no-medible");
  });

  it("BFCL 0.4.31: la capa no cambió ninguna llamada, y el informe cuadra con la factura", () => {
    const m = extraerBfcl(artefacto("bfcl-0431.json"), modelo("openai/gpt-5.4-mini"));
    expect(m).toMatchObject({ estado: "medido", n: 400, llamadasCambiadas: 0, fallosDeLaCapa: 0 });
    expect(infraccionesDe(m, 0.8)).toEqual([]);
    expect(extraerBfcl(artefacto("bfcl-0431.json"), modelo("anthropic/claude-sonnet-5")).estado).toBe("no-medible");
  });

  it("XSTest 0.4.31: el banco habría cazado las negativas cacheadas y acreditadas que corrigió la 0.4.32", () => {
    const m = extraerXstest(artefacto("xstest-0431.json"), modelo("openai/gpt-4o-mini"));
    expect(m.estado).toBe("medido");
    expect(m.negativasCacheadas).toBeGreaterThan(0);
    expect(m.negativasAcreditadas).toBeGreaterThan(0);
    const reglas = infraccionesDe(m, 0.8).map((i) => i.regla);
    expect(reglas).toEqual(expect.arrayContaining(["negativa-cacheada", "negativa-acreditada"]));
    expect(reglas).not.toContain("exactitud-peor");
    expect(reglas).not.toContain("informe-vs-factura");
  });

  it("MT-Bench 0.4.31 con Claude: juzgado, sin fallos de la capa, informe = factura", () => {
    const m = extraerMtBench(artefacto("mt-bench-0431-claude.json"), modelo("anthropic/claude-sonnet-5"));
    expect(m).toMatchObject({ estado: "medido", fallosDeLaCapa: 0, cortadaPorTope: true });
    expect(m.exactitud[0]!.ic95!.upper).toBeGreaterThan(0.5);
    expect(infraccionesDe(m, 1.25 + 0.5)).toEqual([]);
  });

  it("MT-Bench: un juez cortado tras UN turno no es un empate — sin tasa de victoria, y se avisa (run 36611942632)", () => {
    // La forma exacta de las cuatro celdas medidas aquel día: 1 turno juzgado, 3
    // llamadas al juez, corte por su tope y una tasa degenerada [0,5, 0,5].
    const art = JSON.parse(JSON.stringify(artefacto("mt-bench-0431-claude.json"))) as { modelos: Record<string, unknown>[] };
    const fila = art.modelos.find((x) => x["modelo"] === "claude-sonnet-5")!;
    fila["calidad"] = {
      ...(fila["calidad"] as Record<string, unknown>),
      juzgada: true,
      turnosJuzgados: 1,
      victoriasB: 0,
      victoriasA: 0,
      empates: 1,
      inconsistentes: 1,
      turnosSinPresupuesto: 1,
      tasaDeVictoriaB: { point: 0.5, lower: 0.5, upper: 0.5 },
      llamadasAlJuez: 3,
      preguntasJuzgadas: 1,
      cortePorPresupuesto: true,
    };
    const m = extraerMtBench(art, modelo("anthropic/claude-sonnet-5"));
    expect(m.estado).toBe("medido");
    expect(m.exactitud).toEqual([]);
    expect(m.calidadSinMedir).toMatch(/1 turno \(mínimo 8\), cortado por su tope/);
    const celda: ResultadoDeCelda = { bateria: "mt-bench", modelo: "anthropic/claude-sonnet-5", estado: "medida", topeUsd: 1.5, medicion: m };
    const v = evaluar([celda], null);
    expect(v.avisos.some((a) => /calidad sin medir/.test(a))).toBe(true);
    const md = resumenMarkdown({ modo: "vivo", commit: "c", version: "v", inicio: "i", fin: "f", gastoUsd: 1, reparto: reparto(), resultados: [celda], veredicto: v });
    expect(md).toMatch(/calidad sin medir/);
    expect(md).not.toMatch(/victoria de B 0\.500 \[0\.500, 0\.500\]/);
    // Con los turnos suficientes, la tasa vuelve.
    (fila["calidad"] as Record<string, unknown>)["turnosJuzgados"] = MINIMO_DE_TURNOS_JUZGADOS;
    const bien = extraerMtBench(art, modelo("anthropic/claude-sonnet-5"));
    expect(bien.calidadSinMedir).toBeUndefined();
    expect(bien.exactitud).toHaveLength(1);
  });

  it("MT-Bench: con las respuestas crudas, un error solo de B es de la capa; uno de A, no", () => {
    const art = artefacto("mt-bench-0431-claude.json");
    const crudo = [
      {
        modelo: "claude-haiku-4-5",
        preguntas: [
          { id: 81, error: "brazo A claude-haiku-4-5: HTTP 529" },
          { id: 82, error: "TypeError: cannot read properties of undefined" },
          { id: 83, error: "presupuesto agotado" },
          { id: 84 },
        ],
      },
    ];
    const m = extraerMtBench(art, modelo("anthropic/claude-haiku-4-5"), crudo);
    expect(m.fallosDeLaCapa).toBe(1);
    expect(m.ejemplosDeFallos[0]).toMatch(/pregunta 82/);
  });

  describe("MT-Bench: la calidad solo culpa a la capa si la capa cambió algo (run 36748284158)", () => {
    // La celda real: victoria de B 0,385 [0,308, 0,442] con el cable de B igual
    // al de A salvo `prompt_cache_key` (40 turnos), caché todo `miss`, 0 $
    // declarados y el mismo modelo servido. La tirada anterior dio 0,500.
    type Fila = Record<string, Record<string, unknown>>;
    const real = () => JSON.parse(leer("fixtures/banco-semanal-mt-bench-gpt-4o-mini-36748284158.json")) as { modelos: Fila[] };
    const gpt = modelo("openai/gpt-4o-mini");
    const celda = (m: Medicion): ResultadoDeCelda => ({ bateria: "mt-bench", modelo: gpt.id, estado: "medida", topeUsd: 1.15, medicion: m });

    it("la celda real de gpt-4o-mini: sin intervención, la calidad peor es un aviso de muestreo, no un fallo", () => {
      const m = extraerMtBench(real(), gpt);
      expect(m.exactitud[0]).toMatchObject({ peorSignificativo: true });
      expect(m.exactitud[0]!.ic95!.upper).toBeCloseTo(0.442, 3);
      expect(m.sinIntervencion).toEqual({ camposNeutros: { prompt_cache_key: 40 } });
      expect(infraccionesDe(m, 1.15)).toEqual([]);
      const v = evaluar([celda(m)], null);
      expect(v.ok).toBe(true);
      const aviso = v.avisos.find((a) => /atribuible al muestreo/.test(a));
      expect(aviso).toMatch(/calidad B−A atribuible al muestreo: la capa no cambió nada que altere la generación \(solo `prompt_cache_key` ×40/);
      expect(aviso).toMatch(/IC95 \[0\.308, 0\.442\]/);
    });

    it.each([
      ["una diferencia de `messages`", (f: Fila) => (f["cable"]!["diferencias"] = { prompt_cache_key: 40, messages: 1 })],
      ["una diferencia de `max_tokens`", (f: Fila) => (f["cable"]!["diferencias"] = { prompt_cache_key: 39, max_tokens: 1 })],
      ["una llamada evitada por la caché", (f: Fila) => (f["capa"]!["cacheResult"] = { miss: 79, hit: 1 })],
      ["un turno de B que no llegó al cable", (f: Fila) => (f["cable"]!["turnos"] = 79)],
      ["una llamada extra al proveedor", (f: Fila) => (f["capa"]!["llamadasExtraAlProveedor"] = 1)],
      ["otro modelo servido en B", (f: Fila) => (f["cable"]!["modelosServidosB"] = ["gpt-4o-mini-2024-07-18", "gpt-4o-2024-08-06"])],
      ["un artefacto sin el cable", (f: Fila) => delete (f as Record<string, unknown>)["cable"]],
    ])("la misma celda con %s: la capa intervino (o no se sabe) y exactitud-peor sigue fallando", (_, cambio) => {
      const art = real();
      cambio(art.modelos[0]!);
      const m = extraerMtBench(art, gpt);
      expect(m.sinIntervencion).toBeUndefined();
      expect(infraccionesDe(m, 1.15).map((i) => i.regla)).toEqual(["exactitud-peor"]);
      const v = evaluar([celda(m)], null);
      expect(v.ok).toBe(false);
      expect(v.avisos.some((a) => /atribuible al muestreo/.test(a))).toBe(false);
    });

    it("marcas `cache_control` que solo cambian eso también son neutras; una calidad sin empeorar no avisa de nada", () => {
      const art = real();
      art.modelos[0]!["cable"]!["diferencias"] = { "messages:cache_control": 40 };
      const m = extraerMtBench(art, gpt);
      expect(m.sinIntervencion).toEqual({ camposNeutros: { "messages:cache_control": 40 } });
      expect(infraccionesDe(m, 1.15)).toEqual([]);
      art.modelos[0]!["calidad"]!["tasaDeVictoriaB"] = { point: 0.5, lower: 0.423, upper: 0.577 };
      expect(evaluar([celda(extraerMtBench(art, gpt))], null).avisos.some((a) => /muestreo/.test(a))).toBe(false);
    });

    it("las celdas de la 0.4.31: Claude con solo marcas es «sin intervención»; sonnet-5-5 con un `messages` distinto, no", () => {
      expect(extraerMtBench(artefacto("mt-bench-0431-claude.json"), modelo("anthropic/claude-haiku-4-5")).sinIntervencion).toBeDefined();
      expect(extraerMtBench(artefacto("mt-bench-0431-gama-alta.json"), modelo("anthropic/claude-sonnet-5-5")).sinIntervencion).toBeUndefined();
    });
  });

  describe("BFCL: la exactitud AST solo culpa a la capa si la capa cambió algo (runs 36634001923, 36748284158, 36771607171)", () => {
    // La celda real de gpt-5.4-mini: B − A −0,040 [−0,080, −0,010] con el cable de
    // B idéntico al de A en las 100 entradas, caché todo `miss`, 0 llamadas
    // cambiadas. Aquel artefacto no traía el modelo servido; el arnés ya lo guarda
    // (`modelosServidos`) y aquí se le añade como lo escribiría hoy. En vivo
    // (2026-10-01, 7 preguntas discordantes × 20 repeticiones por brazo) el cuerpo
    // de B salió byte a byte igual que el de A 140/140 y acertó 95/140 frente a
    // 96/140: las mismas preguntas fallan en los dos brazos.
    type Brazo = Record<string, unknown>;
    type Art = { modelos: { ast: { id: string; A: Brazo; B: Brazo & { informe: Brazo } }[] }[] };
    const SERVIDO = "gpt-5.4-mini";
    const real = () => JSON.parse(leer("fixtures/banco-semanal-bfcl-gpt-5.4-mini-36771607171.json")) as Art;
    const conServido = (art: Art) => {
      for (const e of art.modelos[0]!.ast) {
        e.A["modelosServidos"] = [SERVIDO];
        e.B["modelosServidos"] = [SERVIDO];
      }
      return art;
    };
    const gpt = modelo("openai/gpt-5.4-mini");
    const celda = (m: Medicion): ResultadoDeCelda => ({ bateria: "bfcl", modelo: gpt.id, estado: "medida", topeUsd: 0.75, medicion: m });

    it("el artefacto tal cual (sin modelo servido): no se puede demostrar, y exactitud-peor sigue fallando", () => {
      const m = extraerBfcl(real(), gpt);
      expect(m.exactitud[0]).toMatchObject({ peorSignificativo: true, valor: -0.04 });
      expect(m.sinIntervencion).toBeUndefined();
      expect(infraccionesDe(m, 0.75).map((i) => i.regla)).toEqual(["exactitud-peor"]);
    });

    it("con el modelo servido igual en A y B: sin intervención, la calidad peor es un aviso de muestreo, no un fallo", () => {
      const m = extraerBfcl(conServido(real()), gpt);
      expect(m).toMatchObject({ estado: "medido", n: 100, llamadasCambiadas: 0, fallosDeLaCapa: 0 });
      expect(m.sinIntervencion).toEqual({ camposNeutros: {} });
      expect(infraccionesDe(m, 0.75)).toEqual([]);
      const v = evaluar([celda(m)], null);
      expect(v.ok).toBe(true);
      expect(v.avisos.find((a) => /atribuible al muestreo/.test(a))).toMatch(/cable idéntico.*IC95 \[-0\.080, -0\.010\]/);
    });

    it("`prompt_cache_key` y las marcas `cache_control` son neutras: se cuentan y no cuentan como intervención", () => {
      const art = conServido(real());
      art.modelos[0]!.ast[0]!.B["diferenciasDelCable"] = ['prompt_cache_key: A=undefined B="bsl-1"'];
      art.modelos[0]!.ast[1]!.B["marcasDeCache"] = 2;
      expect(extraerBfcl(art, gpt).sinIntervencion).toEqual({ camposNeutros: { prompt_cache_key: 1, "cuerpo:cache_control": 1 } });
    });

    it.each([
      ["una herramienta con otro esquema", (a: Art) => (a.modelos[0]!.ast[3]!.B["diferenciasDelCable"] = ["tools[f]: A={…} B={…}"])],
      ["las herramientas en otro orden", (a: Art) => (a.modelos[0]!.ast[3]!.B["diferenciasDelCable"] = ["tools: order differs (A=f,g B=g,f)"])],
      ["un mensaje distinto", (a: Art) => (a.modelos[0]!.ast[3]!.B["diferenciasDelCable"] = ["messages[0]: A={…} B={…}"])],
      ["un `reasoning_effort` que A no manda", (a: Art) => (a.modelos[0]!.ast[3]!.B["diferenciasDelCable"] = ['reasoning_effort: A=undefined B="low"'])],
      ["una `temperature` distinta", (a: Art) => (a.modelos[0]!.ast[3]!.B["diferenciasDelCable"] = ["temperature: A=undefined B=0"])],
      ["una llamada servida de la caché", (a: Art) => (a.modelos[0]!.ast[3]!.B.informe["cache"] = "exact")],
      ["una llamada evitada", (a: Art) => (a.modelos[0]!.ast[3]!.B.informe["avoidedLlm"] = 1)],
      ["una llamada de más al proveedor", (a: Art) => (a.modelos[0]!.ast[3]!.B["llamadasAlProveedor"] = 2)],
      ["llamadas devueltas distintas de las recibidas", (a: Art) => (a.modelos[0]!.ast[3]!.B["fiel"] = false)],
      ["otro modelo servido en B", (a: Art) => (a.modelos[0]!.ast[3]!.B["modelosServidos"] = ["gpt-5.4"])],
    ])("la misma celda con %s: la capa intervino (o no se sabe) y exactitud-peor sigue fallando", (_, cambio) => {
      const art = conServido(real());
      cambio(art);
      const m = extraerBfcl(art, gpt);
      expect(m.sinIntervencion).toBeUndefined();
      expect(infraccionesDe(m, 0.75).map((i) => i.regla)).toContain("exactitud-peor");
      expect(evaluar([celda(m)], null).ok).toBe(false);
    });
  });

  describe("la cuota agotada del proveedor no es un fallo de la capa (run 36786990486)", () => {
    // Las celdas reales de gemini-3.1-pro-preview aquel día: la clave de Gemini
    // agotó su cuota diaria (`generate_requests_per_model_per_day`, límite 250).
    // MT-Bench: 3 preguntas, todas 429; dos cayeron por azar en el brazo B y el
    // banco lo contó como capa-falla. XSTest: 40 prompts con 429 en los dos
    // brazos, y la celda salía «medida», n=40, con 0 $ gastados.
    type Crudo = { modelo: string; preguntas: PreguntaCrudaMtBench[] }[];
    type Fx = { mtBench: unknown; mtBenchCrudo: Crudo; xstest: { registros: Record<string, Record<string, unknown>>[] } };
    const real = () => JSON.parse(leer("fixtures/banco-semanal-gemini-31-pro-cuota-36786990486.json")) as Fx;
    const pro = modelo("google/gemini-3.1-pro-preview");
    const celda = (m: Medicion): ResultadoDeCelda => ({ bateria: m.bateria, modelo: pro.id, estado: "medida", topeUsd: 1.5, medicion: m });

    it("reconoce la cuota por el 429 o por el cuerpo del proveedor, y nada más", () => {
      const fx = real();
      for (const p of fx.mtBenchCrudo[0]!.preguntas) expect(esErrorDeCuota(p.error)).toBe(true);
      expect(esErrorDeCuota("HTTP 429: RESOURCE_EXHAUSTED")).toBe(true);
      expect(esErrorDeCuota('Error: provider 429: {"error":{"code":429}}')).toBe(true);
      expect(esErrorDeCuota("You exceeded your current quota, please check your plan")).toBe(true);
      expect(esErrorDeCuota('{"type":"rate_limit_error","message":"..."}')).toBe(true);
      expect(esErrorDeCuota("Rate limit reached for gpt-4o-mini")).toBe(true);
      expect(esErrorDeCuota(undefined, 429)).toBe(true);
      expect(esErrorDeCuota('provider 400: {"error":{"message":"Unknown name \\"prompt_cache_key\\""}}')).toBe(false);
      expect(esErrorDeCuota("transporte: The operation was aborted due to timeout")).toBe(false);
      expect(esErrorDeCuota("HTTP 503: UNAVAILABLE", 503)).toBe(false);
      expect(esErrorDeCuota("pregunta 429: TypeError")).toBe(false);
    });

    it("MT-Bench · Pro: lo que era capa-falla es «no medible — cuota del proveedor», un aviso", () => {
      const fx = real();
      const m = extraerMtBench(fx.mtBench, pro, fx.mtBenchCrudo);
      expect(m).toMatchObject({ estado: "no-medible", n: 0, fallosDeLaCapa: 0, excluidosPorCuota: 3 });
      expect(m.motivo).toMatch(/^cuota del proveedor: 3 ítems con 429.*quedan 0 comparables \(mínimo 4\)/);
      expect(infraccionesDe(m, 1.5)).toEqual([]);
      // Sola, la batería se queda sin celdas medidas; en el run tenía otras nueve medidas.
      const v = evaluar([celda(m)], null);
      expect(v.infracciones.map((i) => i.regla)).toEqual(["bateria-sin-medir"]);
      expect(v.avisos).toContainEqual(expect.stringMatching(/^mt-bench · google\/gemini-3\.1-pro-preview: no medible — cuota del proveedor/));
    });

    it("XSTest · Pro: 40 prompts con 429 en los dos brazos son 0 pares — «no medible», nunca «medida»", () => {
      const m = extraerXstest(real().xstest, pro);
      expect(m).toMatchObject({ estado: "no-medible", n: 0, fallosDeLaCapa: 0, excluidosPorCuota: 40 });
      expect(m.motivo).toMatch(/^cuota del proveedor: 40 ítems/);
      const v = evaluar([celda(m)], null);
      expect(v.avisos).toContainEqual(expect.stringMatching(/^xstest · google\/gemini-3\.1-pro-preview: no medible — cuota del proveedor/));
      const md = resumenMarkdown({ modo: "vivo", commit: "c", version: "v", inicio: "i", fin: "f", gastoUsd: 0, reparto: reparto(), resultados: [celda(m)], veredicto: v });
      expect(md).toMatch(/\| xstest \| google\/gemini-3\.1-pro-preview \| no medible \|/);
    });

    it.each([
      ["un 400 del proveedor", 400, 'provider 400: {"error":{"code":400,"message":"Unknown name \\"prompt_cache_key\\""}}'],
      ["un timeout", 0, "transporte: The operation was aborted due to timeout"],
    ])("MT-Bench: %s solo en B sigue siendo capa-falla, aunque no quede nada comparable", (_, status, error) => {
      const fx = real();
      const p101 = fx.mtBenchCrudo[0]!.preguntas.find((p) => p.id === 101)!;
      p101.error = error;
      p101.llamadas = [{ brazo: "B", turno: 1, status, error }];
      const m = extraerMtBench(fx.mtBench, pro, fx.mtBenchCrudo);
      expect(m).toMatchObject({ fallosDeLaCapa: 1, excluidosPorCuota: 2 });
      expect(m.ejemplosDeFallos[0]).toMatch(/^pregunta 101: /);
      expect(infraccionesDe(m, 1.5).map((i) => i.regla)).toEqual(["capa-falla"]);
      expect(evaluar([celda(m)], null).ok).toBe(false);
    });

    it("XSTest: un 400 solo en B sigue siendo capa-falla; los 429 de los demás prompts, no", () => {
      const fx = real();
      const r = fx.xstest.registros[0]!;
      r["A"] = { ...r["A"], error: undefined, proveedor: { status: 200 } };
      r["B"] = { ...r["B"], error: "HTTP 400: INVALID_ARGUMENT", proveedor: { status: 400 } };
      const m = extraerXstest(fx.xstest, pro);
      expect(m).toMatchObject({ fallosDeLaCapa: 1, excluidosPorCuota: 39 });
      expect(infraccionesDe(m, 1.5).map((i) => i.regla)).toEqual(["capa-falla"]);
    });

    it("si B mandó más peticiones al proveedor que A, el 429 es de la capa: no se excluye", () => {
      const fx = real();
      // La capa reintentando por su cuenta: dos peticiones de B de más en la pregunta 93.
      const p93 = fx.mtBenchCrudo[0]!.preguntas.find((p) => p.id === 93)!;
      p93.llamadas!.push({ brazo: "B", turno: 1, status: 429 }, { brazo: "B", turno: 1, status: 429 });
      const m = extraerMtBench(fx.mtBench, pro, fx.mtBenchCrudo);
      expect(m.excluidosPorCuota).toBeUndefined();
      expect(m.fallosDeLaCapa).toBe(2);
      expect(m.ejemplosDeFallos[0]).toMatch(/más peticiones al proveedor en B \(5\) que en A \(3\)/);
      expect(infraccionesDe(m, 1.5).map((i) => i.regla)).toEqual(["capa-falla"]);

      const xs = real();
      for (const r of xs.xstest.registros) r["B"] = { ...r["B"], llamadasAlProveedor: 2 };
      const x = extraerXstest(xs.xstest, pro);
      expect(x.excluidosPorCuota).toBeUndefined();
      // Los dos brazos fallaron en todos: sin capa-falla (A también), y sin pares: no medible.
      expect(x).toMatchObject({ estado: "no-medible", fallosDeLaCapa: 0 });
    });

    it("una celda medida con algún ítem excluido por cuota lo dice en el resumen y en los avisos", () => {
      const m: Medicion = {
        bateria: "bfcl", modelo: pro.id, estado: "medido", gastoUsd: 0.2, n: 30, cortadaPorTope: false, llamadasCambiadas: 0,
        fallosDeLaCapa: 0, excluidosPorCuota: 2, ejemplosDeFallos: [], exactitud: [], informeVsFactura: [],
      };
      const v = evaluar([celda(m)], null);
      expect(v.ok).toBe(true);
      expect(v.avisos).toContainEqual(expect.stringMatching(/^bfcl · google\/gemini-3\.1-pro-preview: excluidos por cuota: 2/));
      const md = resumenMarkdown({ modo: "vivo", commit: "c", version: "v", inicio: "i", fin: "f", gastoUsd: 0.2, reparto: reparto(), resultados: [celda(m)], veredicto: v });
      expect(md).toMatch(/excluidos por cuota 2/);
      // Por debajo del mínimo de la batería, sin fallos de la capa: no medible.
      expect(MINIMO_COMPARABLE_TRAS_CUOTA.bfcl).toBe(10);
    });

    it("GSM8K: una posición con 429 de cuota no entra en la comparación de exactitud de ningún brazo", () => {
      const e = (pos: number, familia: number, brazo: "A" | "B", correcto: boolean, error?: string): Ensayo => ({
        pos, familia, clase: "original", oro: 1, huella: `h${pos}`, brazo, numero: correcto ? 1 : null, correcto, coste: 0.001,
        llamadas: error ? 0 : 1, peticiones: 1, entrada: 1, cacheada: 0, escrita: 0, salida: 1, latenciaMs: 1, fuente: "provider", ...(error ? { error } : {}),
      });
      const limpio = [e(0, 0, "A", true), e(0, 0, "B", true)];
      const conCuota = [...limpio, e(1, 1, "A", true), e(1, 1, "B", false, "provider 429: RESOURCE_EXHAUSTED")];
      const conOtro = [...limpio, e(1, 1, "A", true), e(1, 1, "B", false, "provider 400: bad request")];
      const dif = (es: Ensayo[]) => resumirGsm8k(es).comparaciones[0]!.diferenciaExactitud?.point;
      expect(dif(conCuota)).toBe(dif(limpio));
      expect(dif(conOtro)).toBeLessThan(0);
    });
  });

  describe("la sobrecarga del proveedor (529) tras los reintentos no es un fallo de la capa (run 36998187601)", () => {
    // La celda real: GSM8K · claude-opus-5-5 sobre e779dc3 (0.5.0-rc.1). B pos 6
    // acabó en `provider 529 overloaded_error` a los 108 s —la escalera entera de
    // `conReintentos`, que está DEBAJO de la capa en los cuatro brazos— y A pos 11
    // tardó 71 s en la misma escalera antes de su 200. El banco lo contó como
    // capa-falla y bloqueó la release.
    type Gsm8k = { modelos: { ensayos: { pos: number; brazo: string; error?: string; latenciaMs: number; peticiones: number }[] }[] };
    const real = () => JSON.parse(leer("fixtures/banco-semanal-gsm8k-opus-529-36998187601.json")) as Gsm8k;
    const opus = modelo("anthropic/claude-opus-5-5");
    const celda = (m: Medicion): ResultadoDeCelda => ({ bateria: m.bateria, modelo: opus.id, estado: "medida", topeUsd: 1.5, medicion: m });

    it("reconoce la sobrecarga por el 529 o por «overloaded» en un 503, y nada más", () => {
      const b6 = real().modelos[0]!.ensayos.find((e) => e.brazo === "B" && e.pos === 6)!;
      expect(esSobrecargaDelProveedor(b6.error)).toBe(true);
      expect(esSobrecargaDelProveedor(undefined, 529)).toBe(true);
      expect(esSobrecargaDelProveedor("HTTP 529: Overloaded")).toBe(true);
      expect(esSobrecargaDelProveedor('{"type":"overloaded_error","message":"Overloaded"}')).toBe(true);
      expect(esSobrecargaDelProveedor('HTTP 503: {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}')).toBe(true);
      // Un 5xx sin «overloaded», un 400 o un timeout siguen siendo errores normales.
      expect(esSobrecargaDelProveedor("HTTP 503: UNAVAILABLE", 503)).toBe(false);
      expect(esSobrecargaDelProveedor('provider 500: {"type":"api_error","message":"Internal server error"}')).toBe(false);
      expect(esSobrecargaDelProveedor("provider 502: Bad Gateway")).toBe(false);
      expect(esSobrecargaDelProveedor('provider 400: {"error":{"message":"overloaded parameter"}}')).toBe(false);
      expect(esSobrecargaDelProveedor("transporte: The operation was aborted due to timeout")).toBe(false);
      expect(esSobrecargaDelProveedor("pregunta 529: TypeError")).toBe(false);
      // La cuota sigue siendo cuota y la sobrecarga no lo es: la suma, para excluir.
      expect(esErrorDeCuota(b6.error)).toBe(false);
      expect(esErrorNoMedibleDelProveedor(b6.error)).toBe(true);
      expect(esErrorNoMedibleDelProveedor("provider 429: rate_limit_error")).toBe(true);
    });

    it("el arnés reintenta el 529 igual en todos los brazos, por debajo de la capa", async () => {
      let intentos = 0;
      const p = conReintentos(
        {
          id: "x",
          async generate() {
            intentos++;
            throw new Error('provider 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
          },
        },
        async () => {},
      );
      await expect(p.generate({ model: "m", messages: [] } as never)).rejects.toThrow(/provider 529/);
      expect(intentos).toBe(6);
    });

    it("GSM8K · Opus: el 529 de B sale de los dos brazos y va a un aviso; la celda queda en verde", () => {
      const art = real();
      const es = art.modelos[0]!.ensayos;
      const b6 = es.find((e) => e.brazo === "B" && e.pos === 6)!;
      // La escalera entera (2+5+10+20+40 s de esperas) y no menos: la capa no le quitó reintentos.
      expect(b6.latenciaMs).toBeGreaterThan(77_000);
      expect(es.find((e) => e.brazo === "A" && e.pos === 11)!.latenciaMs).toBeGreaterThan(37_000);
      const m = extraerGsm8k(art, opus);
      expect(m).toMatchObject({ estado: "medido", fallosDeLaCapa: 0, excluidosPorCuota: 1, excluidosPorSobrecarga: 1 });
      expect(infraccionesDe(m, 1.5)).toEqual([]);
      const v = evaluar([celda(m)], null);
      expect(v.ok).toBe(true);
      expect(v.avisos).toContainEqual(expect.stringMatching(/^gsm8k · anthropic\/claude-opus-5-5: excluidos por sobrecarga del proveedor: 1 \(529/));
      expect(v.avisos.some((a) => /excluidos por cuota/.test(a))).toBe(false);
      const md = resumenMarkdown({ modo: "vivo", commit: "c", version: "v", inicio: "i", fin: "f", gastoUsd: 0, reparto: reparto(), resultados: [celda(m)], veredicto: v });
      expect(md).toMatch(/capa-falla 0 · excluidos por sobrecarga 1/);
      expect(md).not.toMatch(/excluidos por cuota/);
    });

    it("con más peticiones de B que de A, el 529 es de la capa: no se excluye", () => {
      const art = real();
      for (const e of art.modelos[0]!.ensayos) if (e.brazo === "B") e.peticiones = 3;
      const m = extraerGsm8k(art, opus);
      expect(m.excluidosPorCuota).toBeUndefined();
      expect(m.fallosDeLaCapa).toBe(1);
      expect(m.ejemplosDeFallos[0]).toMatch(/529 de sobrecarga con más peticiones al proveedor en B/);
      expect(infraccionesDe(m, 1.5).map((i) => i.regla)).toEqual(["capa-falla"]);
    });

    it("un 500 solo en B sigue siendo capa-falla", () => {
      const art = real();
      art.modelos[0]!.ensayos.find((e) => e.brazo === "B" && e.pos === 6)!.error = 'provider 500: {"type":"api_error","message":"Internal server error"}';
      const m = extraerGsm8k(art, opus);
      expect(m).toMatchObject({ fallosDeLaCapa: 1 });
      expect(m.excluidosPorCuota).toBeUndefined();
      expect(infraccionesDe(m, 1.5).map((i) => i.regla)).toEqual(["capa-falla"]);
    });

    it("una celda que la sobrecarga deja sin ítems comparables es «no medible», con su motivo", () => {
      const art = real();
      for (const e of art.modelos[0]!.ensayos) if (e.brazo === "A") e.error = 'provider 529: {"type":"overloaded_error"}';
      const m = extraerGsm8k(art, opus);
      expect(m).toMatchObject({ estado: "no-medible", n: 0, fallosDeLaCapa: 0 });
      expect(m.motivo).toMatch(/^cuota del proveedor: \d+ ítems con 529 por sobrecarga del proveedor/);
    });
  });

  it("si un arnés cambia la forma de su artefacto, se dice; no sale un cero que parezca limpio", () => {
    expect(() => extraerGsm8k({ modelos: [{ modelo: "openai/gpt-4o-mini", estado: "medido", gasto: { totalUsd: 0 } }] }, modelo("openai/gpt-4o-mini"))).toThrow(
      /no tiene resumen\.brazos/,
    );
    expect(() => extraerBfcl({ modelos: [] }, modelo("openai/gpt-4o-mini"))).toThrow(/no trae/);
  });
});

describe("banco semanal · la puerta de publish.yml", () => {
  const ahora = new Date("2026-10-06T12:00:00Z");
  const run = (dias: number, conclusion: string | null, modo = "vivo", status = "completed"): RunDelBanco => ({
    status,
    conclusion,
    createdAt: new Date(ahora.getTime() - dias * 86_400_000).toISOString(),
    displayTitle: `banco semanal (${modo})`,
    url: `https://github.com/x/y/actions/runs/${dias}`,
  });

  it("pasa con el último banco en vivo en verde de hace ≤ 8 días", () => {
    expect(evaluarPuerta([run(1, "success")], ahora)).toMatchObject({ ok: true, nivel: "notice" });
    expect(evaluarPuerta([run(MAX_DIAS, "success")], ahora).ok).toBe(true);
  });

  it("cuando la release exige un SHA, un banco verde de otro commit o sin SHA no certifica", () => {
    const sha = "a".repeat(40);
    const valido = { ...run(1, "success"), headSha: sha };
    expect(evaluarPuerta([valido], ahora, { shaRequerido: sha })).toMatchObject({ ok: true, nivel: "notice" });
    expect(evaluarPuerta([{ ...valido, headSha: "b".repeat(40) }], ahora, { shaRequerido: sha }).mensaje).toMatch(/no la release/);
    expect(evaluarPuerta([run(1, "success")], ahora, { shaRequerido: sha }).mensaje).toMatch(/commit desconocido/);
    expect(evaluarPuerta([{ ...valido, headSha: "b".repeat(40) }], ahora, { shaRequerido: `  ${sha}  ` }).ok).toBe(false);
  });

  it("no pasa si el último falló, se canceló o es viejo — aunque antes hubiera uno verde", () => {
    expect(evaluarPuerta([run(1, "failure"), run(3, "success")], ahora)).toMatchObject({ ok: false, nivel: "error" });
    expect(evaluarPuerta([run(1, "cancelled")], ahora).ok).toBe(false);
    expect(evaluarPuerta([run(8.5, "success")], ahora).mensaje).toMatch(/8\.5 días; el máximo es 8/);
  });

  it("un run en seco o en curso no cuenta: se mira el último en vivo completado", () => {
    const runs = [run(0.5, "success", "seco"), run(0.2, null, "vivo", "in_progress"), run(2, "failure")];
    expect(ultimoBancoEnVivo(runs)?.conclusion).toBe("failure");
    expect(evaluarPuerta(runs, ahora).ok).toBe(false);
    expect(evaluarPuerta([run(0.5, "success", "seco")], ahora).mensaje).toMatch(/ningún banco semanal EN VIVO/);
  });

  it("sin lista legible no pasa; la emergencia pasa con aviso y dice el estado real", () => {
    expect(leerRuns("null")).toBeNull();
    expect(leerRuns("no es json")).toBeNull();
    expect(evaluarPuerta(null, ahora).ok).toBe(false);
    const e = evaluarPuerta([run(1, "failure")], ahora, { emergencia: "  CVE en la 0.4.33  " });
    expect(e).toMatchObject({ ok: true, nivel: "warning" });
    expect(e.mensaje).toMatch(/«CVE en la 0\.4\.33»[\s\S]*terminó en «failure»/);
    expect(evaluarPuerta([run(1, "failure")], ahora, { emergencia: "   " }).ok).toBe(false);
  });
});

describe("banco semanal · los registros no llevan secretos", () => {
  it("tapa el VALOR de las variables con nombre de secreto y lo que tenga forma de clave", () => {
    const env = { BVSALA_DEMO_OPENAI_API_KEY: "valor-de-prueba-12345", PATH: "/usr/bin", CORTA_KEY: "abc" };
    const s = valoresSecretos(env);
    expect(s).toEqual(["valor-de-prueba-12345"]);
    const t = redactar("x valor-de-prueba-12345 y sk-ant-abcdefghijklmnopqrstuv z /usr/bin", s);
    expect(t).toBe("x [redactado] y [redactado] z /usr/bin");
  });
});

// ── El YAML, como texto ─────────────────────────────────────────────────────

const sinComentarios = (t: string) =>
  t
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const banco = sinComentarios(leer("../.github/workflows/banco-semanal.yml"));
const publish = sinComentarios(leer("../.github/workflows/publish.yml"));
const doc = leer("../docs/BANCO-SEMANAL.md");

function trabajo(workflow: string, nombre: string): string {
  const lineas = workflow.split("\n");
  const inicio = lineas.findIndex((l) => l === `  ${nombre}:`);
  if (inicio < 0) throw new Error(`no hay un trabajo '${nombre}'`);
  let fin = lineas.length;
  for (let i = inicio + 1; i < lineas.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lineas[i]!) || /^\S/.test(lineas[i]!)) {
      fin = i;
      break;
    }
  }
  return lineas.slice(inicio, fin).join("\n");
}

describe("banco semanal · banco-semanal.yml", () => {
  it("es YAML de GitHub bien formado: sin tabuladores y con las claves de primer nivel esperadas", () => {
    expect(banco).not.toMatch(/\t/);
    const primerNivel = banco
      .split("\n")
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(primerNivel).toEqual(["name", "run-name", "on", "permissions", "concurrency", "jobs"]);
  });

  it("semanal por cron y a mano, con el modo en el título (la puerta solo cuenta los «(vivo)»)", () => {
    expect(banco).toMatch(/^ {2}schedule:\n {4}- cron: "17 4 \* \* 1"$/m);
    expect(banco).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(banco).toMatch(/options: \[vivo, seco\]/);
    const runName = /^run-name: "(.*)"$/m.exec(banco)![1]!;
    expect(runName.startsWith("banco semanal (${{ inputs.modo || 'vivo' }}")).toBe(true);
    // Un banco parcial lleva «parcial» DENTRO del paréntesis (la puerta no lo cuenta); la jornada va FUERA (sí cuenta).
    expect(runName).toContain("format(' parcial: {0} {1}', inputs.modelos, inputs.baterias)");
    expect(runName).toMatch(/\}\}\)\$\{\{ inputs\.jornada && format\(' · jornada \{0\}', inputs\.jornada\) \|\| '' \}\}$/);
    expect(ultimoBancoEnVivo([{ status: "completed", conclusion: "success", createdAt: "2026-10-01T00:00:00Z", displayTitle: "banco semanal (vivo parcial: google/gemini-3.1-pro-preview )" }])).toBeNull();
    expect(ultimoBancoEnVivo([{ status: "completed", conclusion: "success", createdAt: "2026-10-01T00:00:00Z", displayTitle: "banco semanal (vivo) · jornada 2" }])).not.toBeNull();
  });

  it("mínimo permiso, sin cancelar un banco pagado, y con plazo", () => {
    expect(banco).toMatch(/^permissions: \{\}$/m);
    expect(banco).toMatch(/cancel-in-progress: false/);
    const t = trabajo(banco, "banco");
    expect(t).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(Number(/timeout-minutes: (\d+)/.exec(t)![1])).toBeLessThanOrEqual(360);
  });

  it("construye el SDK, los paquetes y los servicios con la misma orden que CI", () => {
    const t = trabajo(banco, "banco");
    expect(t).toMatch(/^ {6}- run: pnpm run build:all$/m);
    expect(t).not.toMatch(/run: pnpm run build:(?:packages|services)$/);
    const ci = sinComentarios(leer("../.github/workflows/ci.yml"));
    expect(trabajo(ci, "verificar")).toMatch(/^ {6}- run: pnpm run build:all$/m);
  });

  it("los secretos van por NOMBRE, solo al paso del banco y solo en vivo; nada da de alta ni lee secretos", () => {
    const refs = [...banco.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "ANTHROPIC_ADMIN_API_KEY", "OPENAI_ADMIN_API_KEY"]));
    for (const l of banco.split("\n").filter((x) => /secrets\./.test(x))) {
      expect(l).toMatch(/\$\{\{ inputs\.modo != 'seco' && secrets\.[A-Z_]+ \|\| '' \}\}/);
    }
    expect(banco).not.toMatch(/gh secret|env pull|printenv|\benv\b\s*$/m);
  });

  it("en vivo solo desde main; resumen y artefacto aunque falle", () => {
    expect(banco).toMatch(/"\$MODO" = "vivo" \] && \[ "\$GITHUB_REF" != "refs\/heads\/main" \]/);
    expect(banco).toMatch(/orquestador\.ts "--\$MODO" --salida banco-semanal-salida "\$\{filtros\[@\]\}" --previa banco-semanal-previa$/m);
    // Los filtros del formulario llegan por el entorno, nunca interpolados en el script.
    for (const v of ["MODELOS", "BATERIAS", "JORNADA"]) expect(banco).toContain(`${v}: \${{ inputs.${v.toLowerCase()} }}`);
    expect(banco).not.toMatch(/run: [^\n]*\$\{\{ inputs\./);
    const script = /filtros=\(\)[\s\S]*?--previa banco-semanal-previa/.exec(banco)![0];
    expect(script).not.toContain("${{");
    expect(banco).toMatch(/if: always\(\)\n\s+run: \|\n\s+if \[ -f banco-semanal-salida\/resumen\.md \]/);
    expect(banco).toMatch(/cat banco-semanal-salida\/resumen\.md >> "\$GITHUB_STEP_SUMMARY"/);
    expect(banco).toMatch(/- uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:\n\s+name: banco-semanal/);
  });

  it("Gemini por su API nativa: la base de Google es …/v1beta, no el endpoint compatible", () => {
    expect(banco).toMatch(/^ +BVSALA_DEMO_GOOGLE_BASE_URL: https:\/\/generativelanguage\.googleapis\.com\/v1beta$/m);
    expect(banco).not.toMatch(/v1beta\/openai/);
    expect(banco).toMatch(/BVSALA_DEMO_GOOGLE_API_KEY: \$\{\{ inputs\.modo != 'seco' && secrets\.GEMINI_API_KEY \|\| '' \}\}/);
  });

  it("la factura real: ids como variables (no secretos), y la tirada anterior se baja solo en vivo con actions: read", () => {
    for (const v of ["BANCO_ANTHROPIC_WORKSPACE_ID", "BANCO_ANTHROPIC_API_KEY_ID", "BANCO_OPENAI_PROJECT_ID", "BANCO_OPENAI_API_KEY_ID"]) {
      expect(banco).toContain(`${v}: \${{ vars.${v} }}`);
    }
    const t = trabajo(banco, "banco");
    expect(t).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}actions: read$/m);
    expect(t).toMatch(/- name: Tirada anterior \(su factura pendiente\)\n\s+if: \$\{\{ inputs\.modo != 'seco' \}\}/);
    expect(t).toMatch(/gh run download "\$id" --repo "\$GITHUB_REPOSITORY" -n banco-semanal -D banco-semanal-previa/);
    expect(t).toMatch(/--previa banco-semanal-previa$/m);
  });

  it("docs/BANCO-SEMANAL.md nombra cada secreto que el workflow espera, con su `gh secret set`", () => {
    for (const s of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "ANTHROPIC_ADMIN_API_KEY", "OPENAI_ADMIN_API_KEY"]) {
      expect(doc).toContain(`gh secret set ${s}`);
    }
    for (const v of ["BANCO_ANTHROPIC_WORKSPACE_ID", "BANCO_ANTHROPIC_API_KEY_ID", "BANCO_OPENAI_PROJECT_ID", "BANCO_OPENAI_API_KEY_ID"]) {
      expect(doc).toContain(`gh variable set ${v}`);
    }
    expect(doc).toContain("BANCO_SEMANAL_EMERGENCIA");
  });
});

describe("banco semanal · la puerta en publish.yml", () => {
  const puerta = trabajo(publish, "banco-semanal");

  it("`publicar` depende de la puerta; `verificar` NO (la publicación a mano sigue teniendo su tarball)", () => {
    expect(trabajo(publish, "publicar")).toMatch(/^ {4}needs: \[verificar, banco-semanal\]$/m);
    expect(trabajo(publish, "verificar")).not.toMatch(/needs:/);
  });

  it("solo lee: actions: read, sin instalar nada, y decide puerta.ts con Node 24", () => {
    expect(puerta).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}actions: read$/m);
    expect(puerta).not.toMatch(/id-token|contents: write|pnpm|npm (?:install|ci|i)\b|npx|yarn/);
    expect(puerta).toMatch(/node-version: 24/);
    expect(puerta).toMatch(/gh run list --repo "\$GITHUB_REPOSITORY" --workflow banco-semanal\.yml --branch main/);
    expect(puerta).toMatch(/\|\| echo "null" > runs\.json/);
    expect(puerta).toMatch(/node benchmarks\/banco-semanal\/puerta\.ts runs\.json/);
    expect(puerta).toMatch(/BANCO_SEMANAL_EMERGENCIA: \$\{\{ vars\.BANCO_SEMANAL_EMERGENCIA \}\}/);
  });

  it("las dos publicaciones exigen que el banco verde sea del commit de la Release", () => {
    for (const workflow of [publish, sinComentarios(leer("../.github/workflows/publish-postgres.yml"))]) {
      expect(trabajo(workflow, "banco-semanal")).toMatch(/BANCO_SEMANAL_SHA: \$\{\{ github\.sha \}\}/);
    }
  });

  it("puerta.ts corre con Node sin instalar nada: no importa nada fuera de node:*", () => {
    const fuente = leer("../benchmarks/banco-semanal/puerta.ts");
    const imports = [...fuente.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^node:/);
    // Sin sintaxis que Node no sabe quitar (enum, namespace, parámetros-propiedad).
    expect(fuente).not.toMatch(/\benum\b|\bnamespace\b|constructor\((?:private|public|readonly)/);
  });
});
