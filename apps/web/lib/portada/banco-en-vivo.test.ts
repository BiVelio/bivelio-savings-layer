import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BANCO_EN_VIVO, type Intervalo } from "./banco-en-vivo";

/**
 * CADA CIFRA DE LA PORTADA, CONTRA SU INFORME.
 *
 * `banco-en-vivo.ts` lleva las cifras escritas a mano (la portada es ISR y no
 * lee `docs/` en Vercel). Esta verja las lee de los JSON de los informes, por
 * su cuenta, y exige que coincidan a la décima — y que ninguna cota inferior
 * publicada quede POR ENCIMA de la medida: redondear hacia arriba un suelo es
 * prometer una décima que el banco no sostiene.
 */

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const informe = (ruta: string): J => JSON.parse(readFileSync(join(RAIZ, ruta), "utf8"));

function modeloDe(inf: J, modelo: string): J {
  const m = (inf.modelos as J[]).find((x) => x.modelo === modelo);
  expect(m, `${modelo} en el informe`).toBeDefined();
  expect(m.estado, `${modelo}: estado`).toBe("medido");
  return m;
}

function brazoB(m: J): J {
  const c = (m.resumen.comparaciones as J[]).find((x) => x.brazo === "B");
  expect(c, "comparación del brazo B").toBeDefined();
  return c;
}

const decima = (x: number) => Math.round(x * 1000) / 1000;

function cuadra(publicado: Intervalo, medido: Intervalo) {
  expect(publicado.point).toBe(decima(medido.point));
  expect(publicado.lower).toBe(decima(medido.lower));
  expect(publicado.upper).toBe(decima(medido.upper));
  // El suelo publicado nunca por encima del medido.
  expect(publicado.lower).toBeLessThanOrEqual(medido.lower);
}

describe("las cifras de la portada salen de sus informes", () => {
  const V = BANCO_EN_VIVO;

  it("OpenAI: el informe es de la fecha, la versión y la batería que dice la portada", () => {
    const inf = informe(V.openai.informe);
    expect(inf.fecha).toBe(V.fecha);
    expect(inf.modo).toBe("LIVE");
    expect(inf.procedencia.version).toBe(V.versionSdk);
    expect(String(inf.bateria).toLowerCase()).toContain(V.bateria.toLowerCase());
    // «con un 30 % de repeticiones exactas»: la fracción del diseño del flujo…
    expect(inf.flujo.fraccionRepeticiones).toBe(V.repeticiones);
    // …y la que de verdad llevó el flujo medido de este modelo.
    const m = modeloDe(inf, V.openai.modelo);
    expect(m.flujo.repeticion / m.peticionesCompletadas).toBeCloseTo(V.repeticiones, 2);
  });

  it(`OpenAI ${V.openai.modelo}: ahorro de B frente a A, con su IC 95 %`, () => {
    const m = modeloDe(informe(V.openai.informe), V.openai.modelo);
    cuadra(V.openai.ahorro, brazoB(m).ahorroMedido);
    // Y el ahorro no se compró con exactitud: B no pierde frente a A.
    expect(brazoB(m).diferenciaExactitud.lower).toBeGreaterThanOrEqual(0);
  });

  it(`Anthropic ${V.anthropic.modelo}: el total de B y la parte de la caché de prefijo del proveedor`, () => {
    const inf = informe(V.anthropic.informe);
    expect(inf.fecha).toBe(V.fecha);
    expect(inf.modo).toBe("LIVE");
    expect(inf.procedencia.version).toBe(V.versionSdk);
    expect(inf.flujo.fraccionRepeticiones).toBe(V.repeticiones);
    const m = modeloDe(inf, V.anthropic.modelo);
    const b = brazoB(m);
    cuadra(V.anthropic.ahorro, b.ahorroMedido);
    // «Cerca de X de la factura original es la caché de prefijo del proveedor»:
    // el prefijo neto del brazo B sobre el coste de A, redondeado hacia abajo.
    const d = (m.desglose as J[]).find((x) => x.brazo === "B");
    const parte = d.prefijoNetoUsd / b.costeA;
    expect(V.anthropic.prefijoDelProveedor).toBe(Math.floor(parte * 100) / 100);
    // Y es de verdad la parte mayor del ahorro: más de la mitad del total.
    expect(d.prefijoNetoUsd / d.ahorroTotalUsd).toBeGreaterThan(0.5);
  });

  it("Gemini no tiene cifra medida en esta tirada: la portada no puede enseñarla", () => {
    for (const ruta of [V.openai.informe, V.anthropic.informe]) {
      const medidos = (informe(ruta).modelos as J[]).filter((x) => x.estado === "medido").map((x) => String(x.modelo));
      expect(medidos.filter((x) => /gemini|google/i.test(x)), ruta).toEqual([]);
    }
  });
});
