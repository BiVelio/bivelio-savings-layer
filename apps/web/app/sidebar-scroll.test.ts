/**
 * UN RAÍL FIJADO QUE NO CABE TIENE QUE PODER SCROLLEAR — y la cuenta que lo
 * garantiza vive en DOS sitios (dónde se clava y cuánto se le descuenta al
 * viewport). Esto los compara. Es la regla que privacy midió el 16-09-2026:
 * con un menú de 811px, a 1366×768 la última entrada quedaba 127px por
 * debajo del borde, inalcanzable, sin error ni síntoma.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ");
const CSS = strip(readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8"));

const block = (re: RegExp): string => {
  const m = CSS.match(re);
  if (!m) throw new Error(`no encuentro el bloque ${re}`);
  return m[1]!;
};

const DESKTOP = block(/\n\.app-nav \{([^}]*)\}/);
const MOBILE = block(/@media \(max-width: 860px\) \{[\s\S]*?\n  \.app-nav \{([^}]*)\}/);

describe("el raíl del panel", () => {
  it("se fija bajo la barra y acota su alto contra el viewport", () => {
    expect(DESKTOP).toMatch(/position:\s*sticky/);
    expect(DESKTOP).toMatch(/overflow-y:\s*auto/);
    expect(DESKTOP).toMatch(/overscroll-behavior:\s*contain/);
    expect(DESKTOP).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it("descuenta al viewport lo mismo que sube el `top`, más el respiro de abajo", () => {
    const top = DESKTOP.match(/top:\s*calc\(var\(--nav-h\) \+ (\d+)px\)/);
    const max = DESKTOP.match(/max-height:\s*calc\(100dvh - var\(--nav-h\) - (\d+)px\)/);
    expect(top).not.toBeNull();
    expect(max).not.toBeNull();
    const respiro = Number(max![1]) - Number(top![1]);
    expect(respiro).toBeGreaterThanOrEqual(8);
    expect(respiro).toBeLessThanOrEqual(20);
  });

  it("en la tira horizontal no se fija ni acota: una fila con dos scrolls es peor", () => {
    expect(MOBILE).toMatch(/position:\s*static/);
    expect(MOBILE).toMatch(/max-height:\s*none/);
    expect(MOBILE).toMatch(/overflow-x:\s*auto/);
  });

  it("el raíl mide 288px, el ancho medido en privacy para doce idiomas", () => {
    expect(CSS).toMatch(/\.app-body \{[^}]*grid-template-columns:\s*288px/);
  });
});
