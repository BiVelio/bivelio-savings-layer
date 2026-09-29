// ═══════════════════════════════════════════════════════════════════════════
// LA PARADA POR FILTRO DE CONTENIDO, CON O SIN MOTIVO.
// ═══════════════════════════════════════════════════════════════════════════
//
// Chat Completions de OpenAI cierra una respuesta filtrada con
// `finish_reason: "content_filter"`, a secas. El endpoint compatible con OpenAI
// de Gemini (`generativelanguage.googleapis.com/v1beta/openai`) le añade el
// motivo nativo de Google detrás de dos puntos: `"content_filter: OTHER"`,
// `"content_filter: PROHIBITED_CONTENT"`. Medido en vivo en el banco XSTest de
// gama alta contra la 0.4.31 (docs/benchmarks/2026-09-28/xstest-0431-gama-alta.md,
// PR #396: 38 `OTHER` y 2 `PROHIBITED_CONTENT` en 450 llamadas de
// gemini-3.8-flash, siempre con `content` vacío). La guía de compatibilidad
// (https://ai.google.dev/gemini-api/docs/openai, «Last updated 2026-09-02
// UTC», consultada el 2026-09-29) no documenta esa forma; los motivos sí están
// en el enum `FinishReason` de la referencia nativa
// (https://ai.google.dev/api/generate-content, «Last updated 2026-09-23 UTC»):
// `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `OTHER`…
//
// Hasta aquí la capa comparaba `=== "content_filter"`, así que la negativa de
// Gemini no era negativa: se guardaba en la caché exacta y su repetición salía
// `reference`, comisionable. Este módulo es la ÚNICA definición de «parada por
// filtro», para el SDK (adaptador y pipeline) y para el gateway.
//
// PURO Y SIN IMPORTS: lo importan el pipeline, el adaptador compatible con
// OpenAI y el gateway (`gateway/medidor.ts`), que va en otro bundle.

const PARADA_DE_FILTRO = /^content_filter(?:\s*:\s*(.*?))?\s*$/;

/**
 * ¿Es este `finish_reason` una parada por filtro de contenido? `content_filter`
 * a secas o `content_filter:<motivo>` (con o sin espacio tras los dos puntos).
 * Cualquier otra cosa —`stop`, `length`, un `content_filtered` o `null`— no.
 */
export function esParadaDeFiltro(parada: unknown): boolean {
  return typeof parada === "string" && PARADA_DE_FILTRO.test(parada);
}

/**
 * El `finish_reason` en el vocabulario neutro de la capa: una parada por filtro
 * sale `"content_filter"` y su motivo, si lo traía, aparte (`detalle`). El
 * resto sale tal cual y sin detalle.
 */
export function normalizarParada(parada: string | undefined | null): { parada?: string; detalle?: string } {
  if (typeof parada !== "string") return {};
  const m = PARADA_DE_FILTRO.exec(parada);
  if (m === null) return { parada };
  const detalle = m[1];
  return typeof detalle === "string" && detalle !== ""
    ? { parada: "content_filter", detalle }
    : { parada: "content_filter" };
}
