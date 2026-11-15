// EL REORDENADOR DEL PREFIJO CACHEABLE (opt-in): la otra mitad de la auditoría.
//
// La auditoría (`cache-audit.ts`) DIAGNOSTICA: dice por qué el prompt cache no
// acierta. Este módulo ARREGLA, con permiso explícito del llamante: mueve las
// líneas del `system` que contienen contenido mutable (timestamps ISO/RFC 2822,
// UUID v4, epoch ms/s) al FINAL del prompt, de modo que la parte estable quede
// delante y pueda declararse como el prefijo cacheable sin que un token mutable
// lo envenene petición tras petición.
//
// ES OPT-IN Y TRANSPARENTE, no rewriting silencioso: la doctrina de la capa dice
// que cambiar lo que el modelo lee es una decisión de calidad del llamante. Aquí
// la toma el llamante con `savings.cachePrefix: true`, y la capa:
//   1. reordena POR LÍNEAS (una línea con «Current date: 2026-…» no se puede
//      mover a medias sin romper la frase; la línea es la unidad predecible);
//   2. conserva el orden relativo de las estables y el de las mutables;
//   3. devuelve el PUNTO DE CORTE (offset) entre lo estable y lo mutable, para
//      que el pipeline declare como prefijo cacheable SOLO la parte estable
//      (el colocador ya marca el punto al final del `system` estable:
//      `prefijoEnSystem` en providers/anthropic.ts) y la cola mutable viaje
//      fuera del tramo cacheado, pagada a 1×;
//   4. el ahorro resultante es del PROVEEDOR (su caché acierta), nunca
//      acreditado como ahorro de la capa — igual que todo el prompt caching.
//
// Por qué funciona: con el token mutable DENTRO del prefijo, el emparejamiento
// por bytes falla entero en cada petición (0 % de hit y prima de escritura
// pagada siempre). Con la línea mutable FUERA, el prefijo estable acierta al
// 90 % de descuento y solo la cola corta se paga a precio completo. A un 80 % de
// hit-rate, el «90 % de descuento» del proveedor se queda en ~31 % real (informe
// de mercado de noviembre 2026): lo que decide es el HIT-RATE, y esto sube el
// hit-rate sin tocar el contenido que el modelo lee.
//
// PURA Y DETERMINISTA: sin red, sin estado, sin mutar la entrada. Reusa los
// patrones de `detectarContenidoMutable`, así que ambos módulos no divergen.

import { detectarContenidoMutable } from "./cache-audit.js";

/** Una línea movida al final, con el patrón que la delató. */
export interface LineaMovida {
  /** La línea completa, sin el separador de línea. */
  linea: string;
  /** El patrón detectado: `iso-timestamp`, `uuid-v4`, `rfc2822-date`, `epoch-millis`, `epoch-seconds`. */
  patron: string;
}

/** El resultado del reorden: el texto nuevo y dónde cortar entre estable y mutable. */
export interface ReordenDePrefijo {
  /** El texto reordenado: líneas estables delante, mutables detrás (mismo separador que la entrada). */
  texto: string;
  /**
   * Offset (caracteres) donde TERMINA la parte estable. Lo que va de `corte` en
   * adelante es la cola mutable (empieza con el separador de línea). El pipeline
   * parte el `system` por aquí y declara prefijo estable solo hasta `corte`.
   */
  corte: number;
  /** Las líneas movidas, en su orden original. */
  movidas: LineaMovida[];
  /** Patrones únicos detectados (para la traza). */
  patrones: string[];
}

/**
 * La profundidad estructural al inicio de cada línea: el balance de `{`/`[` de
 * las líneas anteriores, con las cercas de código (``` o ~~~) tratadas como
 * estructura. Sirve para ABSTENERSE: una línea mutable dentro de un bloque JSON
 * o de una cerca no se puede mover sin romper la estructura (hallazgo de la
 * revisión previa a publicación, 2026-11-15: una propiedad ISO dentro de un
 * bloque JSON multilínea deja el JSON inválido al moverla).
 */
function profundidadEstructural(lineas: string[]): number[] {
  const prof: number[] = new Array<number>(lineas.length).fill(0);
  let p = 0;
  let cerca: string | null = null;
  for (let i = 0; i < lineas.length; i++) {
    prof[i] = cerca !== null ? Math.max(1, p) : p;
    const l = lineas[i]!;
    const m = l.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (cerca === null) cerca = m[1]!;
      else if (m[1]!.startsWith(cerca[0]!) && m[1]!.length >= cerca.length) cerca = null;
      continue;
    }
    if (cerca !== null) continue;
    // Llaves/corchetes (JSON) y etiquetas XML: una apertura sube, un cierre baja.
    const aperturas = (l.match(/[{\[]/g) ?? []).length + (l.match(/<[a-zA-Z][^>]*?[^/>]\s*>/g) ?? []).length;
    const cierres = (l.match(/[}\]]/g) ?? []).length + (l.match(/<\/[a-zA-Z][^>]*>|\/>/g) ?? []).length;
    p = Math.max(0, p + aperturas - cierres);
  }
  return prof;
}

/**
 * Reordena el texto del `system` para que el prefijo cacheable quede estable:
 * las líneas con contenido mutable pasan al final.
 *
 * Devuelve `null` cuando no hay nada que hacer: sin líneas mutables, sin parte
 * estable que cachear (todo mutable o solo espacios), texto vacío, o una línea
 * mutable DENTRO de una estructura (JSON/XML/cerca de código) que se rompería
 * al moverla. En esos casos la petición debe viajar tal cual la escribió el
 * llamante.
 */
export function reordenarPrefijoCacheable(texto: string): ReordenDePrefijo | null {
  if (!texto || !texto.trim()) return null;

  // Preserva el separador de la entrada (CRLF o LF) y la línea vacía final.
  const sep = texto.includes("\r\n") ? "\r\n" : "\n";
  const lineas = texto.split(/\r\n|\n/);
  let cola = "";
  if (lineas.length > 1 && lineas[lineas.length - 1] === "") {
    cola = sep;
    lineas.pop();
  }

  // EL GUARDIA ESTRUCTURAL: la revisión previa a publicación (2026-11-15)
  // demostró que mover una línea ISO fuera de un bloque JSON multilínea deja el
  // JSON inválido. El reorden solo es seguro a profundidad estructural cero.
  const estructura = profundidadEstructural(lineas);

  const estables: string[] = [];
  const mutables: LineaMovida[] = [];
  const patrones = new Set<string>();

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]!;
    const hallazgos = detectarContenidoMutable(linea);
    if (hallazgos.length > 0) {
      if (estructura[i]! > 0) return null; // mutable dentro de JSON/XML/fence: abstenerse
      for (const h of hallazgos) patrones.add(h.patron);
      mutables.push({ linea, patron: hallazgos[0]!.patron });
    } else {
      estables.push(linea);
    }
  }

  if (mutables.length === 0) return null;
  // Sin parte estable con contenido, no hay prefijo que cachear: no reordenamos.
  if (estables.every((l) => l.trim() === "")) return null;

  const estableTexto = estables.join(sep);
  const mutableTexto = mutables.map((m) => m.linea).join(sep);
  const textoNuevo = `${estableTexto}${sep}${mutableTexto}${cola}`;

  return {
    texto: textoNuevo,
    corte: estableTexto.length,
    movidas: mutables,
    patrones: [...patrones],
  };
}
