// Genera apps/web/app/[locale]/paper/contenido.ts desde docs/PAPER.md.
//
// Es la fuente única del paper: el markdown del repo y la página /paper no
// pueden divergir. `pnpm paper:contenido` lo regenera; `test/paper-alineado`
// rompe el CI si alguien edita uno sin regenerar el otro.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Bloque =
  | { tipo: "h1" | "h2" | "h3" | "p" | "li" | "cita"; texto: string }
  | { tipo: "tabla"; filas: string[][] };

/** Markdown del paper (un subconjunto simple) -> bloques. */
export function generarContenido(md: string): Bloque[] {
  const bloques: Bloque[] = [];
  let parrafo: string[] = [];
  let lista: string[] = [];
  let tabla: string[][] | null = null;

  const cerrar = () => {
    if (parrafo.length) {
      bloques.push({ tipo: "p", texto: parrafo.join(" ") });
      parrafo = [];
    }
    if (lista.length) {
      for (const l of lista) bloques.push({ tipo: "li", texto: l });
      lista = [];
    }
    if (tabla) {
      bloques.push({ tipo: "tabla", filas: tabla });
      tabla = null;
    }
  };

  for (const linea of md.split("\n")) {
    const l = linea.trimEnd();
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
    const h = /^(#{1,3}) (.+)$/.exec(l);
    if (h) {
      cerrar();
      bloques.push({ tipo: h[1]!.length === 1 ? "h1" : h[1]!.length === 2 ? "h2" : "h3", texto: h[2]! });
      continue;
    }
    const li = /^[-*] (.+)$/.exec(l) ?? /^\d+\. (.+)$/.exec(l);
    if (li) {
      if (parrafo.length) {
        bloques.push({ tipo: "p", texto: parrafo.join(" ") });
        parrafo = [];
      }
      lista.push(li[1]!);
      continue;
    }
    if (l.startsWith("**") && l.endsWith("**") && l.length > 4 && parrafo.length === 0) {
      cerrar();
      bloques.push({ tipo: "p", texto: l });
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
  | { tipo: "h1" | "h2" | "h3" | "p" | "li" | "cita"; texto: string }
  | { tipo: "tabla"; filas: string[][] };

export const BLOQUES: Bloque[] = ${JSON.stringify(bloques, null, 2)};
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
