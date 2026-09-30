// ═══════════════════════════════════════════════════════════════════════════
// EL MOTIVO DE PARADA, CERRADO (0.5, docs/MIGRAR-A-0.5.md §4).
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta la 0.4.x `finishReason` era una cadena abierta: los adaptadores
// traducían lo común (`end_turn` → `stop`, `max_tokens` → `length`, `tool_use`
// → `tool_calls`) y lo demás pasaba tal cual (`stop_sequence`, `pause_turn`,
// `MALFORMED_FUNCTION_CALL`…). Un cliente que comparaba contra esos literales
// dependía del proveedor. Desde la 0.5 el valor es uno de cinco, el mismo para
// todos, y el del proveedor va APARTE, en `finishReasonDetail`.
//
// LA REGLA DEL DETALLE, una sola para todos los adaptadores:
//   · si el adaptador ya trae un motivo más fino (la categoría de la negativa
//     de Anthropic, el `blockReason` o la parada de filtro de Gemini, el motivo
//     de `content_filter: OTHER`), ese es el detalle;
//   · si no, el detalle es el literal del proveedor SALVO que sea la ortografía
//     llana de uno de los cinco (`stop`, `end_turn`, `STOP`, `length`,
//     `max_tokens`, `MAX_TOKENS`, `tool_calls`, `tool_use`, `content_filter`):
//     esos no añaden información y no se repiten.
//
// PURO Y SIN IMPORTS: lo usan los adaptadores y el pipeline (este, también con
// los proveedores de terceros, cuyo `finishReason` sigue siendo abierto).

/** Los cinco valores de `finishReason` desde la 0.5. */
export type MotivoDeParada = "stop" | "length" | "tool_calls" | "content_filter" | "other";

// Las ortografías llanas: se traducen y NO dejan detalle.
const LLANAS: Readonly<Record<string, MotivoDeParada>> = {
  stop: "stop",
  end_turn: "stop",
  STOP: "stop",
  length: "length",
  max_tokens: "length",
  MAX_TOKENS: "length",
  tool_calls: "tool_calls",
  tool_use: "tool_calls",
  content_filter: "content_filter",
  // Ya cerrado (el pipeline normaliza lo que el adaptador ya normalizó).
  other: "other",
};

// Las que se traducen pero SÍ dejan su literal como detalle, porque dicen algo
// más que el valor cerrado.
const CON_DETALLE: Readonly<Record<string, MotivoDeParada>> = {
  // Anthropic: paró en una secuencia de parada del llamante; es un final normal.
  stop_sequence: "stop",
  // Proveedores compatibles (vLLM, TGI…): fin de secuencia.
  eos: "stop",
  eos_token: "stop",
  // Anthropic: la ventana de contexto se llenó antes del tope; la respuesta
  // está CORTADA igual que con `max_tokens`, y el pipeline no debe cachearla.
  model_context_window_exceeded: "length",
  // OpenAI heredado (antes de `tool_calls`).
  function_call: "tool_calls",
  // Anthropic: negativa sin categoría (con categoría, el detalle es ella).
  refusal: "content_filter",
  // Gemini nativo, por si llegan sin pasar por su adaptador.
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  IMAGE_RECITATION: "content_filter",
};

const FILTRO_CON_MOTIVO = /^content_filter\s*:\s*(.*?)\s*$/;

/**
 * Normalizes a provider's stop reason to the closed set of 0.5 and keeps the
 * provider's own value apart. `detalle` is a finer reason the adapter already
 * has (a refusal category, a block reason); it wins over the raw literal.
 * Unknown values become `"other"` with the literal as the detail.
 */
export function cerrarParada(
  parada: string | null | undefined,
  detalle?: string | undefined,
): { finishReason?: MotivoDeParada; finishReasonDetail?: string } {
  const fino = typeof detalle === "string" && detalle !== "" ? detalle : undefined;
  if (typeof parada !== "string" || parada === "") {
    return fino !== undefined ? { finishReasonDetail: fino } : {};
  }
  const llana = LLANAS[parada];
  if (llana !== undefined) return { finishReason: llana, ...(fino !== undefined ? { finishReasonDetail: fino } : {}) };
  const m = FILTRO_CON_MOTIVO.exec(parada);
  if (m !== null) {
    const motivo = fino ?? (m[1] !== undefined && m[1] !== "" ? m[1] : undefined);
    return { finishReason: "content_filter", ...(motivo !== undefined ? { finishReasonDetail: motivo } : {}) };
  }
  const traducida = CON_DETALLE[parada] ?? "other";
  return { finishReason: traducida, finishReasonDetail: fino ?? parada };
}

/** ¿Es ya uno de los cinco? */
export function esMotivoCerrado(v: unknown): v is MotivoDeParada {
  return v === "stop" || v === "length" || v === "tool_calls" || v === "content_filter" || v === "other";
}
