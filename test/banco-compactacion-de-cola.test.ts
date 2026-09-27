import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { BRAZOS, MODELOS, PERFILES, medirCompactacionDeCola } from "../benchmarks/compactacion-de-cola/banco.js";
import { sesiones } from "../benchmarks/compactacion-de-cola/sesiones.js";
import { seleccionarCompactables } from "../src/compression/cola.js";

/**
 * LA VERJA ECONÓMICA DE LA COMPACTACIÓN DE LA COLA, sobre el banco en seco.
 *
 * Mismo compactador, mismos tokens quitados, TRES momentos distintos de
 * aplicarlo, y la caché de prefijo simulada con el motor calibrado del carril
 * sombra. Lo que esta verja fija:
 *
 *   · compactar AL NACER no paga ni un céntimo de invalidación y no encarece
 *     NINGUNA sesión de ningún perfil ni modelo;
 *   · compactar lo VIEJO (el patrón que perdió en las mediciones de 2026 y en el
 *     replay propio) sí paga invalidación, y queda por debajo;
 *   · encenderla A MITAD paga una reescritura: el caso que se documenta;
 *   · el artefacto publicado en `benchmarks/evidencia/` es exactamente lo que
 *     este código calcula hoy — las cifras del informe tienen código detrás.
 */

const artefacto = medirCompactacionDeCola();

describe("la cifra publicada es la que calcula el código", () => {
  it("el artefacto de evidencia coincide con una tirada nueva, bit a bit", () => {
    const ruta = fileURLToPath(new URL("../benchmarks/evidencia/compactacion-de-cola-2026-09-27.json", import.meta.url));
    const publicado = JSON.parse(readFileSync(ruta, "utf8"));
    expect(publicado).toEqual(JSON.parse(JSON.stringify(artefacto)));
  });

  it("las sesiones sintéticas viven en el régimen real: más del 90 % de los tokens de entrada se leen de caché", () => {
    for (const perfil of PERFILES) {
      expect(artefacto.perfiles[perfil]!.lecturaSobreTokensPct, perfil).toBeGreaterThan(90);
    }
  });
});

describe("el momento decide el signo", () => {
  for (const perfil of PERFILES) {
    for (const modelo of MODELOS) {
      it(`${perfil} · ${modelo}: al nacer, cero invalidación y ninguna sesión peor; lo viejo y la mitad sí pagan`, () => {
        const b = artefacto.perfiles[perfil]!.porModelo[modelo]!;
        expect(b.base.ahorroPct).toBe(0);
        expect(b.cola.invalidacionUsd).toBe(0);
        expect(b.cola.tokensInvalidados).toBe(0);
        expect(b.cola.sesionesPeores).toBe(0);
        expect(b.cola.ahorroPct).toBeGreaterThan(0);

        expect(b.vieja.invalidacionUsd).toBeGreaterThan(0);
        expect(b.vieja.ahorroPct).toBeLessThan(b.cola.ahorroPct);
        expect(b.mitad.invalidacionUsd).toBeGreaterThan(0);
        expect(b.mitad.ahorroPct).toBeLessThan(b.cola.ahorroPct);
        for (const brazo of BRAZOS) expect(b[brazo].usd).toBeGreaterThan(0);
      });
    }
  }
});

describe("lo que no se toca y la estabilidad de la decisión", () => {
  it("las lecturas de fichero y el grep (llamadas con `path`) no se compactan nunca", () => {
    expect(artefacto.porClase["lectura-de-fichero"]!.compactadas).toBe(0);
    expect(artefacto.porClase.grep!.compactadas).toBe(0);
    expect(artefacto.porClase["json-compacto"]!.compactadas).toBe(0);
  });

  it("la decisión sobre un prefijo de la sesión es la misma que sobre la sesión entera", () => {
    for (const s of sesiones("agente-de-operaciones", 3, 7)) {
      const entera = seleccionarCompactables(s.mensajes).compactados;
      for (let corte = 4; corte <= s.mensajes.length; corte += 6) {
        const prefijo = seleccionarCompactables(s.mensajes.slice(0, corte)).compactados;
        const esperada = entera.filter((c) => c.indice < corte);
        expect(prefijo.map((c) => [c.indice, c.texto])).toEqual(esperada.map((c) => [c.indice, c.texto]));
      }
    }
  });
});
