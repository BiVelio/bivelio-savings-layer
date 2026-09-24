import { describe, it, expect } from "vitest";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  TRAMOS,
  GARANTIA_NETA_RATIO,
  COMISIONAR_ELISION_SUELO,
  COMISIONAR_REFERENCIA,
  REGLA_REFERENCIA,
  comisionPorTramos,
  calcularComision,
} from "./tarifa";

/**
 * La tarifa variable decidida el 2026-08-23 y revisada el 2026-09-01 (decisión
 * del dueño: SIN MÍNIMO — el umbral del 30% y la rampa 30→35% se retiran; la
 * comisión por tramos aplica desde el primer euro medido). Estos tests son el
 * ANCLA de los números y de la garantía que sustituye a la vieja: el cliente
 * se queda SIEMPRE con GARANTIA_NETA_RATIO o más de cada euro ahorrado.
 */

describe("las constantes decididas", () => {
  it("tramos 10/8/6/4 con cortes en 1.000/5.000/20.000 €", () => {
    expect(TRAMOS.map((t) => [t.hastaEur, t.tipo])).toEqual([
      [1_000, 0.1],
      [5_000, 0.08],
      [20_000, 0.06],
      [Number.POSITIVE_INFINITY, 0.04],
    ]);
  });
  it("los tipos solo bajan: cuanto más ahorras, menor porcentaje", () => {
    for (let i = 1; i < TRAMOS.length; i++) {
      expect(TRAMOS[i]!.tipo).toBeLessThan(TRAMOS[i - 1]!.tipo);
    }
  });
  it("la garantía se DERIVA del tramo más caro — no puede divergir de la tarifa", () => {
    expect(GARANTIA_NETA_RATIO).toBe(0.9);
    expect(GARANTIA_NETA_RATIO).toBe(1 - Math.max(...TRAMOS.map((t) => t.tipo)));
  });
});

describe("los tramos son marginales (como el IRPF), nunca por el total", () => {
  it("un ahorro dentro del primer tramo paga 10% liso", () => {
    expect(comisionPorTramos(900).totalEur).toBeCloseTo(90, 10);
  });
  it("cruzar un corte solo cambia el tipo del EXCESO", () => {
    // 1.000 × 10% + 1 × 8% — no 1.001 × 8%.
    expect(comisionPorTramos(1_001).totalEur).toBeCloseTo(100.08, 10);
  });
  it("el ejemplo de la flota grande del plan: 15.600 → 1.056 (6,8% efectivo)", () => {
    const { totalEur, tramos } = comisionPorTramos(15_600);
    expect(totalEur).toBeCloseTo(1_056, 10);
    expect(tramos.map((t) => t.comisionEur)).toEqual([100, 320, 636]);
    expect(totalEur / 15_600).toBeLessThan(0.07);
  });
  it("por encima de 20.000 € el marginal es el 4%", () => {
    const a = comisionPorTramos(20_000).totalEur;
    const b = comisionPorTramos(21_000).totalEur;
    expect(b - a).toBeCloseTo(1_000 * 0.04, 10);
  });
});

describe("calcularComision — sin mínimo (2026-09-01)", () => {
  it("caso típico: 900 de ahorro sobre 2.000 (45%) → 90", () => {
    const c = calcularComision(2_000, 900);
    expect(c.comisionEur).toBe(90);
    expect(c.netoClienteEur).toBe(810);
  });
  it("SIN UMBRAL: 110 sobre 500 (22%) ya comisiona — 11, y el cliente neta 99", () => {
    // Bajo la tarifa anterior esto era 0 (umbral 30%). La franja 0–35% es
    // exactamente lo que la revisión del 2026-09-01 convierte en ingresos.
    const c = calcularComision(500, 110);
    expect(c.comisionEur).toBe(11);
    expect(c.netoClienteEur).toBe(99);
  });
  it("SIN RAMPA: 3.100 sobre 10.000 (31%) paga los tramos enteros — 268", () => {
    // Antes: 53,60 (factor 0,2 de la rampa). Ahora los tramos, sin factor:
    // 1.000×10% + 2.100×8% = 268.
    const c = calcularComision(10_000, 3_100);
    expect(c.comisionEur).toBeCloseTo(268, 10);
  });
  it("≥35% no nota el cambio: flota grande 15.600 sobre 30.000 (52%) → 1.056", () => {
    expect(calcularComision(30_000, 15_600).comisionEur).toBe(1_056);
  });
  it("ahorro cero → comisión cero: solo cobramos si ahorra", () => {
    const c = calcularComision(10_000, 0);
    expect(c.comisionEur).toBe(0);
    expect(c.netoClienteEur).toBe(0);
  });
  it("base cero no divide por cero ni comisiona nada", () => {
    const c = calcularComision(0, 0);
    expect(c.ratio).toBe(0);
    expect(c.comisionEur).toBe(0);
  });
});

describe("LA GARANTÍA: el cliente se queda con ≥ GARANTIA_NETA_RATIO de cada euro ahorrado", () => {
  it("se cumple en una rejilla densa de ratios y bases — incluida la franja sin umbral", () => {
    for (const base of [100, 1_000, 3_333.33, 10_000, 50_000, 250_000]) {
      for (let ratio = 0.01; ratio <= 0.99; ratio += 0.007) {
        const c = calcularComision(base, base * ratio);
        if (c.ahorroMedidoEur === 0) continue;
        expect(
          c.netoClienteEur / c.ahorroMedidoEur,
          `base=${base} ratio=${ratio.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(GARANTIA_NETA_RATIO - 1e-6);
      }
    }
  });
  it("el peor caso es exactamente el primer tramo: 10% de comisión, 90% para el cliente", () => {
    const c = calcularComision(10_000, 1_000);
    expect(c.comisionEur).toBe(100);
    expect(c.netoClienteEur / c.ahorroMedidoEur).toBeCloseTo(GARANTIA_NETA_RATIO, 10);
  });
});

describe("COMISIONAR_ELISION_SUELO — el interruptor del suelo de la elisión (0025)", () => {
  it("está APAGADO: el suelo se guarda y se enseña como conteo, jamás entra en la comisión", () => {
    // Encenderlo es decisión del dueño y obliga a reescribir los seis puntos
    // listados en tarifa.ts. Este test es el ancla: nadie lo cambia de tapadillo.
    expect(COMISIONAR_ELISION_SUELO).toBe(false);
  });
});

describe("COMISIONAR_REFERENCIA — el interruptor del carril medido por referencia (0029)", () => {
  it("está ENCENDIDO: la referencia es el contador de una llamada idéntica ya ejecutada, tarifado a la baja", () => {
    // Apagarlo es decisión del dueño (false + este test + un PR) y deja de
    // cobrar lo acumulado en los períodos no sellados. Este test es el ancla.
    expect(COMISIONAR_REFERENCIA).toBe(true);
  });

  it("la regla publicada en el extracto es la v1 decidida", () => {
    expect(REGLA_REFERENCIA).toEqual({
      version: "referencia-v1",
      cuotaSalida: 0.95,
      edadMaximaDias: 30,
      margenPorMensajeTokens: 8,
    });
  });

  /**
   * La regla del extracto DUPLICA tres constantes del SDK (apps/web no puede
   * importar de src/). El ancla lee el fuente del SDK como texto, el mismo truco
   * que precio-publicado y VERSION_PRECIOS_CATALOGO. Las constantes llegan con
   * el PR del SDK (servidor primero, npm después): hasta entonces el ancla se
   * salta, y en cuanto existan en src/ la comprobación corre sola.
   */
  const accounting = readFileSync(
    join(new URL(".", import.meta.url).pathname, "..", "..", "..", "..", "src", "tokenizer", "accounting.ts"),
    "utf8",
  );
  const sdkLasTiene = /\bREFERENCE_OUTPUT_SHARE\b/.test(accounting);

  it.skipIf(!sdkLasTiene)("casa con las constantes del SDK (src/tokenizer/accounting.ts) leídas como texto", () => {
    expect(accounting).toMatch(/export const REFERENCE_OUTPUT_SHARE = 0\.95;/);
    expect(accounting).toMatch(/export const REFERENCE_MAX_AGE_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
    expect(accounting).toMatch(/export const REFERENCE_MESSAGE_ALLOWANCE = 8;/);
    const cuota = Number(/export const REFERENCE_OUTPUT_SHARE = ([0-9.]+);/.exec(accounting)![1]);
    const dias = Number(/export const REFERENCE_MAX_AGE_MS = ([0-9]+) \*/.exec(accounting)![1]);
    const margen = Number(/export const REFERENCE_MESSAGE_ALLOWANCE = ([0-9]+);/.exec(accounting)![1]);
    expect(REGLA_REFERENCIA.cuotaSalida).toBe(cuota);
    expect(REGLA_REFERENCIA.edadMaximaDias).toBe(dias);
    expect(REGLA_REFERENCIA.margenPorMensajeTokens).toBe(margen);
  });

  it("(aviso) sin las constantes en el SDK el ancla de arriba se salta: PR-B las trae", () => {
    // No es un fallo: documenta el estado. Con las constantes en src/, el test de arriba corre.
    expect(typeof sdkLasTiene).toBe("boolean");
  });
});

/**
 * TEST NEGATIVO: ningún camino del DINERO de apps/web tarifa nada a
 * `inputPer1k`. El suelo de la elisión se valora en el gateway a precio de
 * LECTURA de caché (cachedInputPer1k) y el servidor solo lo acota
 * (techo-precio-lectura.ts); si alguien trae a la facturación, al ingest, al
 * panel o al extracto un cálculo a precio de entrada (×10-40), este test lo
 * caza por el nombre del campo. Fuera del alcance, a propósito: la calculadora
 * de la landing y la página `verify`, que valoran el artefacto A/B de
 * referencia (gpt-4o-mini) y no tienen nada que ver con el suelo.
 */
describe("ningún camino del dinero de apps/web tarifa a inputPer1k", () => {
  const WEB = join(new URL(".", import.meta.url).pathname, "..", "..");
  const ALCANCE = ["lib/billing", "lib/metering", "app/api", "app/[locale]/dashboard"];
  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === "verify") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) fuentes(p, acc);
      else if ((e.endsWith(".ts") || e.endsWith(".tsx")) && !e.includes(".test.")) acc.push(p);
    }
    return acc;
  }
  /** Sin comentarios: la doctrina puede NOMBRAR el precio de entrada para prohibirlo. */
  const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const todos = ALCANCE.flatMap((d) => fuentes(join(WEB, d)));

  it("ningún fichero del dinero menciona inputPer1k en código (cachedInputPer1k sí puede)", () => {
    const culpables = todos
      .filter((f) => /\binputPer1k\b/.test(sinComentarios(readFileSync(f, "utf8"))))
      .map((f) => f.replace(WEB, "apps/web"));
    expect(culpables).toEqual([]);
  });
  it("el comprobador no está vacío: recorre ficheros de verdad y ve cachedInputPer1k donde toca", () => {
    expect(todos.length).toBeGreaterThan(40);
    expect(todos.some((f) => f.endsWith("techo-precio-lectura.ts"))).toBe(true);
    expect(todos.some((f) => f.endsWith("extracto.ts"))).toBe(true);
  });
});
