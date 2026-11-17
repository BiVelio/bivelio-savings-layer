// Genera apps/web/app/[locale]/paper/contenido.ts desde docs/PAPER.md.
//
// Es la fuente única del paper: el markdown del repo y la página /paper no
// pueden divergir. `pnpm paper:contenido` lo regenera; `test/paper-alineado`
// rompe el CI si alguien edita uno sin regenerar el otro.
//
// La página pinta la cabecera académica (título, autores, afiliación, fecha)
// desde constantes y este generador empieza en «## Abstract»: el front matter
// del markdown (título, autor, «supersedes», reglas) no se duplica en el cuerpo.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Bloque =
  | { tipo: "h2" | "h3" | "p" | "cita"; texto: string; id?: string }
  | { tipo: "li"; texto: string; ordenada: boolean }
  | { tipo: "tabla"; filas: string[][] }
  | { tipo: "ecuacion"; latex: string; numero?: string }
  | { tipo: "hr" };

// LAS FÓRMULAS son el LaTeX OFICIAL de docs/paper/main.tex, en la sintaxis que
// también pinta GitHub: en bloque, «```math … \tag{n} ```» (n = el número que
// lleva en el PDF); en línea, «$`…`$» (nunca «$…$» suelto: el texto lleva
// importes en dólares). El bloque se separa aquí en { latex, numero }; la
// matemática en línea viaja dentro del texto y la página la compone con KaTeX
// en el servidor al construir.

/** Delimitadores de la matemática en línea (sintaxis de GitHub). */
export const MATEMATICA_EN_LINEA = /\$`([^`]+)`\$/g;

/**
 * Cada «$`» abre una fórmula que cierra un «`$» en el MISMO bloque. Un
 * delimitador huérfano pintaría LaTeX crudo en la web, así que se rompe aquí.
 */
export function comprobarEnLinea(texto: string): void {
  const resto = texto.replace(MATEMATICA_EN_LINEA, "");
  if (resto.includes("$`") || resto.includes("`$")) {
    throw new Error(`docs/PAPER.md: matemática en línea sin cerrar en «${texto.slice(0, 80)}…»`);
  }
}

/** Cuerpo de un «```math» -> { latex, numero }: el \tag{n} se pinta aparte, a la derecha. */
export function ecuacion(lineas: string[]): Extract<Bloque, { tipo: "ecuacion" }> {
  const fuente = lineas.join("\n");
  const tags = [...fuente.matchAll(/\\tag\{([^}]+)\}/g)];
  if (tags.length > 1) throw new Error(`docs/PAPER.md: ecuación con ${tags.length} \\tag: ${fuente}`);
  const latex = fuente.replace(/\\tag\{[^}]+\}/, "").trim();
  if (!latex) throw new Error("docs/PAPER.md: bloque ```math vacío");
  return tags[0] ? { tipo: "ecuacion", latex, numero: tags[0][1]! } : { tipo: "ecuacion", latex };
}

/** Cabecera del paper: lo que la página pinta como bloque de título. */
export const CABECERA = {
  coleccion: "BV-SALA Savings Layer",
  titulo: "Verifiable Measurement of Cost Savings in Large Language Model Applications",
  subtitulo: "Open-Core Edition",
  autor: "Joan-Marc Fisa",
  afiliacion: "Founder, BiVelio Inc",
  email: "jmfisa@bivelio.com",
  fecha: "November 2026",
  version: "Preprint v2.3-r1 · open-core release 1.2.0",
} as const;

/** Slug estable para anclar una sección (`#3-system-model-and-accounting-object`). */
export function ancla(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Markdown del paper (un subconjunto simple) -> bloques. */
export function generarContenido(md: string): Bloque[] {
  const bloques: Bloque[] = [];
  let parrafo: string[] = [];
  let lista: string[] = [];
  let ordenada = false;
  let tabla: string[][] | null = null;
  let empezado = false;
  /** Líneas de un bloque ```math abierto (null: no hay ninguno). */
  let formula: string[] | null = null;

  const cerrar = () => {
    if (parrafo.length) {
      bloques.push({ tipo: "p", texto: parrafo.join(" ") });
      parrafo = [];
    }
    if (lista.length) {
      for (const l of lista) bloques.push({ tipo: "li", texto: l, ordenada });
      lista = [];
    }
    if (tabla) {
      bloques.push({ tipo: "tabla", filas: tabla });
      tabla = null;
    }
  };

  for (const linea of md.split("\n")) {
    const l = linea.trimEnd();

    if (formula) {
      if (l === "```") {
        bloques.push(ecuacion(formula));
        formula = null;
      } else formula.push(l);
      continue;
    }

    // El cuerpo empieza en la sección Abstract: el front matter no se pinta.
    if (!empezado) {
      if (/^## Abstract\s*$/.test(l)) empezado = true;
      else continue;
    }

    // Ecuación en bloque. Ningún otro bloque cercado está soportado: antes se
    // colaba como texto y las fórmulas acababan pintadas como código.
    if (l.startsWith("```")) {
      if (l !== "```math") throw new Error(`docs/PAPER.md: bloque cercado no soportado: «${l}»`);
      cerrar();
      formula = [];
      continue;
    }

    // Regla horizontal: se conserva como separador semántico.
    if (/^---+$/.test(l)) {
      cerrar();
      bloques.push({ tipo: "hr" });
      continue;
    }

    if (/^\|/.test(l)) {
      const celdas = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (celdas.every((c) => /^:?-{3,}:?$/.test(c) || c === "")) continue;
      if (!tabla) {
        cerrar();
        tabla = [];
      }
      tabla.push(celdas);
      continue;
    }
    if (tabla) cerrar();
    if (l === "") {
      cerrar();
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(l);
    if (h) {
      cerrar();
      const texto = h[2]!;
      bloques.push({ tipo: h[1]!.length === 2 ? "h2" : "h3", texto, id: ancla(texto) });
      continue;
    }
    const ordenadaLi = /^\d+\. (.+)$/.exec(l);
    const bullet = /^[-*] (.+)$/.exec(l);
    if (ordenadaLi || bullet) {
      if (parrafo.length) {
        bloques.push({ tipo: "p", texto: parrafo.join(" ") });
        parrafo = [];
      }
      // Un cambio de tipo de lista cierra la anterior.
      if (lista.length > 0 && ordenada !== Boolean(ordenadaLi)) {
        for (const l2 of lista) bloques.push({ tipo: "li", texto: l2, ordenada });
        lista = [];
      }
      ordenada = Boolean(ordenadaLi);
      lista.push((ordenadaLi ?? bullet)![1]!);
      continue;
    }
    parrafo.push(l);
  }
  cerrar();
  if (formula) throw new Error("docs/PAPER.md: bloque ```math sin cerrar");
  for (const b of bloques) {
    if ("texto" in b) comprobarEnLinea(b.texto);
    if (b.tipo === "tabla") for (const fila of b.filas) for (const celda of fila) comprobarEnLinea(celda);
  }
  return bloques;
}

/** El contenido EXACTO del módulo generado (lo que se escribe y lo que el test compara). */
export function renderModulo(bloques: Bloque[]): string {
  return `// GENERADO desde docs/PAPER.md — no editar a mano (ver scripts/paper.ts).
export type Bloque =
  | { tipo: "h2" | "h3" | "p" | "cita"; texto: string; id?: string }
  | { tipo: "li"; texto: string; ordenada: boolean }
  | { tipo: "tabla"; filas: string[][] }
  | { tipo: "ecuacion"; latex: string; numero?: string }
  | { tipo: "hr" };

export const BLOQUES: Bloque[] = ${JSON.stringify(bloques, null, 2)};

export const CABECERA = ${JSON.stringify(CABECERA, null, 2)} as const;
`;
}

/** Ruta del markdown fuente y del módulo destino, desde la raíz del repo. */
export const RUTAS = {
  md: "docs/PAPER.md",
  modulo: "apps/web/app/[locale]/paper/contenido.ts",
} as const;

// CLI: `pnpm paper:contenido`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
  const md = readFileSync(join(raiz, RUTAS.md), "utf8");
  const bloques = generarContenido(md);
  writeFileSync(join(raiz, RUTAS.modulo), renderModulo(bloques));
  console.log(`escrito ${RUTAS.modulo} (${bloques.length} bloques)`);
}
