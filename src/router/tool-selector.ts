import { normalizeText } from "../canonicalization/canonicalize.js";
import type { ExecutionClass, ToolDescriptor } from "../contracts/types.js";
import { catalogoSinTipar } from "./busqueda-nativa.js";

/**
 * Tool selector.
 *
 * Full tool schemas can dominate a prompt even when most tools are irrelevant.
 * The selector picks only the tools whose declared intents match the request,
 * and — critically — gates write/destructive tools behind explicit rules so a
 * read-only request can never be handed a mutating capability.
 */
export interface ToolSelection {
  tools: ToolDescriptor[];
  droppedIds: string[];
  reason: string;
  /**
   * Whether the SET of tools is determined by something stable across requests,
   * rather than by this request's text.
   *
   * It is not cosmetic. Tools render FIRST in a provider request (tools ->
   * system -> messages), so a tool set that changes with the question moves the
   * very front of the prompt and invalidates the whole prefix cache behind it.
   * A caller whose prompt caching silently never hits, on traffic with tools, is
   * usually looking at this.
   */
  setIsStable: boolean;
}

export interface ToolSelectorOptions {
  /** Max tools to include (schema-token budget guard). */
  maxTools?: number;
  /** Tokenizer-aware scorer for tie-breaking (optional). */
  scoreIntentMatch?: (text: string, tool: ToolDescriptor) => number;
  /**
   * How many requests are selected by relevance before the set is FROZEN for a
   * given key. Below this count the selector learns; past it, it always emits
   * the same set and `setIsStable` is true again.
   *
   * The default of 16 is measured, not round: across 214 sessions of real
   * traffic, a set frozen from the first 16 invoked tools came up short in
   * 0.0% of sessions (8 fell short in 2.3%, 12 in 0.5%).
   */
  learningTurns?: number;
  /** Where frozen sets are remembered. Defaults to an in-process map. */
  freezer?: ToolSetFreezer;
}

/**
 * Memory for the frozen tool set. The caller owns the key: the pipeline passes
 * the caller's toolset hash, which in practice is one key per session.
 */
export interface ToolSetFreezer {
  read(key: string): { ids: string[]; turns: number } | undefined;
  record(key: string, ids: string[], turns: number): void;
}

/** In-process freezer with a key cap (clears wholesale when full). */
export class InMemoryToolSetFreezer implements ToolSetFreezer {
  private map = new Map<string, { ids: string[]; turns: number }>();
  constructor(private readonly cap = 512) {}
  read(key: string) {
    return this.map.get(key);
  }
  record(key: string, ids: string[], turns: number) {
    if (this.map.size >= this.cap && !this.map.has(key)) this.map.clear();
    this.map.set(key, { ids, turns });
  }
}

// EL CATÁLOGO SIN TIPAR (`catalogoSinTipar`) se detecta con una regla que vive
// en `busqueda-nativa.ts`, junto con el porqué: la ruta de la búsqueda nativa
// aplica la MISMA verja de riesgo y las dos no pueden derivar. Va en `//` y no
// en JSDoc a propósito: un JSDoc suelto aquí se pegaría a `ToolSelector` en el
// `.d.ts` publicado.

export class ToolSelector {
  private readonly maxTools: number;
  private readonly scoreIntentMatch: (text: string, tool: ToolDescriptor) => number;
  private readonly learningTurns: number;
  private readonly freezer: ToolSetFreezer;

  constructor(opts: ToolSelectorOptions = {}) {
    this.maxTools = opts.maxTools ?? 8;
    this.scoreIntentMatch = opts.scoreIntentMatch ?? defaultScore;
    this.learningTurns = opts.learningTurns ?? 16;
    this.freezer = opts.freezer ?? new InMemoryToolSetFreezer();
  }

  /**
   * Todas las herramientas que pasó el llamante, acotadas SOLO por el
   * presupuesto de esquema (`maxTools`).
   *
   * Se usa cuando el llamante apaga el router (`savings:{router:false}`): sin
   * clasificación no hay de dónde derivar el riesgo, y filtrar sobre el
   * `defaultRoute()` tiraba en silencio las herramientas de escritura. Apagar el
   * router significa "yo elijo las herramientas", así que la relevancia pasa a
   * ser del llamante — pero el tope de presupuesto NO se levanta: mandar 200
   * esquemas al proveedor es un 400 seguro y una petición que antes funcionaba
   * pasaría a fallar en duro.
   */
  passthrough(tools: ToolDescriptor[] | undefined): ToolSelection {
    if (!tools || tools.length === 0) {
      return { tools: [], droppedIds: [], reason: "no tools provided", setIsStable: true };
    }
    const selected = tools.slice(0, this.maxTools);
    const droppedIds = tools.slice(this.maxTools).map((t) => t.id);
    return {
      tools: selected,
      droppedIds,
      reason:
        `router off: caller tools passed through unfiltered ` +
        `(${selected.length}/${tools.length}, capped at maxTools=${this.maxTools}; ` +
        `risk gating is the caller's responsibility while routing is off)`,
      // Aquí el conjunto lo decide el LLAMANTE y el corte es posicional, no por
      // puntuación: con la misma lista de entrada sale el mismo conjunto,
      // pregunte lo que pregunte. Eso sí es estable.
      setIsStable: true,
    };
  }

  select(
    text: string,
    tools: ToolDescriptor[] | undefined,
    execution: ExecutionClass,
    /**
     * Freeze key. The pipeline passes the caller's toolset hash, which in
     * practice is one key per session. Without a key nothing is frozen and the
     * selector behaves exactly as before.
     */
    freezeKey?: string,
  ): ToolSelection {
    if (!tools || tools.length === 0) {
      return { tools: [], droppedIds: [], reason: "no tools provided", setIsStable: true };
    }

    // Catálogo real sin tipar: no hay señal que seleccionar. Pasa íntegro.
    if (catalogoSinTipar(tools)) {
      const paso = this.passthrough(tools);
      return {
        ...paso,
        reason:
          `catalogue declares no \`intents\` and no \`risk\`: nothing to select on, ` +
          `passed through (${paso.tools.length}/${tools.length}, capped at maxTools=${this.maxTools}). ` +
          `Declare ToolDescriptor.intents/risk to enable pruning`,
      };
    }

    // A non-TOOL_ACTION request never receives write/destructive tools.
    const allowWrites = execution === "TOOL_ACTION";
    const eligible = tools.filter((t) => allowWrites || t.risk === "read");
    const esEscritura = (t: ToolDescriptor) => allowWrites && t.risk !== "read";

    // LAS DE ESCRITURA EN UNA RUTA TOOL_ACTION SON EL PROPÓSITO DE LA PETICIÓN,
    // y no se podan por puntuación léxica.
    //
    // El router acaba de clasificar esto como «imperativo + hay una herramienta
    // de escritura»: el modelo TIENE que poder llamarla. Pero el intent de una
    // write casa con el verbo del usuario pocas veces —`intents: ["facturación
    // saliente"]` contra «envía la factura» puntúa 0—, así que el viejo
    // `.filter(score > 0)` la descartaba: el proveedor no veía la capacidad, el
    // modelo contestaba «claro, la envío» y NO SE ENVIABA NADA. Y encima el libro
    // 2 acreditaba sus tokens como ahorro, o sea que cobrábamos comisión por
    // haberle roto la función al cliente. Es el «peor fallo posible» que el repo
    // ya cerró para `retrieval:"off"` y para `router:false`; esta era la tercera
    // puerta. Misma regla «LAS DE ESCRITURA VAN SIEMPRE» que aplica
    // schema-on-demand una etapa después — sobre lo que este selector ya haya
    // podado, así que sin esto no llega a alcanzarlas.
    //
    // La poda por relevancia se conserva SOLO para las de lectura: una read cuyo
    // intent no casa es ahorro legítimo. Como las writes dejan de estar en
    // `droppedIds`, dejan de acreditarse como ahorro: el arreglo de contabilidad
    // sale gratis.
    const reads = eligible.filter((t) => !esEscritura(t));
    const writes = eligible.filter((t) => esEscritura(t));

    // Y CUANDO NO CABEN TODAS, SE ELIGE POR PUNTUACIÓN, NUNCA POR ORDEN DE
    // DECLARACIÓN. Sin este `sort` el corte se lleva por delante justo la write
    // que sí casaba: con `maxTools: 2` y tres writes de las que solo
    // `send_invoice` case con «envía la factura», cortar por declaración emite
    // las dos irrelevantes y descarta la buena — que es EXACTAMENTE el fallo que
    // esta función viene a cerrar, reaparecido en la frontera del presupuesto y
    // peor que antes. Se puntúan pero NO se filtran por `score > 0`: una write
    // sin coincidencia sigue entrando si hay hueco; la puntuación solo decide el
    // orden de preferencia. `Array.prototype.sort` es estable, así que a igual
    // puntuación manda el orden del llamante y el resultado es determinista.
    const writesPorRelevancia = writes
      .map((tool) => ({ tool, score: this.scoreIntentMatch(text, tool) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.tool);
    const readsRelevantes = reads
      .map((tool) => ({ tool, score: this.scoreIntentMatch(text, tool) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.tool);
    // Las writes primero (son la acción) y el techo restante para las reads: bajo
    // presión de presupuesto se sacrifica una lectura, nunca la capacidad de actuar.
    const scored = [
      ...writesPorRelevancia.slice(0, this.maxTools),
      ...readsRelevantes.slice(0, Math.max(0, this.maxTools - writes.length)),
    ].map((tool) => ({ tool }));

    // EL ORDEN QUE SE EMITE NO ES EL ORDEN EN QUE SE ELIGE.
    //
    // La puntuación decide QUÉ herramientas entran —ahí está el ahorro de poda,
    // y lo que descarta alimenta el libro 2—, pero ordenar por puntuación al
    // emitirlas hacía que el bloque `tools` cambiara de ORDEN entre dos
    // preguntas que seleccionan exactamente el mismo conjunto. Como `tools` va
    // lo PRIMERO del prompt, ese reordenado invalida la caché de prefijo entera:
    // el acierto se va a ~0 en tráfico con herramientas.
    //
    // Reordenar por id al final es gratis en ahorro (el conjunto no cambia, ni
    // el recuento, ni `droppedIds`) y convierte el caso "mismo conjunto, otra
    // pregunta" en un acierto de caché. Es la mitad del choque que se puede
    // ganar sin ceder nada.
    //
    // La otra mitad —que el CONJUNTO también cambia— no se arregla aquí y no se
    // arregla gratis: congelarlo sacrificaría el ahorro de poda. Se declara en
    // `setIsStable` y decide quien pueda pagar ese cambio, no este selector.
    const selected = scored.map((s) => s.tool).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // ── EL CONJUNTO SE CONGELA ─────────────────────────────────────────────
    //
    // Aquí decía este fichero que congelar «sacrificaría el ahorro de poda» y
    // que la decisión no era suya. Ya está medida, sobre 14,9 GB de tráfico
    // real, y dice lo contrario: el sacrificio es NO congelar.
    //
    // `tools` va lo PRIMERO del prompt, así que un conjunto que cambia con la
    // pregunta mueve el frente entero y tira la caché de prefijo detrás. En ese
    // corpus el bloque de herramientas era el 26,3 % de los tokens pero solo el
    // 14,9 % del dinero —porque se cobraba a precio de caché— y perder el
    // marcado multiplicaba la factura de entrada por 6,1. Podar salía a 35,7:1
    // EN CONTRA: $14.598 frente a $3.128. Congelando, esa misma poda pasa a
    // ahorrar el 14,3 %.
    //
    // Se aprende durante los primeros turnos (la unión de lo que la relevancia
    // vaya eligiendo) y a partir de ahí el conjunto es fijo para esa clave. Con
    // 16 turnos el conjunto congelado no se quedó corto en NINGUNA de las 214
    // sesiones del corpus.
    if (freezeKey !== undefined) {
      const memoria = this.freezer.read(freezeKey);
      const turnos = (memoria?.turns ?? 0) + 1;
      if (memoria && turnos > this.learningTurns) {
        const congelados = new Set(memoria.ids);
        const emitidas = tools.filter((t) => congelados.has(t.id));
        this.freezer.record(freezeKey, memoria.ids, turnos);
        const idsEmitidos = new Set(emitidas.map((t) => t.id));
        return {
          tools: emitidas,
          droppedIds: tools.filter((t) => !idsEmitidos.has(t.id)).map((t) => t.id),
          reason:
            `frozen tool set after ${this.learningTurns} turns ` +
            `(${emitidas.length}/${tools.length}): it no longer depends on this ` +
            `request's text, so the prefix cache survives`,
          // La razón de ser del cambio: el conjunto ya no depende del texto.
          setIsStable: true,
        };
      }
      // Aún aprendiendo: la unión de lo elegido hasta ahora, acotada.
      const union = [...new Set([...(memoria?.ids ?? []), ...selected.map((t) => t.id)])].sort().slice(0, this.maxTools);
      this.freezer.record(freezeKey, union, turnos);
    }

    const selectedIds = new Set(selected.map((t) => t.id));
    const droppedIds = tools.filter((t) => !selectedIds.has(t.id)).map((t) => t.id);

    return {
      tools: selected,
      droppedIds,
      reason: `selected ${selected.length}/${tools.length} by intent match (writes ${allowWrites ? "allowed" : "blocked"})`,
      // Nada podado significa que el conjunto emitido es el conjunto del
      // llamante: no depende de esta pregunta. En cuanto se poda algo, sí
      // depende, y el prefijo deja de poder llamarse estable.
      setIsStable: droppedIds.length === 0,
    };
  }
}

function defaultScore(text: string, tool: ToolDescriptor): number {
  // LOS DOS LADOS SE PLIEGAN CON LA MISMA FUNCIÓN, y no es cosmética.
  //
  // El texto llega ya normalizado desde el pipeline (`canonical.normalizedText`),
  // mientras que los `intents` los escribe el CLIENTE, en su idioma y tal cual.
  // Desde que `normalizeText` pliega diacríticos, comparar uno contra otro sin
  // plegar los dos deja la herramienta MUDA en cuanto el intent lleva una tilde:
  // con `intents: ["envío"]`, «envía el envío de hoy» se normaliza a «envia el
  // envio de hoy» y `includes("envío")` es falso, así que el selector la descarta
  // (medido: `tools: []`, `droppedIds: ["envio"]`, contra la selección correcta
  // antes de plegar). Ahí no se pierde un acierto de caché: el proveedor no llega
  // a ver la capacidad, el modelo contesta «claro, lo envío» y no se envía nada
  // —el mismo fallo que ya se cerró en el router para `retrieval:"off"`— y el
  // libro lo apunta como ahorro (`actualTools: 0`).
  const haystack = normalizeText(text);
  let score = 0;
  // Un catálogo sin tipar no debería llegar aquí (lo ataja `catalogoSinTipar`),
  // pero una herramienta suelta sin `intents` dentro de un catálogo tipado sí:
  // antes reventaba con `TypeError: tool.intents is not iterable` y tumbaba la
  // petición entera. Sin intents no puntúa; no rompe.
  for (const intent of Array.isArray(tool.intents) ? tool.intents : []) {
    const needle = normalizeText(intent);
    // Un intent que se queda vacío al normalizar (solo puntuación) casaría con
    // TODO, porque `includes("")` es siempre cierto: sería la herramienta de
    // escritura de un cliente descuidado adjuntada a cualquier petición.
    if (!needle) continue;
    if (haystack.includes(needle)) score += 2;
    else if (needle.split(/\s+/).some((w) => w.length > 3 && haystack.includes(w))) {
      score += 1;
    }
  }
  return score;
}
