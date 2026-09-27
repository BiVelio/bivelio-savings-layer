// ═══════════════════════════════════════════════════════════════════════════
// LAS BÚSQUEDAS DE HERRAMIENTAS DE UN TURNO, DEVUELTAS EN EL SIGUIENTE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo INTERNO del adaptador de Anthropic: no lo reexporta ningún barril
// (`providers/index.ts` reexporta `anthropic.ts` entero, por eso esto vive
// aparte).
//
// EL PROBLEMA. De un turno del asistente, el contrato neutro solo transporta
// `content` y `toolCalls` (`repartirMensajes`). Con la búsqueda nativa
// (`savings.toolSearch`), eso tira los bloques `server_tool_use` +
// `tool_search_tool_result` que el proveedor devolvió, y con ellos las
// referencias a las herramientas que la búsqueda cargó. En el turno siguiente
// esas herramientas vuelven a estar diferidas y el modelo, si las necesita,
// vuelve a buscar: una búsqueda (salida) y la carga de sus definiciones
// (entrada) por cada turno que necesita herramienta.
//
// LO QUE DICE EL PROVEEDOR (leído el 2026-09-27,
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool,
// «Continuing the conversation»):
//
//   «On the next request, pass the assistant's content back unchanged, including
//    the `server_tool_use` and `tool_search_tool_result` blocks. […] The API
//    expands `tool_reference` blocks throughout the conversation history, so
//    Claude can reuse discovered tools in later turns without re-searching.»
//
// y, en «Error handling», un 400 si una referencia apunta a una herramienta que
// no está en `tools` («Tool reference 'unknown_tool' not found in available
// tools»).
//
// LA SOLUCIÓN, la de menor cambio: el adaptador RECUERDA, en memoria acotada y
// en proceso, los pares de búsqueda de cada respuesta, indexados por los ids de
// las llamadas a herramienta (`toolu_…`) de esa misma respuesta. Cuando el
// llamante devuelve ese turno del asistente con sus `toolCalls` (lo que el
// contrato de `ChatMessage.toolCalls` ya le pide para continuar una
// conversación con herramientas), el adaptador antepone los pares a ese turno.
//
// POR QUÉ LOS IDS DE LLAMADA Y NO EL TEXTO. Un id `toolu_…` lo genera el
// proveedor, es único y solo lo conoce quien recibió esa respuesta. Una clave
// por texto podría coincidir entre dos conversaciones («Voy a consultarlo.») e
// inyectar en una la consulta que el modelo escribió en la otra —la consulta
// lleva datos de la conversación—. Con ids, eso no puede pasar.
//
// POR QUÉ SOLO LOS PARES, Y NO EL CONTENIDO ENTERO. El resto del turno se
// reconstruye de lo que el llamante devuelve: el texto de `content` y los
// `tool_use` de `toolCalls`, que el adaptador ya manda en nativo con sus
// `tool_result` detrás cuando el intercambio está completo (`repartirMensajes`
// en anthropic.ts). Lo único que el contrato neutro no transporta son los pares
// de búsqueda, y por eso solo esos se recuerdan. El par está completo en sí
// mismo (el resultado sigue a su `server_tool_use` dentro del mismo turno), así
// que puede viajar también cuando el intercambio sale como texto.
//
// FALLA HACIA LO DE HOY. Sin entrada en la memoria (otro proceso, una entrada
// expulsada, un llamante que no devuelve `toolCalls`) el turno se manda como
// hoy y el modelo vuelve a buscar. Nunca un 400 nuevo por esta vía.
//
// NO ES UN AHORRO DE LA CAPA (regla E4-bis): lo que cuesta o ahorra, lo cuenta
// el contador del proveedor. Solo se informa en la traza `tool-search`.

/** Un bloque de contenido tal cual lo devolvió la API. */
export type BloqueCrudo = Record<string, unknown>;

/** Un `server_tool_use` de la búsqueda y su `tool_search_tool_result`, CRUDOS. */
export interface ParDeBusqueda {
  /** El nombre de la herramienta de búsqueda que corrió (`tool_search_tool_bm25` o `_regex`). */
  busqueda: string;
  /** El id `srvtoolu_…` del par. */
  id: string;
  uso: BloqueCrudo;
  resultado: BloqueCrudo;
  /** Las herramientas que el par carga (sus `tool_reference`). */
  herramientas: string[];
}

/**
 * Los pares de búsqueda COMPLETOS de una respuesta, en su orden: cada
 * `server_tool_use` de una herramienta `tool_search_tool_*` con su
 * `tool_search_tool_result`, siempre que el resultado haya cargado al menos una
 * herramienta. Se descartan:
 *
 *  · un `server_tool_use` sin resultado: la API lo documenta como una llamada
 *    del servidor sin terminar («A response can contain both a client `tool_use`
 *    block and a `server_tool_use` block that has no result block»), y
 *    mandarlo de vuelta sin su resultado es otro contrato;
 *  · un resultado de error o vacío: no carga nada, y devolverlo solo costaría
 *    tokens.
 */
export function paresDeBusqueda(bloques: readonly BloqueCrudo[]): ParDeBusqueda[] {
  const pares: ParDeBusqueda[] = [];
  for (const uso of bloques) {
    if (uso["type"] !== "server_tool_use") continue;
    const id = uso["id"];
    const nombre = uso["name"];
    if (typeof id !== "string" || typeof nombre !== "string" || !nombre.startsWith("tool_search_tool")) continue;
    const resultado = bloques.find((b) => b["type"] === "tool_search_tool_result" && b["tool_use_id"] === id);
    const contenido = resultado?.["content"] as { type?: unknown; tool_references?: unknown } | null | undefined;
    if (!resultado || !contenido || contenido.type !== "tool_search_tool_search_result") continue;
    if (!Array.isArray(contenido.tool_references) || contenido.tool_references.length === 0) continue;
    const herramientas: string[] = [];
    let sano = true;
    for (const r of contenido.tool_references as { tool_name?: unknown }[]) {
      if (typeof r?.tool_name !== "string") {
        sano = false;
        break;
      }
      if (!herramientas.includes(r.tool_name)) herramientas.push(r.tool_name);
    }
    if (sano) pares.push({ busqueda: nombre, id, uso, resultado, herramientas });
  }
  return pares;
}

interface Entrada {
  pares: ParDeBusqueda[];
  bytes: number;
}

/**
 * Cuánto se recuerda. La memoria es por instancia del adaptador y vive en el
 * proceso: nada sale de él.
 *
 *  · `bytes`: el total, medido como el JSON de los pares. Un par normal (una
 *    consulta de ≤ 500 caracteres y 5 referencias) pesa unos cientos de bytes,
 *    así que 4 MiB son miles de turnos vivos.
 *  · `porEntrada`: una respuesta cuya búsqueda pidió miles de referencias
 *    (`limit` admite hasta 10.000) no se recuerda: vaciaría la memoria de todas
 *    las demás conversaciones para guardar una.
 *  · `claves`: ids de llamada recordados. Una respuesta con llamadas en paralelo
 *    ocupa una clave por llamada (y su peso cuenta en cada una: es la cota
 *    conservadora).
 *
 * Se expulsa la entrada usada hace más tiempo. Usar una la renueva, así que una
 * conversación que sigue viva no pierde sus pares por el tráfico de otras —y es
 * importante: si un turno los llevó y el siguiente no, el historial cambia en
 * ese punto y la caché de prefijo de los mensajes que siguen se pierde—.
 */
export const TOPES_DE_LA_MEMORIA = { bytes: 4 * 1024 * 1024, porEntrada: 64 * 1024, claves: 4096 } as const;

/** Los pares de búsqueda de cada respuesta, por los ids de sus llamadas a herramienta. */
export class MemoriaDeBusquedas {
  private readonly entradas = new Map<string, Entrada>();
  private bytes = 0;

  constructor(private readonly topes: { bytes: number; porEntrada: number; claves: number } = TOPES_DE_LA_MEMORIA) {}

  /** Recuerda los pares de una respuesta bajo cada id de llamada de esa respuesta. */
  recordar(idsDeLlamada: readonly string[], pares: readonly ParDeBusqueda[]): void {
    if (idsDeLlamada.length === 0 || pares.length === 0) return;
    // Una copia profunda: lo que se recuerda no puede cambiar porque alguien
    // mute la respuesta que se entregó.
    const copia = JSON.parse(JSON.stringify(pares)) as ParDeBusqueda[];
    const bytes = JSON.stringify(copia).length;
    if (bytes > this.topes.porEntrada) return;
    const entrada: Entrada = { pares: copia, bytes };
    for (const id of new Set(idsDeLlamada)) {
      this.quitar(id);
      this.entradas.set(id, entrada);
      this.bytes += bytes;
    }
    while (this.entradas.size > 0 && (this.bytes > this.topes.bytes || this.entradas.size > this.topes.claves)) {
      const masVieja = this.entradas.keys().next().value as string;
      this.quitar(masVieja);
    }
  }

  /**
   * Los pares recordados para un turno del asistente, por los ids de sus
   * llamadas; `undefined` si ninguno está. Cada id encontrado se renueva.
   * Devuelve COPIAS: el adaptador marca `cache_control` sobre los bloques que
   * envía, y esa marca no puede quedarse pegada en la memoria.
   */
  para(idsDeLlamada: readonly string[]): ParDeBusqueda[] | undefined {
    let hallada: Entrada | undefined;
    for (const id of idsDeLlamada) {
      const e = this.entradas.get(id);
      if (!e) continue;
      this.entradas.delete(id);
      this.entradas.set(id, e);
      hallada ??= e;
    }
    return hallada ? (JSON.parse(JSON.stringify(hallada.pares)) as ParDeBusqueda[]) : undefined;
  }

  /** Cuántas claves hay (para los tests). */
  get tamano(): number {
    return this.entradas.size;
  }

  private quitar(id: string): void {
    const e = this.entradas.get(id);
    if (!e) return;
    this.entradas.delete(id);
    this.bytes -= e.bytes;
  }
}
