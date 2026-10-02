import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rutaDeLaGuia } from "./cargar";
import { celdas, enlaces, idDeTitulo, idsDeTitulos, leerEnLinea, leerMarkdown, textoPlano, type Bloque, type EnLinea } from "./markdown";

/**
 * LA GUÍA DE MIGRACIÓN EN LA WEB (/migrate-to-0.5) ES docs/MIGRAR-A-0.5.md
 * ENTERA. El lector de Markdown es mínimo a propósito; aquí se comprueba que
 * la guía real se lee sin perder nada: los mismos títulos, bloques de código y
 * tablas que el fichero, ningún enlace interno roto y ninguna marca de Markdown
 * que se cuele como texto.
 */

const fuente = readFileSync(rutaDeLaGuia(), "utf8");
const guia = leerMarkdown(fuente);

function todos(bs: readonly Bloque[]): Bloque[] {
  return bs.flatMap((b) =>
    b.t === "cita" ? [b, ...todos(b.c)] : b.t === "lista" ? [b, ...b.items.flatMap((it) => todos(it))] : [b],
  );
}

function textos(c: readonly EnLinea[]): string[] {
  return c.flatMap((n) => (n.t === "texto" ? [n.v] : n.t === "codigo" ? [] : textos(n.c)));
}

/** Las líneas del fichero fuera de los bloques de código. */
function fueraDeCodigo(): string[] {
  const out: string[] = [];
  let dentro = false;
  for (const l of fuente.split("\n")) {
    if (/^\s*```/.test(l)) {
      dentro = !dentro;
      continue;
    }
    if (!dentro) out.push(l);
  }
  return out;
}

describe("docs/MIGRAR-A-0.5.md, leída para la web", () => {
  const bloques = todos(guia);

  it("tiene los mismos títulos que el fichero, en el mismo orden", () => {
    const delFichero = fueraDeCodigo()
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) => idDeTitulo(textoPlano(leerEnLinea(l.replace(/^#+\s+/, "")))));
    expect(delFichero.length).toBeGreaterThan(10);
    expect(idsDeTitulos(guia)).toEqual(delFichero);
  });

  it("tiene todos los bloques de código del fichero, y su contenido", () => {
    const vallas = fuente.split("\n").filter((l) => /^\s*```/.test(l)).length;
    const codigo = bloques.filter((b) => b.t === "codigo");
    expect(codigo).toHaveLength(vallas / 2);
    for (const b of codigo) if (b.t === "codigo") expect(b.v.trim().length).toBeGreaterThan(0);
  });

  it("tiene todas las tablas del fichero, con todas sus filas y el mismo número de celdas en cada una", () => {
    const lineas = fueraDeCodigo();
    const separadoras = lineas.filter((l) => /^\|\s*:?-{3,}/.test(l)).length;
    const filasDelFichero = lineas.filter((l) => l.startsWith("|")).length;
    const tablas = bloques.filter((b) => b.t === "tabla");
    expect(tablas).toHaveLength(separadoras);
    let filas = 0;
    for (const t of tablas) {
      if (t.t !== "tabla") continue;
      filas += t.filas.length + 2; // cabecera y separadora
      for (const f of t.filas) expect(f.length, textoPlano(f.flat())).toBe(t.cabecera.length);
    }
    expect(filas).toBe(filasDelFichero);
  });

  it("ningún enlace interno está roto: cada ancla apunta a un título de la guía", () => {
    const ids = new Set(idsDeTitulos(guia));
    const anclas = enlaces(guia).filter((h) => h.startsWith("#"));
    expect(anclas.length).toBeGreaterThan(0);
    for (const a of anclas) expect(ids.has(a.slice(1)), a).toBe(true);
  });

  it("no se cuela ninguna marca de Markdown como texto", () => {
    for (const b of bloques) {
      const c = b.t === "titulo" || b.t === "parrafo" ? [b.c] : b.t === "tabla" ? [...b.cabecera, ...b.filas.flat()] : [];
      for (const t of c.flatMap(textos)) {
        expect(t, t).not.toMatch(/\*\*|`|\]\(|^#{1,6}\s|^\s*[-*]\s|^>/);
      }
    }
  });

  it("la cita de estado y las listas se leen como tales", () => {
    expect(guia.some((b) => b.t === "cita")).toBe(true);
    const listas = bloques.filter((b) => b.t === "lista");
    expect(listas.some((b) => b.t === "lista" && b.ordenada)).toBe(true);
    expect(listas.some((b) => b.t === "lista" && !b.ordenada)).toBe(true);
    // El grep de «How to find what affects you» va DENTRO de un ítem de lista.
    expect(
      listas.some((b) => b.t === "lista" && b.items.some((it) => it.some((x) => x.t === "codigo" && x.v.includes("grep")))),
    ).toBe(true);
  });
});

describe("el lector de Markdown", () => {
  it("da a los títulos el id de GitHub", () => {
    expect(idDeTitulo("4. finishReason is normalised; the provider's value moves to finishReasonDetail")).toBe(
      "4-finishreason-is-normalised-the-providers-value-moves-to-finishreasondetail",
    );
    expect(idDeTitulo("What does not change")).toBe("what-does-not-change");
  });

  it("no parte una celda por un `|` dentro de código", () => {
    expect(celdas("| `stop | length` | b |")).toEqual(["`stop | length`", "b"]);
    expect(celdas("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("lee código, negrita, cursiva y enlaces, y deja los guiones bajos en paz", () => {
    expect(leerEnLinea("**Detect:** use `x` and *y*, see [here](#a). BVSALA_GATEWAY_EFFORT")).toEqual([
      { t: "negrita", c: [{ t: "texto", v: "Detect:" }] },
      { t: "texto", v: " use " },
      { t: "codigo", v: "x" },
      { t: "texto", v: " and " },
      { t: "cursiva", c: [{ t: "texto", v: "y" }] },
      { t: "texto", v: ", see " },
      { t: "enlace", href: "#a", c: [{ t: "texto", v: "here" }] },
      { t: "texto", v: ". BVSALA_GATEWAY_EFFORT" },
    ]);
  });
});
