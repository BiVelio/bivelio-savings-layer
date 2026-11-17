import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generarContenido, MATEMATICA_EN_LINEA, renderModulo, RUTAS } from "../scripts/paper.js";

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
    expect(contenido).toContain("export const CABECERA");
    const bloques = generarContenido(readFileSync(raiz(RUTAS.md), "utf8"));
    // La cabecera académica sale de CABECERA: el cuerpo empieza en «Abstract»
    // y no repite el título (nada de h1 en el cuerpo).
    expect(bloques[0]).toMatchObject({ tipo: "h2", id: "abstract" });
    expect(bloques.some((b) => (b as { tipo: string }).tipo === "h1")).toBe(false);
    expect(bloques.length).toBeGreaterThan(40);
    expect(bloques.filter((b) => b.tipo === "tabla").length).toBeGreaterThanOrEqual(2);
    expect(bloques.filter((b) => b.tipo === "h2").length).toBeGreaterThanOrEqual(8);
    // Las listas numeradas de la hoja de ruta existen como tales.
    expect(bloques.some((b) => b.tipo === "li" && b.ordenada)).toBe(true);
    // Los anclas de sección son estables y sin acentos.
    for (const b of bloques) {
      if (b.tipo === "h2" || b.tipo === "h3") expect(b.id, b.texto).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("el paper publica sus cifras con intervalo y sus límites", () => {
    const md = readFileSync(raiz(RUTAS.md), "utf8");
    for (const t of ["31.50", "75.08", "2.49", "95 ", "measured", "reference", "estimated", "Limitations"]) {
      expect(md, t).toContain(t);
    }
    // El apéndice en español viaja con el paper.
    expect(md).toContain("Resumen en español");
  });
});

/**
 * LAS FÓRMULAS SON LAS DEL PDF. `docs/paper/main.tex` es el LaTeX oficial (el
 * que compila el PDF publicado); PAPER.md lleva EXACTAMENTE esas fórmulas, en
 * la sintaxis que pinta GitHub: «```math … \tag{n} ```» en bloque y «$`…`$» en
 * línea. Antes eran imitaciones Unicode («Σ_{k ∈ …}», «10⁻⁶», «R̂_pooled») en
 * bloques de código, y su numeración no era la del PDF.
 */
const TEX = "docs/paper/main.tex";
const normalizar = (latex: string) => latex.replace(/\s+/g, " ").trim();
const sinComentarios = (tex: string) => tex.replace(/(?<!\\)%.*$/gm, "");

/** Las ecuaciones numeradas de main.tex, en orden: { latex, label, numero }. */
function ecuacionesTex() {
  const tex = sinComentarios(readFileSync(raiz(TEX), "utf8"));
  let n = 0;
  return [...tex.matchAll(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g)].map((m) => {
    const cuerpo = m[1]!;
    const numerada = !/\\(?:nonumber|notag)\b/.test(cuerpo);
    return {
      latex: normalizar(cuerpo.replace(/\\label\{[^}]*\}/g, "").replace(/\\(?:nonumber|notag)\b/g, "")),
      label: /\\label\{([^}]*)\}/.exec(cuerpo)?.[1],
      numero: numerada ? String(++n) : undefined,
    };
  });
}

/** Las ```math de PAPER.md, en orden: { latex sin \tag, numero del \tag }. */
function ecuacionesMd(md: string) {
  return [...md.matchAll(/^```math\n([\s\S]*?)\n```$/gm)].map((m) => ({
    crudo: m[1]!,
    latex: normalizar(m[1]!.replace(/\\tag\{[^}]*\}/g, "")),
    numero: /\\tag\{([^}]*)\}/.exec(m[1]!)?.[1],
  }));
}

/** PAPER.md sin matemática: ni ```math ni $`…`$. Lo que queda es prosa y código. */
const sinMatematica = (md: string) => md.replace(/^```math\n[\s\S]*?\n```$/gm, "").replace(MATEMATICA_EN_LINEA, "");

describe("paper: las fórmulas son el LaTeX oficial de main.tex, con la numeración del PDF", () => {
  const md = readFileSync(raiz(RUTAS.md), "utf8");

  it("cada ecuación en bloque es la de main.tex, en el mismo orden y con el mismo número", () => {
    const tex = ecuacionesTex();
    const enMd = ecuacionesMd(md);
    expect(tex.length).toBe(8);
    expect(enMd.map((e) => e.latex)).toEqual(tex.map((e) => e.latex));
    expect(enMd.map((e) => e.numero)).toEqual(tex.map((e) => e.numero));
    // Un \tag por ecuación numerada, ni uno más.
    for (const e of enMd) expect(e.crudo.match(/\\tag\{/g)?.length ?? 0, e.crudo).toBe(e.numero ? 1 : 0);
  });

  it("cada fórmula en línea es la de main.tex, en el mismo orden ($…$ del LaTeX = $`…`$ del markdown)", () => {
    const tex = sinComentarios(readFileSync(raiz(TEX), "utf8")).replaceAll("\\$", "");
    const enTex = [...tex.matchAll(/\$([^$]+)\$/g)].map((m) => m[1]!);
    const enMd = [...md.matchAll(MATEMATICA_EN_LINEA)].map((m) => m[1]!);
    expect(enTex.length).toBeGreaterThan(60);
    expect(enMd).toEqual(enTex);
  });

  it("«Equation (n)» del texto dice el número que lleva esa ecuación en el PDF", () => {
    const numeroDe = new Map(ecuacionesTex().map((e) => [e.label, e.numero]));
    const tex = sinComentarios(readFileSync(raiz(TEX), "utf8"));
    const enTex = [...tex.matchAll(/Equation~?\(\\ref\{([^}]+)\}\)/g)].map((m) => numeroDe.get(m[1]!));
    const enMd = [...md.matchAll(/Equation \((\d+)\)/g)].map((m) => m[1]);
    expect(enTex.length).toBeGreaterThan(0);
    expect(enTex).not.toContain(undefined);
    expect(enMd).toEqual(enTex);
  });

  it("no queda ninguna imitación Unicode de fórmula fuera de $`…`$ / ```math (tampoco en `código`)", () => {
    const resto = sinMatematica(md);
    const imitaciones: [string, RegExp][] = [
      ["letra griega o sumatorio", /[ΣΔ∆πρδσμ∑]/u],
      ["superíndice Unicode", /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/u],
      ["acento combinado (R̂)", /̂/u],
      ["suelo/techo, pertenencia, prima o menos matemático", /[⌊⌋⌈⌉∈∉′−≤≥≠×]/u],
      ["subíndice con llaves", /_\{/],
      ["subíndice de una letra (C_00, b_f, x_e)", /(?<![\w./-])[A-Za-z]_[A-Za-z0-9]/],
      ["potencia con paréntesis", /\^\(/],
    ];
    for (const [nombre, re] of imitaciones) {
      const lineas = resto.split("\n").filter((l) => re.test(l));
      expect(lineas, nombre).toEqual([]);
    }
  });

  it("no hay $…$ suelto ni bloques de código sin lenguaje: todo «$» que queda es un importe", () => {
    const resto = sinMatematica(md).replaceAll("\\$", "");
    expect(resto.match(/\$(?!\d)/g) ?? []).toEqual([]);
    // Las vallas van por parejas «```math» / «```»: ningún bloque de código suelto.
    const vallas = md.split("\n").filter((l) => l.startsWith("```"));
    expect(vallas.length % 2).toBe(0);
    vallas.forEach((v, i) => expect(v, `valla ${i + 1}`).toBe(i % 2 === 0 ? "```math" : "```"));
  });

  it("en una línea con fórmulas, el «$» de un importe va escapado (si no, GitHub lo empareja)", () => {
    for (const linea of md.split("\n")) {
      if (!linea.includes("$`")) continue;
      const resto = linea.replace(MATEMATICA_EN_LINEA, "").replaceAll("\\$", "");
      expect(resto.includes("$"), linea).toBe(false);
    }
  });

  it("el generador hace de cada ```math un bloque { latex, numero } y rompe con delimitadores huérfanos", () => {
    const ecuaciones = generarContenido(md).filter((b) => b.tipo === "ecuacion");
    expect(ecuaciones.map((e) => e.numero)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    for (const e of ecuaciones) expect(e.latex).not.toMatch(/\\tag|\\label/);
    const base = "## Abstract\n\n";
    expect(() => generarContenido(`${base}Una $\`x fórmula sin cerrar.`)).toThrow(/sin cerrar/);
    expect(() => generarContenido(`${base}\`\`\`math\nx\n`)).toThrow(/sin cerrar/);
    expect(() => generarContenido(`${base}\`\`\`\nC_e = 10⁻⁶\n\`\`\``)).toThrow(/no soportado/);
    expect(generarContenido(`${base}\`\`\`math\na=b\n\\tag{9}\n\`\`\``)).toContainEqual({ tipo: "ecuacion", latex: "a=b", numero: "9" });
  });
});
