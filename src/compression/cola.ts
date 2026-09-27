import type { ChatMessage } from "../contracts/types.js";

// LA COMPACTACIÓN DE LA COLA: quitar a la salida de una herramienta lo que no
// es información (secuencias de color, estados intermedios de una barra de
// progreso, sangría de un JSON, repeticiones literales consecutivas) SIN tocar
// el prefijo que el proveedor ya tiene en caché.
//
// (Los comentarios de este fichero van en `//`: lo exportado viaja al `.d.ts`
// publicado, y ahí un bloque JSDoc se publica entero. El JSDoc, en inglés, es
// el contrato; el porqué, aquí.)
//
// LA LEY QUE MANDA SOBRE TODO LO DEMÁS. En un bucle de agente el cliente
// reenvía el historial entero cada turno y el proveedor lo lee de su caché de
// prefijo a 0,1× (0,05× en Opus 5.5, 0,025× en Fable 5.1). Lo NUEVO del turno
// se escribe a 1,25× (2× con TTL de 1 h). Reescribir un bloque que ya estaba en
// la caché convierte TODO lo posterior en escritura: cada token que pasa de
// lectura a escritura cuesta 12,5× (5 min) o 20× (1 h) lo que costaba —25-80×
// con las lecturas más baratas—. De ahí las tres mediciones independientes de
// 2026 que ven menos tokens y MÁS factura (Barker/Headroom: 123 invalidaciones;
// Quesma/RTK: +17 % en DeepSeek; «Token Reduction Is Not Cost Reduction»:
// −38,4 % de tokens, +6,8 % de coste) y el replay del corpus propio
// (`benchmarks/evidencia/sombra-corpus-2026-09-07-reparto.json`): v0 −16,7 %,
// v1 +0,4 % con 51,8 $ de invalidación pagada.
//
// POR ESO LA DECISIÓN ES FUNCIÓN PURA DEL CONTENIDO, y no de la edad, la
// posición, el tamaño del prompt ni el modelo. Un tool_result se compacta el
// turno en que NACE (cola: se escribe en caché de todas formas) y, como la
// función es determinista, cada turno posterior produce los MISMOS bytes: el
// prefijo que el proveedor guardó sigue siendo byte a byte el que recibe. Lo
// que mató a v0/v1 fue cambiar de opinión sobre un bloque ya cacheado (v1
// eximía el último tool_result y lo reducía al turno siguiente); aquí no hay
// opinión que cambiar. Por la misma razón NO hay memoria entre peticiones: en
// serverless dos turnos seguidos caen en instancias distintas, y una decisión
// que dependiera de lo que «recuerda» la instancia rompería el prefijo en cada
// salto. La pureza sobrevive a los reinicios; la memoria, no.
//
// EL ÚNICO CASO QUE ROMPE: encenderla A MITAD de una conversación. El primer
// turno con la palanca encendida compacta también el historial que salió sin
// compactar, y paga una invalidación desde el primer bloque compactable. Es una
// vez por conversación y está medido en el banco en seco (brazo
// «encendida a mitad»). Se documenta; no se esconde.
//
// FIDELIDAD, TRANSFORMACIÓN A TRANSFORMACIÓN. Nada aquí resume, poda palabras
// ni adivina qué es relevante —el camino que JetBrains y Quesma midieron como
// turnos extra y factura mayor—. Cuatro transformaciones, cada una con su
// comprobación:
//
//  · `json`: sólo si el texto ENTERO es JSON. Se quita el espacio entre tokens
//    léxicos y NADA más: las cadenas y los literales numéricos salen byte a byte
//    (no se reserializa, así que un id de 20 dígitos no pierde precisión). Se
//    exige `JSON.parse(compacto)` ≡ `JSON.parse(original)`.
//  · `repeated-lines`: una racha de líneas IDÉNTICAS consecutivas pasa a la
//    primera más un marcador con la cuenta. Reversible: se exige que
//    `expandirRepeticiones(compacto) === original`. Si el original ya contiene
//    algo con forma de marcador, no se toca (sería ambiguo).
//  · `ansi`: secuencias de escape de terminal (color, cursor, títulos). No son
//    texto visible; se exige que lo que queda sea exactamente el original sin
//    ellas.
//  · `carriage-return`: una línea con `\r` se sustituye por lo que un terminal
//    ENSEÑA (cada segmento pisa al anterior desde la columna 0). Se pierden los
//    estados intermedios de una barra de progreso, no el estado final. Si hay
//    `\r\n` en el texto no se toca: es un fichero con finales de Windows, no una
//    barra.
//
// LO QUE NO SE TOCA NUNCA: la salida de una llamada que nombra un FICHERO
// (`path`, `file_path`…). Un agente que edita por coincidencia exacta copia el
// texto que leyó; si leyó un `package.json` compactado, su `old_string` no casa
// con el disco y el intento falla — exactamente el «broken rewrite» que
// JetBrains midió como coste. Tampoco se tocan `system`, `user` ni `assistant`:
// sólo `role: "tool"`.

/** A deterministic, content-only transformation applied to a tool output. */
export type CompactionTransform = "ansi" | "carriage-return" | "json" | "repeated-lines";

/** Every transformation, in the order they are applied. */
export const COMPACTION_TRANSFORMS: readonly CompactionTransform[] = [
  "ansi",
  "carriage-return",
  "json",
  "repeated-lines",
];

/**
 * How tool outputs are compacted. Every field is optional.
 *
 * The decision for each tool output depends only on its own text and the tool
 * call that produced it — never on its position, the size of the prompt or the
 * model — so an output compacted when it first arrives is re-sent with the same
 * bytes on every later turn and the provider's prefix cache keeps matching.
 * Change these settings between conversations, not in the middle of one: a
 * change rewrites outputs the provider has already cached.
 */
export interface ToolOutputCompactionSettings {
  /** Which transformations may run. Default: all of {@link COMPACTION_TRANSFORMS}. */
  transforms?: readonly CompactionTransform[];
  /**
   * Leave an output verbatim unless compaction removes at least this many
   * characters (default 256). Small gains are not worth changing the text the
   * model sees.
   */
  minSavedChars?: number;
  /** Tool names whose outputs are never compacted. */
  exceptTools?: readonly string[];
  /**
   * Also compact outputs of tool calls whose arguments name a file (`path`,
   * `file_path`, `filename`…). Default `false`: an agent that edits files by
   * exact string match copies what it read, and a compacted view of a file
   * would not match the file on disk.
   */
  compactFileViews?: boolean;
}

/** The outcome of compacting one tool output. */
export interface ToolOutputCompaction {
  /** The text to send: compacted when `changed`, otherwise the input as-is. */
  text: string;
  changed: boolean;
  /** Transformations that changed the text, in the order they ran. */
  applied: CompactionTransform[];
  originalChars: number;
  compactChars: number;
  /** Why the output was, or was not, compacted. */
  reason: string;
}

/** Default minimum saving, in characters, for an output to be compacted. */
export const DEFAULT_MIN_SAVED_CHARS = 256;

// --- ansi -------------------------------------------------------------------

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), nF (`ESC ( B` y familia, lo
// que emite `tput sgr0`) y el resto de escapes de dos caracteres (Fe). Un ESC
// suelto al final no casa y se queda: no se quita lo que no se reconoce.
const RE_ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -/]+[0-~]|[@-_])/g;

function quitarAnsi(texto: string): string | null {
  if (!texto.includes("\u001b")) return null;
  const limpio = texto.replace(RE_ANSI, "");
  return limpio.length < texto.length ? limpio : null;
}

// --- carriage-return --------------------------------------------------------

/** Lo que enseña un terminal para una línea con retornos de carro. */
function lineaVisible(linea: string): string {
  let visible = "";
  for (const segmento of linea.split("\r")) {
    visible = segmento + visible.slice(segmento.length);
  }
  return visible;
}

function superponerRetornos(texto: string): string | null {
  if (!texto.includes("\r") || texto.includes("\r\n")) return null;
  const salida = texto
    .split("\n")
    .map((l) => (l.includes("\r") ? lineaVisible(l) : l))
    .join("\n");
  return salida.length < texto.length ? salida : null;
}

// --- json -------------------------------------------------------------------

const esEspacioJson = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Quita el espacio insignificante de un JSON SIN reserializarlo: cadenas y
 * literales salen tal cual. `null` si el texto no es entero un objeto o un
 * array JSON, si no hay nada que quitar o si la comprobación falla.
 */
function minificarJson(texto: string): string | null {
  const recortado = texto.trim();
  const primero = recortado.charCodeAt(0);
  if (primero !== 0x7b && primero !== 0x5b) return null; // { o [
  let original: unknown;
  try {
    original = JSON.parse(recortado);
  } catch {
    return null;
  }

  const trozos: string[] = [];
  let desde = 0;
  let enCadena = false;
  for (let i = 0; i < recortado.length; i++) {
    const c = recortado.charCodeAt(i);
    if (enCadena) {
      if (c === 0x5c) i += 1; // barra invertida: el siguiente carácter va dentro
      else if (c === 0x22) enCadena = false;
      continue;
    }
    if (c === 0x22) {
      enCadena = true;
      continue;
    }
    if (esEspacioJson(c)) {
      if (i > desde) trozos.push(recortado.slice(desde, i));
      desde = i + 1;
    }
  }
  if (desde < recortado.length) trozos.push(recortado.slice(desde));
  const compacto = trozos.join("");
  if (compacto.length >= texto.length) return null;

  // LA COMPROBACIÓN, no la promesa: el JSON compacto tiene que decir lo mismo.
  try {
    if (JSON.stringify(JSON.parse(compacto)) !== JSON.stringify(original)) return null;
  } catch {
    return null;
  }
  return compacto;
}

// --- repeated-lines ---------------------------------------------------------

const RE_MARCADOR = /^\[previous line repeated (\d+) more times\]$/;
const marcador = (n: number): string => `[previous line repeated ${n} more times]`;

/** Una racha tiene que tener al menos tantas líneas para plegarse. */
const RACHA_MINIMA = 3;

/** Deshace `plegarRepeticiones`. Exportada para que la verja la use. */
export function expandirRepeticiones(texto: string): string {
  const salida: string[] = [];
  for (const linea of texto.split("\n")) {
    const m = RE_MARCADOR.exec(linea);
    if (m && salida.length > 0) {
      const anterior = salida[salida.length - 1]!;
      for (let k = Number(m[1]); k > 0; k--) salida.push(anterior);
    } else {
      salida.push(linea);
    }
  }
  return salida.join("\n");
}

function plegarRepeticiones(texto: string): string | null {
  const lineas = texto.split("\n");
  if (lineas.length < RACHA_MINIMA) return null;
  // Ambigüedad: si el original ya trae una línea con forma de marcador, la
  // expansión no sabría cuál es nuestra. No se toca.
  if (lineas.some((l) => RE_MARCADOR.test(l))) return null;

  const salida: string[] = [];
  let plegadas = 0;
  for (let i = 0; i < lineas.length; ) {
    const linea = lineas[i]!;
    let j = i + 1;
    while (j < lineas.length && lineas[j] === linea) j++;
    const repeticiones = j - i - 1;
    const m = marcador(repeticiones);
    // Sólo si el marcador sale más barato que las copias que sustituye.
    if (repeticiones + 1 >= RACHA_MINIMA && repeticiones * (linea.length + 1) > m.length + 1) {
      salida.push(linea, m);
      plegadas += repeticiones;
    } else {
      for (let k = i; k < j; k++) salida.push(lineas[k]!);
    }
    i = j;
  }
  if (plegadas === 0) return null;
  const compacto = salida.join("\n");
  if (expandirRepeticiones(compacto) !== texto) return null; // reversible o nada
  return compacto.length < texto.length ? compacto : null;
}

// --- la función pública -----------------------------------------------------

const TRANSFORMAR: Record<CompactionTransform, (t: string) => string | null> = {
  ansi: quitarAnsi,
  "carriage-return": superponerRetornos,
  json: minificarJson,
  "repeated-lines": plegarRepeticiones,
};

/**
 * Compact one tool output with deterministic, content-only transformations.
 *
 * Nothing is summarised and no word is dropped: terminal escape sequences and
 * superseded progress-bar states are removed, whitespace between JSON tokens is
 * removed (strings and numbers are kept byte for byte, and the result must parse
 * to the same value), and runs of identical consecutive lines are folded into
 * the first line plus a count that expands back to the exact original.
 *
 * The same input always produces the same output. Call it where a tool result
 * is produced, before you append it to your conversation history, and the
 * history itself holds the compacted text — the provider's prefix cache is
 * never disturbed.
 */
export function compactToolOutput(
  text: string,
  settings: ToolOutputCompactionSettings = {},
): ToolOutputCompaction {
  const permitidas = new Set(settings.transforms ?? COMPACTION_TRANSFORMS);
  const minimo = Math.max(1, settings.minSavedChars ?? DEFAULT_MIN_SAVED_CHARS);

  let actual = text;
  const aplicadas: CompactionTransform[] = [];
  for (const t of COMPACTION_TRANSFORMS) {
    if (!permitidas.has(t)) continue;
    const r = TRANSFORMAR[t](actual);
    if (r != null && r.length < actual.length) {
      actual = r;
      aplicadas.push(t);
    }
  }

  const ahorro = text.length - actual.length;
  if (aplicadas.length === 0) {
    return sinCambio(text, "nothing to compact");
  }
  if (ahorro < minimo) {
    return sinCambio(text, `compaction would save ${ahorro} chars, below the ${minimo} minimum`);
  }
  return {
    text: actual,
    changed: true,
    applied: aplicadas,
    originalChars: text.length,
    compactChars: actual.length,
    reason: `${aplicadas.join(", ")}: ${ahorro} chars removed`,
  };
}

function sinCambio(text: string, reason: string): ToolOutputCompaction {
  return {
    text,
    changed: false,
    applied: [],
    originalChars: text.length,
    compactChars: text.length,
    reason,
  };
}

// --- sobre los mensajes de UNA petición --------------------------------------

// Las claves de argumento que dicen «esto es la vista de un fichero». Se
// normalizan (minúsculas, sin `_` ni `-`) para casar `file_path`, `filePath` y
// `filepath` con una sola entrada.
const CLAVES_DE_FICHERO = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "filename",
  "absolutepath",
  "relativepath",
  "targetfile",
  "notebookpath",
]);

/** ¿Los argumentos de la llamada nombran un fichero? */
export function esVistaDeFichero(argumentos: string | undefined): boolean {
  if (!argumentos) return false;
  let v: unknown;
  try {
    v = JSON.parse(argumentos);
  } catch {
    return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.keys(v).some((k) => CLAVES_DE_FICHERO.has(k.toLowerCase().replace(/[_-]/g, "")));
}

export interface CompactacionDeMensaje {
  indice: number;
  texto: string;
  aplicadas: CompactionTransform[];
  /** Nació en ESTA petición: va detrás del último `assistant`. */
  enLaCola: boolean;
}

export interface EleccionDeCompactacion {
  compactados: CompactacionDeMensaje[];
  /** tool_results que no se tocan por nombrar un fichero. */
  vistasDeFichero: number;
  /** tool_results que no se tocan por estar en `exceptTools`. */
  exceptuados: number;
}

/**
 * Qué `role: "tool"` de esta petición se compactan y con qué texto. Pura y
 * determinista: la decisión de cada mensaje depende de su contenido y de la
 * llamada que lo pidió, nunca de su posición. `enLaCola` sólo sirve para
 * CONTAR (qué parte es nueva y qué parte repite bytes ya enviados).
 */
export function seleccionarCompactables(
  messages: readonly ChatMessage[],
  ajustes: ToolOutputCompactionSettings = {},
): EleccionDeCompactacion {
  const llamadas = new Map<string, { nombre: string; argumentos: string }>();
  let ultimoAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    ultimoAssistant = i;
    for (const tc of m.toolCalls ?? []) {
      if (tc.id) llamadas.set(tc.id, { nombre: tc.name, argumentos: tc.arguments });
    }
  });

  const exceptuadas = new Set(ajustes.exceptTools ?? []);
  const eleccion: EleccionDeCompactacion = { compactados: [], vistasDeFichero: 0, exceptuados: 0 };
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    const llamada = m.toolCallId ? llamadas.get(m.toolCallId) : undefined;
    const nombre = llamada?.nombre ?? m.name;
    if (nombre && exceptuadas.has(nombre)) {
      eleccion.exceptuados += 1;
      return;
    }
    if (!ajustes.compactFileViews && esVistaDeFichero(llamada?.argumentos)) {
      eleccion.vistasDeFichero += 1;
      return;
    }
    const r = compactToolOutput(m.content, ajustes);
    if (!r.changed) return;
    eleccion.compactados.push({ indice: i, texto: r.text, aplicadas: r.applied, enLaCola: i > ultimoAssistant });
  });
  return eleccion;
}
