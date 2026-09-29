import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { resumirBanco, type Banco, type InformeFuente } from "./extraer";

/**
 * Lee `docs/benchmarks/<fecha>/*.json` del repositorio y lo resume.
 *
 * Se llama al PRERENDERIZAR /benchmarks (la página es `force-static`): en el
 * build de CI y en el de Vercel el repositorio entero está en disco, y la
 * carpeta `docs/` queda dos niveles por encima de `apps/web`. Si no aparece,
 * el build falla con un mensaje claro en vez de publicar una página vacía.
 *
 * No hay lista de ficheros: un informe nuevo que entre en la carpeta (la gama
 * alta, una tirada de la 0.4.32…) aparece en la página en el siguiente build.
 */
export function carpetaDelBanco(desde: string = process.cwd()): string {
  const candidatos = [join(desde, "docs", "benchmarks"), join(desde, "..", "..", "docs", "benchmarks")];
  const hallada = candidatos.find((c) => existsSync(c) && statSync(c).isDirectory());
  if (!hallada) {
    throw new Error(
      `banco público: no encuentro docs/benchmarks (buscado en ${candidatos.join(", ")}). ` +
        "La página /benchmarks se construye a partir de esos informes; el build necesita el repositorio entero.",
    );
  }
  return hallada;
}

/** Todos los informes JSON del banco, con su ruta relativa a la raíz del repo. */
export function leerInformes(carpeta: string = carpetaDelBanco()): InformeFuente[] {
  const raiz = join(carpeta, "..", "..");
  const out: InformeFuente[] = [];
  for (const fecha of readdirSync(carpeta).sort()) {
    const dir = join(carpeta, fecha);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      out.push({ ruta: relative(raiz, p).split("\\").join("/"), json: JSON.parse(readFileSync(p, "utf8")) });
    }
  }
  return out;
}

let cache: Banco | null = null;

/** El resumen del banco (una sola lectura por proceso de build: los 12 idiomas comparten). */
export function cargarBanco(): Banco {
  cache ??= resumirBanco(leerInformes());
  return cache;
}
