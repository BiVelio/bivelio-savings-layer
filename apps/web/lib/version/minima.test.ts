import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { VERSION_MINIMA_AHORRO_NETO, VERSION_MINIMA_PALANCA_TARIFA } from "./minima";
import { compararVersiones, parsearVersion } from "./semver";

/**
 * La mínima que el panel cita («gateway anterior a 0.4.16: actualiza») tiene
 * que ser la MISMA que declara el SDK. La web no importa del SDK, así que se
 * lee src/version.ts como TEXTO — el mismo mecanismo que ata la clave pública
 * (lib/license/clave-esperada.test.ts). Si derivaran, el panel mandaría
 * actualizar citando una versión que no es la de la palanca.
 */
const RAIZ = new URL("../../../../", import.meta.url);
const fuente = readFileSync(new URL("src/version.ts", RAIZ), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", RAIZ), "utf8")) as { version: string };

function constante(nombre: string): string {
  const m = new RegExp(`export const ${nombre} = "([^"]+)";`).exec(fuente);
  expect(m, `src/version.ts tiene que declarar ${nombre}`).not.toBeNull();
  return m![1]!;
}

describe("VERSION_MINIMA_PALANCA_TARIFA — espejo de src/version.ts", () => {
  it("es exactamente la que declara el SDK", () => {
    expect(VERSION_MINIMA_PALANCA_TARIFA).toBe(constante("VERSION_MINIMA_PALANCA_TARIFA"));
  });

  it("es un semver de tres partes, sin prefijo de superficie ni sufijo", () => {
    expect(VERSION_MINIMA_PALANCA_TARIFA).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
    expect(parsearVersion(VERSION_MINIMA_PALANCA_TARIFA)?.superficie).toBeNull();
  });

  it("no es mayor que la versión publicada (package.json y BV_SALA_VERSION)", () => {
    // Una mínima por delante de lo publicado marcaría como desactualizada a
    // TODA máquina, incluida la más nueva que exista.
    expect(compararVersiones(VERSION_MINIMA_PALANCA_TARIFA, pkg.version)).toBeLessThanOrEqual(0);
    expect(compararVersiones(VERSION_MINIMA_PALANCA_TARIFA, constante("BV_SALA_VERSION"))).toBeLessThanOrEqual(0);
  });
});

describe("VERSION_MINIMA_AHORRO_NETO — espejo de src/version.ts", () => {
  it("es exactamente la que declara el SDK, y un semver de tres partes", () => {
    expect(VERSION_MINIMA_AHORRO_NETO).toBe(constante("VERSION_MINIMA_AHORRO_NETO"));
    expect(VERSION_MINIMA_AHORRO_NETO).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  });

  it("no es mayor que la versión publicada: si lo fuera, TODA máquina saldría «en bruto»", () => {
    expect(compararVersiones(VERSION_MINIMA_AHORRO_NETO, pkg.version)).toBeLessThanOrEqual(0);
    expect(compararVersiones(VERSION_MINIMA_AHORRO_NETO, constante("BV_SALA_VERSION"))).toBeLessThanOrEqual(0);
  });

  it("es posterior a la de la palanca: no hay neto sin palanca", () => {
    expect(compararVersiones(VERSION_MINIMA_PALANCA_TARIFA, VERSION_MINIMA_AHORRO_NETO)).toBeLessThan(0);
  });
});
