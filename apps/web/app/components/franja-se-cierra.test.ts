import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LA ✕ DE LA FRANJA NEGRA CIERRA (2026-11-17).
 *
 * `.announce-close` se centraba con `top: 50%; transform: translateY(-50%)`, y
 * el hundido de pulsar (`:active { transform: translateY(1px) }`, o `none` con
 * movimiento reducido) pisaba esa transformación: al apretar, el botón bajaba
 * ~18px, se soltaba sobre la franja, el `click` caía en `.announce` y la barra
 * no se cerraba nunca — tampoco en producción. Se centra sin `transform`.
 */
const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Los cuerpos de todas las reglas (también dentro de @media) con ese selector en su lista. */
const reglas = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]);

describe("la franja de anuncio", () => {
  it("la ✕ no se coloca con transform, que el hundido de pulsar sobreescribe", () => {
    const base = reglas(".announce-close");
    expect(base.length).toBeGreaterThan(0);
    for (const cuerpo of base) expect(cuerpo).not.toMatch(/(^|;|\s)transform\s*:/);
  });

  it("el hundido de pulsar sigue existiendo (la causa no se arregla quitándolo)", () => {
    expect(reglas(".announce-close:active").join(";")).toMatch(/transform\s*:\s*translateY\(1px\)/);
  });
});
