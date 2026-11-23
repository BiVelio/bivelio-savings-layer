import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { leerMarkdown, type Bloque } from "@/lib/guia-migracion/markdown";

/**
 * El texto de una guía, leído de `content/<slug>.md` AL CONSTRUIR (las páginas
 * son `force-static`), con el mismo lector de Markdown que la guía de
 * migración: un árbol de datos que la página pinta con elementos de React, sin
 * HTML en crudo.
 *
 * Se busca desde `apps/web` (donde corre `next build`) y desde la raíz del
 * repositorio (donde corre vitest). Si el fichero no aparece, el build falla
 * en vez de publicar una página vacía.
 */
const TRAMO = ["app", "[locale]", "guides", "content"];

export function rutaDelTexto(slug: string, desde: string = process.cwd()): string {
  const candidatos = [join(desde, ...TRAMO, `${slug}.md`), join(desde, "apps", "web", ...TRAMO, `${slug}.md`)];
  const hallada = candidatos.find((c) => existsSync(c));
  if (!hallada) {
    throw new Error(`guías: no encuentro el texto de «${slug}» (buscado en ${candidatos.join(", ")}).`);
  }
  return hallada;
}

const cache = new Map<string, Bloque[]>();

/** Los bloques de una guía (una sola lectura por proceso de build). */
export function cargarTexto(slug: string): Bloque[] {
  let bloques = cache.get(slug);
  if (!bloques) {
    bloques = leerMarkdown(readFileSync(rutaDelTexto(slug), "utf8"));
    cache.set(slug, bloques);
  }
  return bloques;
}
