import { readFileSync } from "node:fs";
import { join } from "node:path";

import katex from "katex";
import { describe, expect, it } from "vitest";

import { BLOQUES } from "@/app/[locale]/paper/contenido";

import { formulaHtml } from "./formulas";

/**
 * Cada fórmula del paper compila con KaTeX, con las MISMAS opciones con que la
 * pinta /paper al construir (throwOnError + strict): una fórmula rota rompe
 * aquí antes que en el build, y nunca llega a la web como `.katex-error`.
 */
const WEB = join(new URL(".", import.meta.url).pathname, "..", "..");
const MD = readFileSync(join(WEB, "..", "..", "docs", "PAPER.md"), "utf8");

const enLinea = (texto: string) => [...texto.matchAll(/\$`([^`]+)`\$/g)].map((m) => m[1]!);

describe("paper: las fórmulas componen con KaTeX", () => {
  it("cada ```math de PAPER.md (con su \\tag, tal como lo lee GitHub) compila en modo bloque", () => {
    const bloques = [...MD.matchAll(/^```math\n([\s\S]*?)\n```$/gm)].map((m) => m[1]!);
    expect(bloques.length).toBe(8);
    for (const latex of bloques) {
      const html = katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: "error" });
      expect(html, latex).toMatch(/class="katex-tag"/);
    }
  });

  it("cada ecuación y cada fórmula en línea de la página compila, sin .katex-error y con MathML", () => {
    const formulas: [string, boolean][] = [];
    for (const b of BLOQUES) {
      if (b.tipo === "ecuacion") formulas.push([b.latex, true]);
      else if (b.tipo === "tabla") for (const f of b.filas) for (const c of f) for (const l of enLinea(c)) formulas.push([l, false]);
      else if ("texto" in b) for (const l of enLinea(b.texto)) formulas.push([l, false]);
    }
    expect(formulas.filter(([, bloque]) => bloque).length).toBe(8);
    expect(formulas.filter(([, bloque]) => !bloque).length).toBe(64);
    for (const [latex, bloque] of formulas) {
      const html = formulaHtml(latex, bloque);
      expect(html, latex).not.toContain("katex-error");
      expect(html, latex).toContain("<math");
      expect(html, latex).toContain(bloque ? "katex-display" : "katex");
    }
  });

  it("una fórmula rota no se publica: lanza (y con ello rompe el build)", () => {
    expect(() => formulaHtml("\\frac{1}{", true)).toThrow();
    expect(() => formulaHtml("\\comandoInexistente x")).toThrow();
  });
});
