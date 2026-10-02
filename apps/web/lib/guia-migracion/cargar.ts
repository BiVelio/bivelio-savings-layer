import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { leerMarkdown, type Bloque } from "./markdown";

/**
 * La guía de migración 0.4 → 0.5 que se publica en /<idioma>/migrate-to-0.5.
 *
 * Se lee de `docs/MIGRAR-A-0.5.md` AL CONSTRUIR (la página es `force-static`),
 * igual que /benchmarks lee `docs/benchmarks/`: una sola fuente, la misma que
 * vigila test/api-publica-congelada.test.ts, y ninguna copia que pueda
 * desviarse. Si el fichero no aparece, el build falla en vez de publicar una
 * página vacía.
 */
export const FICHERO_DE_LA_GUIA = "MIGRAR-A-0.5.md";

export function rutaDeLaGuia(desde: string = process.cwd()): string {
  const candidatos = [join(desde, "docs", FICHERO_DE_LA_GUIA), join(desde, "..", "..", "docs", FICHERO_DE_LA_GUIA)];
  const hallada = candidatos.find((c) => existsSync(c));
  if (!hallada) {
    throw new Error(
      `guía de migración: no encuentro docs/${FICHERO_DE_LA_GUIA} (buscado en ${candidatos.join(", ")}). ` +
        "La página /migrate-to-0.5 se construye a partir de ese fichero; el build necesita el repositorio entero.",
    );
  }
  return hallada;
}

let cache: Bloque[] | null = null;

/** La guía leída (una sola lectura por proceso de build: los 12 idiomas comparten). */
export function cargarGuia(): Bloque[] {
  cache ??= leerMarkdown(readFileSync(rutaDeLaGuia(), "utf8"));
  return cache;
}
