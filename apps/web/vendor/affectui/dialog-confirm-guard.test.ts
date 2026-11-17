import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LA CONFIRMACIÓN NO SE PULSA SOLA. En el móvil el AlertDialog sube como hoja
 * desde abajo (320 ms) con «Sí, revocar» donde ya está el dedo: el segundo
 * toque de un doble toque sobre «Revocar» caía en el botón de confirmar antes
 * de que hubiera nada que leer. Revocar una clave, quitar a un miembro y
 * transferir la propiedad pasan por ese botón.
 *
 * Se lee el fuente (la pieza importa su CSS y vive en cliente): la regla es
 * una función pura declarada en el mismo fichero, y aquí se evalúa tal cual.
 */
const fuente = readFileSync(join(__dirname, "dialog.tsx"), "utf8");
const hoja = readFileSync(join(__dirname, "dialog.css"), "utf8");

const guarda = Number(/export const CONFIRM_GUARD_MS = (\d+);/.exec(fuente)?.[1]);
const cuerpo = /export function confirmIsDeliberate\(openedAt: number, now: number\): boolean \{\n\s*return ([^;]+);\n\}/.exec(fuente)?.[1] ?? "";
const confirmIsDeliberate = new Function("CONFIRM_GUARD_MS", "openedAt", "now", `return ${cuerpo};`).bind(null, guarda) as (
  openedAt: number,
  now: number,
) => boolean;

describe("AlertDialog — guarda contra el toque fantasma", () => {
  it("la guarda dura más que la entrada de la hoja y que un doble toque", () => {
    const entradas = [...hoja.matchAll(/animation: ui-dlgc-(?:sheet-in|in) (\d+)ms/g)].map((m) => Number(m[1]));
    expect(entradas.length).toBeGreaterThanOrEqual(2);
    expect(guarda).toBeGreaterThanOrEqual(Math.max(...entradas));
    expect(guarda).toBeGreaterThanOrEqual(400);
    expect(guarda).toBeLessThanOrEqual(600);
  });

  it("confirmar nada más abrir no cuenta; pasado el margen, sí", () => {
    expect(cuerpo).not.toBe("");
    expect(confirmIsDeliberate(1000, 1000)).toBe(false);
    expect(confirmIsDeliberate(1000, 1000 + guarda - 1)).toBe(false);
    expect(confirmIsDeliberate(1000, 1000 + guarda)).toBe(true);
    expect(confirmIsDeliberate(1000, 60_000)).toBe(true);
    // Cerrado (nunca abierto): no hay nada que confirmar.
    expect(confirmIsDeliberate(Number.NEGATIVE_INFINITY, 5000)).toBe(false);
  });

  it("el botón de confirmar pasa por la guarda antes de ejecutar nada", () => {
    const confirmar = fuente.slice(fuente.indexOf("const confirm = async () => {"), fuente.indexOf("const result = onConfirm?.();"));
    expect(confirmar).toMatch(/if \(busy\) return;/);
    expect(confirmar).toMatch(/if \(!confirmIsDeliberate\(openedAt\.current, performance\.now\(\)\)\) return;/);
    expect(fuente).toMatch(/openedAt\.current = isOpen \? performance\.now\(\) : Number\.NEGATIVE_INFINITY;/);
  });
});
