import { normalizeText } from "../canonicalization/canonicalize.js";
import type { ExecutionClass, ToolDescriptor } from "../contracts/types.js";

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
}

export interface ToolSelectorOptions {
  /** Max tools to include (schema-token budget guard). */
  maxTools?: number;
  /** Tokenizer-aware scorer for tie-breaking (optional). */
  scoreIntentMatch?: (text: string, tool: ToolDescriptor) => number;
}

export class ToolSelector {
  private readonly maxTools: number;
  private readonly scoreIntentMatch: (text: string, tool: ToolDescriptor) => number;

  constructor(opts: ToolSelectorOptions = {}) {
    this.maxTools = opts.maxTools ?? 8;
    this.scoreIntentMatch = opts.scoreIntentMatch ?? defaultScore;
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
      return { tools: [], droppedIds: [], reason: "no tools provided" };
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
    };
  }

  select(
    text: string,
    tools: ToolDescriptor[] | undefined,
    execution: ExecutionClass,
  ): ToolSelection {
    if (!tools || tools.length === 0) {
      return { tools: [], droppedIds: [], reason: "no tools provided" };
    }

    // A non-TOOL_ACTION request never receives write/destructive tools.
    const allowWrites = execution === "TOOL_ACTION";
    const eligible = tools.filter((t) => allowWrites || t.risk === "read");

    const scored = eligible
      .map((tool) => ({ tool, score: this.scoreIntentMatch(text, tool) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxTools);

    const selected = scored.map((s) => s.tool);
    const selectedIds = new Set(selected.map((t) => t.id));
    const droppedIds = tools.filter((t) => !selectedIds.has(t.id)).map((t) => t.id);

    return {
      tools: selected,
      droppedIds,
      reason: `selected ${selected.length}/${tools.length} by intent match (writes ${allowWrites ? "allowed" : "blocked"})`,
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
  for (const intent of tool.intents) {
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
