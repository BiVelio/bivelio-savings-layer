import type { ChatMessage } from "../contracts/types.js";

/**
 * Elisión v0 (edad × tamaño) de tool_results, del lado del SDK.
 *
 * Es la MISMA política que el carril sombra corre en modo medir-solo
 * (`gateway/sombra.ts`, `aplicarPolitica("v0", …)`): elidir un tool_result viejo
 * y gordo antes de reenviarlo baja la factura real del cliente. Lo que el carril
 * sombra omite a propósito —«jamás toca un byte de lo reenviado»— y esta pieza
 * añade es la reescritura REAL del cuerpo por un muñón estable, conservando
 * `role:"tool"`, `toolCallId`, `name` y el orden cronológico.
 *
 * FRONTERA DE MÓDULOS. `gateway/` importa de `../src/`, nunca al revés, así que
 * estas constantes NO pueden importarse del carril sombra: se replican aquí y
 * una verja de paridad (`test/elision-v0-paridad.test.ts`) las compara contra
 * las del gateway para que no se separen en silencio.
 *
 * FIDELIDAD. v0 en el carril sombra solo protege el ÚLTIMO tool_result
 * (`edad ≥ 2`). Esta pieza, que sí borra tráfico real, importa además el suelo
 * de S4a (`gateway/diales.ts`, `DIAL_KEEP_TOOL_USES = 8`): nunca elide los
 * `KEEP_TOOL_RESULTS` resultados más nuevos. El incidente de las 21 relecturas
 * (coste ×5) que subió keep=3→8 es la prueba de que el suelo de edad de v0 es
 * MÁS DÉBIL que keep=8, y este es el segmento genérico («otro») donde no hay
 * guardián del proveedor.
 */

/** Umbral por debajo del cual NO se toca un tool_result: el muñón ocupa poco y
 *  elidir menos de 1 KB no paga ni su propia reescritura. Calcado de
 *  `MINIMO_BYTES_CANDIDATO` del carril sombra. */
export const MINIMO_BYTES_CANDIDATO = 1024;

/** v0: elidir cuando edad_turnos × KB ≥ este umbral (y edad ≥ 2). Calcado de
 *  `V0_UMBRAL_EDAD_KB` del carril sombra. */
export const V0_UMBRAL_EDAD_KB = 8;

/** Suelo de fidelidad: los N tool_results más nuevos NUNCA se eliden. Calcado
 *  de `DIAL_KEEP_TOOL_USES` de S4a; no bajar de 8 sin nueva evidencia. */
export const KEEP_TOOL_RESULTS = 8;

/** El muñón que sustituye al cuerpo de un tool_result elidido. Estable (el mismo
 *  para cualquier bloque elidido) para no romper el prefijo de caché más de lo
 *  imprescindible: el turno en que un bloque pasa de presente a elidido paga la
 *  invalidación UNA vez; a partir de ahí el muñón es idéntico turno tras turno. */
export const MUNON_ELISION =
  "[BiVelio Savings: resultado de herramienta antiguo recortado para bajar el coste; los resultados recientes viajan enteros.]";

export interface EleccionElision {
  /** Índices en `messages` de los tool_result a elidir (orden ascendente). */
  indices: number[];
  /** Suma de bytes originales de los elididos (bruto, para trazar). */
  bytesOriginales: number;
}

// `TextEncoder` es universal (navegador + Node); los globales solo-Node no
// existen en el bundle web y la verja de `revocation.test.ts` los prohíbe en
// `src/`. Es el mismo idioma que usan `src/util/hash.ts` y
// `src/tokenizer/exact.ts` para medir bytes UTF-8.
const codificador = /* @__PURE__ */ new TextEncoder();

function bytesDe(content: string): number {
  return codificador.encode(content).length;
}

/**
 * Selección v0 sobre el array de mensajes de UNA petición. Pura y determinista.
 *
 * La «edad» de un tool_result es el número de mensajes `assistant` que aparecen
 * DESPUÉS de él en el array. En el bucle de agente el cliente reenvía todo el
 * historial cada turno, así que la posición ES la edad de turno: equivale al
 * `turno - nacimiento` del carril sombra cuando se reenvía todo el contexto,
 * que es el patrón que midió el corpus.
 *
 * `keepUltimos` protege por completo los N tool_result más nuevos. El defecto es
 * el suelo de fidelidad `KEEP_TOOL_RESULTS`. Con `keepUltimos = 1` reproduce el
 * v0 PURO del carril sombra («el último tool_result jamás»), que es contra lo
 * que compara la verja de paridad.
 */
export function seleccionarElisionV0(
  messages: ChatMessage[],
  keepUltimos: number = KEEP_TOOL_RESULTS,
): EleccionElision {
  const idxTool: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") idxTool.push(i);
  }

  // Los `keepUltimos` más nuevos quedan intocables (siempre al menos el último,
  // aunque se pida 0 — nunca se elide el tool_result del turno en curso).
  const guardados = Math.max(1, Math.min(keepUltimos, idxTool.length));
  const protegidos = new Set(idxTool.slice(idxTool.length - guardados));

  // Edad = mensajes `assistant` estrictamente posteriores. Sufijo precomputado.
  const assistantDespues: number[] = new Array(messages.length).fill(0);
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantDespues[i] = acc;
    if (messages[i]!.role === "assistant") acc++;
  }

  const indices: number[] = [];
  let bytesOriginales = 0;
  for (const i of idxTool) {
    if (protegidos.has(i)) continue;
    const bytes = bytesDe(messages[i]!.content);
    if (bytes < MINIMO_BYTES_CANDIDATO) continue;
    const edad = assistantDespues[i]!;
    const elidir = edad >= 2 && (edad * bytes) / 1024 >= V0_UMBRAL_EDAD_KB;
    if (elidir) {
      indices.push(i);
      bytesOriginales += bytes;
    }
  }
  return { indices, bytesOriginales };
}

/**
 * IDENTIDAD DE RECURSO de una llamada de herramienta: `nombre + argumentos
 * canónicos`. Es la clave que dice si dos tool_results hablan del MISMO recurso
 * (el mismo `read_file` del mismo `path`, el mismo `grep` del mismo patrón).
 *
 * Devuelve `null` cuando NO se puede probar identidad —sin nombre, o con
 * argumentos triviales (`undefined`, `""`, `"{}"`, objeto vacío)—. Ese es el
 * caso honesto por defecto: sin un argumento que identifique el recurso no hay
 * forma de demostrar que un bloque supersede a otro, así que NO se elide. (El
 * arnés viejo mandaba todo con `arguments:"{}"`; bajo esta regla eso no elide
 * nada, que es lo correcto: no hay evidencia de recurso.)
 *
 * Canoniza el JSON de argumentos (claves ordenadas, recursivo) para que
 * `{"a":1,"b":2}` y `{"b":2,"a":1}` sean el MISMO recurso. Si el argumento no es
 * JSON, usa la cadena cruda recortada (sigue siendo una identidad estable).
 */
export function identidadRecurso(nombre: string | undefined, argumentos: string | undefined): string | null {
  if (!nombre) return null;
  const bruto = (argumentos ?? "").trim();
  if (bruto === "" || bruto === "{}" || bruto === "[]") return null;
  let canon: string;
  try {
    const v = JSON.parse(bruto);
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return null;
    canon = canonizar(v);
  } catch {
    canon = bruto;
  }
  return `${nombre} ${canon}`;
}

/** Serializa un valor JSON con las claves de objeto ordenadas, recursivamente,
 *  para que la identidad no dependa del orden en que el modelo escribió el JSON. */
function canonizar(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonizar).join(",")}]`;
  const claves = Object.keys(v as Record<string, unknown>).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonizar((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Selección por SUPERSESIÓN sobre los mensajes de UNA petición. Pura y
 * determinista. Es la política que corre EN VIVO (la que la verja de fidelidad
 * prueba y `pipeline.ts` aplica cuando `ELISION_EN_VIVO`), más conservadora y
 * más honesta que v0 (edad×tamaño):
 *
 *   Un tool_result se elide SOLO si un tool_result ESTRICTAMENTE MÁS NUEVO
 *   vuelve a pedir el MISMO recurso (misma herramienta + mismos argumentos).
 *
 * Esa es la única redundancia DEMOSTRABLE sin adivinar la pregunta futura: si el
 * agente releyó `config.ts`, la lectura vieja de `config.ts` es peso muerto —su
 * estado vive en la relectura—. NO elide búsquedas viejas con consultas
 * distintas (no son el mismo recurso) ni lecturas de recursos distintos (una
 * síntesis las necesita todas): esos casos se DECLINAN, que es exactamente lo
 * que impedía que v0 fuera seguro (v0 borraba la síntesis y la verja lo cazaba).
 *
 * Frente a v0 esto deja ahorro seguro sobre la mesa (una búsqueda superada por
 * otra con distinta consulta NO se toca), pero cada byte que borra es
 * provablemente redundante. Es el suelo honesto; mejorar el algoritmo —recuperar
 * ese ahorro sin degradar— es el trabajo siguiente.
 *
 * Nunca elide el ÚLTIMO tool_result (el del turno en curso) ni bloques por
 * debajo de `MINIMO_BYTES_CANDIDATO` (el muñón no paga su reescritura, y tocar
 * bloques pequeños solo agita la caché de prefijo). El error de un recurso que
 * luego se releyó con éxito SÍ queda superado: no se protege por ser error.
 */
export function seleccionarSupersesion(messages: ChatMessage[]): EleccionElision {
  // toolCallId → argumentos de la llamada que lo generó (el `assistant` lleva el
  // nombre y los argumentos; el `role:"tool"` solo lleva `toolCallId` y `name`).
  const argsPorId = new Map<string, string | undefined>();
  const nombrePorId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (!tc.id) continue; // sin id no se puede casar con su tool_result
        argsPorId.set(tc.id, tc.arguments);
        nombrePorId.set(tc.id, tc.name);
      }
    }
  }

  // Índices de tool_result + su identidad de recurso (o null si no demostrable).
  const idxTool: number[] = [];
  const ridPorIdx = new Map<number, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    idxTool.push(i);
    const nombre = (m.toolCallId ? nombrePorId.get(m.toolCallId) : undefined) ?? m.name;
    const args = m.toolCallId ? argsPorId.get(m.toolCallId) : undefined;
    const rid = identidadRecurso(nombre, args);
    if (rid !== null) ridPorIdx.set(i, rid);
  }

  const ultimoTool = idxTool.length ? idxTool[idxTool.length - 1]! : -1;

  // Por recurso, el índice MÁS NUEVO (máximo) es el vigente; los anteriores con
  // esa misma identidad quedan superados.
  const masNuevoPorRid = new Map<string, number>();
  for (const i of idxTool) {
    const rid = ridPorIdx.get(i);
    if (rid === undefined) continue;
    const prev = masNuevoPorRid.get(rid);
    if (prev === undefined || i > prev) masNuevoPorRid.set(rid, i);
  }

  const indices: number[] = [];
  let bytesOriginales = 0;
  for (const i of idxTool) {
    if (i === ultimoTool) continue; // el turno en curso jamás
    const rid = ridPorIdx.get(i);
    if (rid === undefined) continue; // sin identidad demostrable → se conserva
    if (masNuevoPorRid.get(rid) === i) continue; // este ES el vigente del recurso
    const bytes = bytesDe(messages[i]!.content);
    if (bytes < MINIMO_BYTES_CANDIDATO) continue;
    indices.push(i);
    bytesOriginales += bytes;
  }
  return { indices, bytesOriginales };
}

/**
 * Reescribe el cuerpo de los tool_result elididos con el muñón estable,
 * conservando `role`, `toolCallId`, `name`, `toolCalls`, `metadata` y el orden.
 * Devuelve un array NUEVO; el original no se muta. Sin índices, devuelve el
 * mismo array (identidad — el llamante puede comparar por referencia).
 */
export function aplicarElision(messages: ChatMessage[], indices: number[]): ChatMessage[] {
  if (indices.length === 0) return messages;
  const set = new Set(indices);
  return messages.map((m, i) => (set.has(i) ? { ...m, content: MUNON_ELISION } : m));
}
