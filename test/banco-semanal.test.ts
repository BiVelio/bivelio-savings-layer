import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extraerBfcl, extraerGsm8k, extraerMtBench, extraerXstest, MINIMO_DE_TURNOS_JUZGADOS, type Medicion } from "../benchmarks/banco-semanal/extraer.js";
import { resumenMarkdown } from "../benchmarks/banco-semanal/resumen.js";
import { claveQueFalta, filtrarCeldas, redactar, valoresSecretos } from "../benchmarks/banco-semanal/orquestador.js";
import {
  argumentosDe,
  BATERIAS,
  CajaGlobal,
  MODELOS_DEL_BANCO,
  PRESUPUESTO_SEMANAL_USD,
  planificar,
  reparto,
  TECHO_DE_CELDA_USD,
  TopeGlobalAgotado,
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
    expect(banco).toMatch(/^run-name: "banco semanal \(\$\{\{ inputs\.modo \|\| 'vivo' \}\}\)"$/m);
  });

  it("mínimo permiso, sin cancelar un banco pagado, y con plazo", () => {
    expect(banco).toMatch(/^permissions: \{\}$/m);
    expect(banco).toMatch(/cancel-in-progress: false/);
    const t = trabajo(banco, "banco");
    expect(t).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(Number(/timeout-minutes: (\d+)/.exec(t)![1])).toBeLessThanOrEqual(360);
  });

  it("los secretos van por NOMBRE, solo al paso del banco y solo en vivo; nada da de alta ni lee secretos", () => {
    const refs = [...banco.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY"]));
    for (const l of banco.split("\n").filter((x) => /secrets\./.test(x))) {
      expect(l).toMatch(/\$\{\{ inputs\.modo != 'seco' && secrets\.[A-Z_]+ \|\| '' \}\}/);
    }
    expect(banco).not.toMatch(/gh secret|env pull|printenv|\benv\b\s*$/m);
  });

  it("en vivo solo desde main; resumen y artefacto aunque falle", () => {
    expect(banco).toMatch(/"\$MODO" = "vivo" \] && \[ "\$GITHUB_REF" != "refs\/heads\/main" \]/);
    expect(banco).toMatch(/orquestador\.ts "--\$MODO" --salida banco-semanal-salida/);
    expect(banco).toMatch(/if: always\(\)\n\s+run: \|\n\s+if \[ -f banco-semanal-salida\/resumen\.md \]/);
    expect(banco).toMatch(/cat banco-semanal-salida\/resumen\.md >> "\$GITHUB_STEP_SUMMARY"/);
    expect(banco).toMatch(/- uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:\n\s+name: banco-semanal/);
  });

  it("Gemini por su API nativa: la base de Google es …/v1beta, no el endpoint compatible", () => {
    expect(banco).toMatch(/^ +BVSALA_DEMO_GOOGLE_BASE_URL: https:\/\/generativelanguage\.googleapis\.com\/v1beta$/m);
    expect(banco).not.toMatch(/v1beta\/openai/);
    expect(banco).toMatch(/BVSALA_DEMO_GOOGLE_API_KEY: \$\{\{ inputs\.modo != 'seco' && secrets\.GEMINI_API_KEY \|\| '' \}\}/);
  });

  it("docs/BANCO-SEMANAL.md nombra cada secreto que el workflow espera, con su `gh secret set`", () => {
    for (const s of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY"]) {
      expect(doc).toContain(`gh secret set ${s}`);
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

  it("puerta.ts corre con Node sin instalar nada: no importa nada fuera de node:*", () => {
    const fuente = leer("../benchmarks/banco-semanal/puerta.ts");
    const imports = [...fuente.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^node:/);
    // Sin sintaxis que Node no sabe quitar (enum, namespace, parámetros-propiedad).
    expect(fuente).not.toMatch(/\benum\b|\bnamespace\b|constructor\((?:private|public|readonly)/);
  });
});
