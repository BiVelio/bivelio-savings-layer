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
