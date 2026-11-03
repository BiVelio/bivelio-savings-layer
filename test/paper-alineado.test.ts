import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generarContenido, renderModulo, RUTAS } from "../scripts/paper.js";

/**
 * EL PAPER Y SU PÁGINA NO PUEDEN DIVERGIR. `docs/PAPER.md` es la fuente; la
 * página /paper se genera con `pnpm paper:contenido`. Este test es el
 * equivalente de `init:ejemplos`: si alguien edita el markdown y no regenera,
 * el CI lo dice; si alguien toca a mano el fichero generado, también.
 */

const raiz = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe("paper: el markdown del repo y la página /paper, byte a byte", () => {
  it("contenido.ts es exactamente lo que genera scripts/paper.ts (si no: pnpm paper:contenido)", () => {
    const md = readFileSync(raiz(RUTAS.md), "utf8");
    const esperado = renderModulo(generarContenido(md));
    const actual = readFileSync(raiz(RUTAS.modulo), "utf8");
    expect(actual).toBe(esperado);
  });

  it("el módulo generado declara los bloques que la página consume", () => {
    const contenido = readFileSync(raiz(RUTAS.modulo), "utf8");
    expect(contenido).toContain("export const BLOQUES: Bloque[]");
    const bloques = generarContenido(readFileSync(raiz(RUTAS.md), "utf8"));
    expect(bloques.length).toBeGreaterThan(40);
    expect(bloques.filter((b) => b.tipo === "tabla").length).toBeGreaterThanOrEqual(2);
    expect(bloques.some((b) => b.tipo === "h1")).toBe(true);
  });

  it("el paper publica sus cifras con intervalo y sus límites", () => {
    const md = readFileSync(raiz(RUTAS.md), "utf8");
    for (const t of ["31.5", "75.1", "2.49", "95 ", "measured", "reference", "estimated", "Limitations"]) {
      expect(md, t).toContain(t);
    }
    // El apéndice en español viaja con el paper.
    expect(md).toContain("Resumen en español");
  });
});
