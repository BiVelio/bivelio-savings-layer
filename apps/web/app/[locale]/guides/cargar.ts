import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { leerMarkdown, type Bloque } from "@/lib/guia-migracion/markdown";

/**
 * El texto de una guía, leído de `content/` AL CONSTRUIR (las páginas son
 * `force-static`), con el mismo lector de Markdown que la guía de migración:
 * un árbol de datos que la página pinta con elementos de React, sin HTML en
 * crudo.
 *
 * - `content/<slug>.md`: el original, en inglés.
 * - `content/<idioma>/<slug>.md`: su traducción a ese idioma.
 * - `content/<idioma>/_meta.json`: el titular y la descripción traducidos de
 *   cada guía y del índice, y la entradilla del índice (`{ index: {title,
 *   description, intro, sources}, guides: {<slug>: {title, description}} }`;
 *   `sources` es Markdown en línea, con sus enlaces). La entradilla es texto
 *   del artículo, como las guías, y no de la interfaz: por eso vive aquí y
 *   no en `messages/`.
 *
 * Una guía está traducida a un idioma cuando existen LAS DOS cosas: su `.md`
 * y su entrada en `_meta.json`. Si falta cualquiera, ese idioma sirve la
 * edición inglesa con la nota de siempre (página y registro deciden con
 * `hayTraduccion`, nunca a medias: un titular traducido sobre un texto inglés
 * no se publica).
 *
 * Se busca desde `apps/web` (donde corre `next build`) y desde la raíz del
 * repositorio (donde corre vitest). Si el original no aparece, el build falla
 * en vez de publicar una página vacía.
 */
const TRAMO = ["app", "[locale]", "guides", "content"];

/** El idioma en que están escritos los originales. */
export const ORIGINAL = "en";

export interface TextoTraducido {
  title: string;
  description: string;
}

export interface IndiceTraducido extends TextoTraducido {
  /** El primer párrafo del índice. */
  intro: string;
  /** El segundo, en Markdown en línea (enlaza el banco y el repositorio). */
  sources: string;
}

export interface MetaDeIdioma {
  index?: IndiceTraducido;
  guides: Record<string, TextoTraducido>;
}

/** La carpeta `content/`, desde `apps/web` o desde la raíz del repositorio. */
export function carpetaDelContenido(desde: string = process.cwd()): string {
  const candidatos = [join(desde, ...TRAMO), join(desde, "apps", "web", ...TRAMO)];
  const hallada = candidatos.find((c) => existsSync(c));
  if (!hallada) {
    throw new Error(`guías: no encuentro la carpeta de textos (buscada en ${candidatos.join(", ")}).`);
  }
  return hallada;
}

/** La ruta del `.md` de una guía en un idioma (el original si `idioma` es el inglés). */
export function rutaDelTexto(slug: string, desde: string = process.cwd(), idioma: string = ORIGINAL): string {
  const dir = carpetaDelContenido(desde);
  const ruta = idioma === ORIGINAL ? join(dir, `${slug}.md`) : join(dir, idioma, `${slug}.md`);
  if (!existsSync(ruta)) {
    throw new Error(`guías: no encuentro el texto de «${slug}» en «${idioma}» (buscado en ${ruta}).`);
  }
  return ruta;
}

const metas = new Map<string, MetaDeIdioma | null>();

const lleno = (v: unknown) => typeof v === "string" && v.trim() !== "";

function esTexto(x: unknown): x is TextoTraducido {
  const o = x as TextoTraducido | null;
  return !!o && lleno(o.title) && lleno(o.description);
}

function esIndice(x: unknown): x is IndiceTraducido {
  const o = x as IndiceTraducido | null;
  return esTexto(o) && lleno(o.intro) && lleno(o.sources);
}

/**
 * Los titulares y descripciones traducidos de un idioma, o `null` si el idioma
 * no tiene `_meta.json`. Un `_meta.json` mal formado rompe el build: se
 * publicaría una página con el `<title>` vacío.
 */
export function metaDelIdioma(idioma: string): MetaDeIdioma | null {
  if (idioma === ORIGINAL) return null;
  if (metas.has(idioma)) return metas.get(idioma)!;
  const ruta = join(carpetaDelContenido(), idioma, "_meta.json");
  let meta: MetaDeIdioma | null = null;
  if (existsSync(ruta)) {
    const crudo = JSON.parse(readFileSync(ruta, "utf8")) as { index?: unknown; guides?: Record<string, unknown> };
    if (crudo.index !== undefined && !esIndice(crudo.index)) throw new Error(`guías: ${ruta}: «index» sin title/description/intro/sources.`);
    const guides: Record<string, TextoTraducido> = {};
    for (const [slug, v] of Object.entries(crudo.guides ?? {})) {
      if (!esTexto(v)) throw new Error(`guías: ${ruta}: «${slug}» sin title/description.`);
      guides[slug] = { title: v.title, description: v.description };
    }
    const index = crudo.index as IndiceTraducido | undefined;
    meta = { index: index && { title: index.title, description: index.description, intro: index.intro, sources: index.sources }, guides };
  }
  metas.set(idioma, meta);
  return meta;
}

/** ¿Está la guía `slug` traducida a `idioma`? (El inglés siempre lo está.) */
export function hayTraduccion(slug: string, idioma: string): boolean {
  if (idioma === ORIGINAL) return true;
  if (!metaDelIdioma(idioma)?.guides[slug]) return false;
  return existsSync(join(carpetaDelContenido(), idioma, `${slug}.md`));
}

/** ¿Está traducido el índice a `idioma`? */
export function hayIndiceTraducido(idioma: string): boolean {
  return idioma === ORIGINAL || !!metaDelIdioma(idioma)?.index;
}

const cache = new Map<string, Bloque[]>();

/**
 * Los bloques de una guía en `idioma` (una sola lectura por proceso de
 * build). Sin traducción, los del original inglés: quien llama decide con
 * `hayTraduccion` qué idioma declara la página.
 */
export function cargarTexto(slug: string, idioma: string = ORIGINAL): Bloque[] {
  const servido = hayTraduccion(slug, idioma) ? idioma : ORIGINAL;
  const clave = `${servido}/${slug}`;
  let bloques = cache.get(clave);
  if (!bloques) {
    bloques = leerMarkdown(readFileSync(rutaDelTexto(slug, process.cwd(), servido), "utf8"));
    cache.set(clave, bloques);
  }
  return bloques;
}
