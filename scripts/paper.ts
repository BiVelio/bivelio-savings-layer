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
  | { tipo: "hr" };

/** Cabecera del paper: lo que la página pinta como bloque de título. */
export const CABECERA = {
  coleccion: "BV-SALA Savings Layer",
  titulo: "Verifiable Measurement of Cost Savings in Large Language Model Applications",
  subtitulo: "Open-Core Edition",
  autor: "Joan-Marc Fisa",
  afiliacion: "Founder, BiVelio Inc",
  email: "jmfisa@bivelio.com",
  fecha: "November 2026",
  version: "Preprint v2.1 · open-core release 1.0.0",
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

    // El cuerpo empieza en la sección Abstract: el front matter no se pinta.
    if (!empezado) {
      if (/^## Abstract\s*$/.test(l)) empezado = true;
      else continue;
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
  return bloques;
}

/** El contenido EXACTO del módulo generado (lo que se escribe y lo que el test compara). */
export function renderModulo(bloques: Bloque[]): string {
  return `// GENERADO desde docs/PAPER.md — no editar a mano (ver scripts/paper.ts).
export type Bloque =
  | { tipo: "h2" | "h3" | "p" | "cita"; texto: string; id?: string }
  | { tipo: "li"; texto: string; ordenada: boolean }
  | { tipo: "tabla"; filas: string[][] }
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
