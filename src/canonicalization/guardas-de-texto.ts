// Guardas deterministas de texto: los DATOS que ni la caché semántica ni la
// compresión pueden dejar cambiar en silencio — números/fechas y paridad de
// negación. Una sola fuente de verdad, porque viven en dos sitios:
//
//   · la caché semántica (`cache/semantic.ts`, `keyTokensMatch`): un embedding es
//     ciego a «100 vs 200», a «seguro vs NO seguro» y a «Norte vs Sur»; esta
//     guarda corre por debajo y corta antes de servir una respuesta invertida.
//   · la compresión (`compression/compression.ts`, `compresorFiel`): un compresor
//     que se come un «not» o una cifra devuelve un texto MÁS CORTO y de sentido
//     contrario; el mismo criterio lo rechaza.
//
// La lista de negaciones era SOLO inglesa y vivía en semantic.ts, así que «factura
// sin IVA» ↔ «factura con IVA» pasaba (ambas con 0 negaciones: «sin» era stopword,
// no negación) y la compresión no tenía ninguna guarda de negación. Centralizarla
// aquí, con es/ca, cierra los dos agujeros a la vez.
//
// Comentarios en `//` y no JSDoc: nada de esto viaja al `.d.ts` como API con
// documentación (son helpers internos), pero se mantiene la disciplina del repo.

/**
 * Palabras de negación en inglés, castellano y catalán. La paridad de negación
 * las cuenta; cambiar de N a M negaciones entre dos textos es un cambio de
 * significado, no una paráfrasis ni una compresión válida.
 */
export const NEGACIONES = new Set([
  // inglés
  "no", "not", "never", "none", "cannot", "cant", "without", "nor", "nt", "isnt",
  "arent", "wasnt", "werent", "dont", "doesnt", "didnt", "wont", "shouldnt",
  // castellano
  "sin", "nunca", "jamas", "tampoco", "ni", "ningun", "ninguna", "ninguno",
  "nada", "nadie",
  // catalán
  "sense", "mai", "tampoc", "cap", "gens", "ningu", "res",
]);

/** Números, horas y fechas del texto, como multiconjunto (100, 12:30, 20/07/2026). */
export function tokensNumericos(s: string): string[] {
  return (s.match(/\d[\d.,:/-]*/g) ?? []).map((t) => t.replace(/[.,:/-]+$/, ""));
}

/** Igualdad de multiconjuntos: mismos elementos con las mismas repeticiones. */
export function multisetIgual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const y of b) {
    const c = counts.get(y);
    if (!c) return false;
    counts.set(y, c - 1);
  }
  return true;
}

/** Palabras no vacías separadas por espacios. */
export function palabras(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Cuántas negaciones hay en una lista de palabras (ya en minúsculas). */
export function contarNegaciones(tokens: readonly string[]): number {
  return tokens.filter((t) => NEGACIONES.has(t.replace(/'/g, "")) || t.endsWith("n't")).length;
}

/**
 * Colapsa líneas DUPLICADAS (por contenido, ignorando espacios de borde),
 * conservando la primera. Deja la comprobación de datos críticos invariante frente
 * a la deduplicación de líneas repetidas —una compresión legítima y frecuente en
 * hilos y plantillas—: quitar la segunda copia de una línea con un número o una
 * negación no altera el significado, y sin este colapso el multiconjunto de
 * números cambiaría y la verja rechazaría una compresión válida.
 */
function lineasDistintas(s: string): string {
  const vistas = new Set<string>();
  const salida: string[] = [];
  for (const l of s.split("\n")) {
    const clave = l.trim();
    if (clave && vistas.has(clave)) continue;
    if (clave) vistas.add(clave);
    salida.push(l);
  }
  return salida.join("\n");
}

/**
 * ¿Dos textos conservan los mismos DATOS CRÍTICOS —números/fechas y paridad de
 * negación—? No exige solape de contenido (la compresión sí quita palabras de
 * relleno, y debe poder), solo que no se haya alterado un número ni invertido una
 * negación. Es la guarda que hace no-vacua la comprobación de fidelidad de la
 * compresión.
 *
 * Se compara sobre las LÍNEAS DISTINTAS de cada texto, de modo que la
 * deduplicación de líneas repetidas es transparente (quitar una copia de una línea
 * con un número no cambia nada) pero una REESCRITURA que invierte una negación o
 * cambia una cifra en una línea sí se caza.
 */
export function mismosDatosCriticos(a: string, b: string): boolean {
  const da = lineasDistintas(a);
  const db = lineasDistintas(b);
  if (!multisetIgual(tokensNumericos(da), tokensNumericos(db))) return false;
  const na = contarNegaciones(palabras(da.toLowerCase()));
  const nb = contarNegaciones(palabras(db.toLowerCase()));
  return na === nb;
}
