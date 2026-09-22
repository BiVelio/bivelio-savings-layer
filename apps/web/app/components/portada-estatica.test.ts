import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LA PORTADA ES ESTÁTICA, Y LO QUE LA HARÍA DINÁMICA OTRA VEZ ES UNA LÍNEA.
 *
 * Medido el 22-09-2026: `NavBar` leía las cookies en el servidor para saber si
 * había sesión, y `cookies()` convierte en dinámica la ruta entera. La portada,
 * «Cómo funciona», el alta y el restablecimiento de contraseña se renderizaban
 * en una función en cada visita (240-350 ms de TTFB) en vez de servirse desde
 * la caché del borde. La sesión la mira ahora el navegador (`useHaySesion`).
 *
 * Este test lee el FUENTE de las piezas que comparten todas las páginas
 * públicas —la barra y el layout del locale— y exige que ninguna toque las
 * APIs de petición. No es una prueba de Next: es el candado para que nadie
 * vuelva a meter un `getUser()` «solo para el botón».
 */
const AQUI = fileURLToPath(new URL("./", import.meta.url));
const APP = fileURLToPath(new URL("../", import.meta.url));

const DINAMICO = /\bcookies\(|\bheaders\(|createReadOnlyClient|createClient\(\)\s*;?\s*$|auth\.getUser|force-dynamic/m;

describe("la portada se sirve estática", () => {
  for (const [nombre, ruta] of [
    ["NavBar.tsx", `${AQUI}NavBar.tsx`],
    ["NavLinks.tsx", `${AQUI}NavLinks.tsx`],
    ["Footer.tsx", `${AQUI}Footer.tsx`],
    ["[locale]/layout.tsx", `${APP}[locale]/layout.tsx`],
    ["[locale]/page.tsx", `${APP}[locale]/page.tsx`],
    // El límite de «no encontrado» entra en el prerender de TODO el segmento.
    ["[locale]/not-found.tsx", `${APP}[locale]/not-found.tsx`],
  ] as const) {
    it(`${nombre} no lee cookies ni cabeceras ni pregunta por la sesión en el servidor`, () => {
      const src = readFileSync(ruta, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(DINAMICO);
    });
  }

  it("la sesión del botón la decide el navegador", () => {
    const src = readFileSync(`${AQUI}NavLinks.tsx`, "utf8");
    expect(src).toMatch(/useHaySesion\(\)/);
    const hook = readFileSync(`${AQUI}useHaySesion.ts`, "utf8");
    expect(hook).toMatch(/^"use client";/);
    expect(hook).toMatch(/\.getSession\(\)/);
  });
});
