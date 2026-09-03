/**
 * S4a · LOS DIALES DEL PROVEEDOR — la configuración de `context_management`
 * (estrategia `clear_tool_uses_20250919`) que la palanca S4a ajusta o inyecta.
 *
 * Los tres números viven AQUÍ con nombre y justificación, y en ningún otro
 * sitio (docs/PLAN-S4-PALANCA.md § 2.2). El replay del anillo 0
 * (benchmarks/sombra-diales.ts) los mide contra `count_tokens` sin tocar
 * tráfico; el A/B del anillo 2 los podrá barrer.
 */

/** La cabecera beta que DEBE viajar con el campo `context_management` — campo
 *  sin cabecera (o al revés) es un 400 (PASARELA-S3-TERMINALES.md:34). */
export const BETA_CONTEXT_MANAGEMENT = "context-management-2025-06-27";

/** Umbral de disparo, en tokens de entrada. Los umbrales de fábrica no se
 *  dispararon NI UNA VEZ en 1.952 peticiones del corpus: este dial es EL
 *  cambio. 30K = el punto donde la masa tool_result de las sesiones reales
 *  amortiza de sobra la reescritura de caché posterior al borrado. */
export const DIAL_TRIGGER_INPUT_TOKENS = 30_000;

/** Resultados de herramienta que SIEMPRE se conservan (los más recientes).
 *  La venda de v0 —no tocar lo recién nacido— que el replay validó. */
export const DIAL_KEEP_TOOL_USES = 3;

/** Mínimo de tokens a borrar por pasada. Borrar 100 tokens no paga romper el
 *  prefijo en el punto del borrado; borrar en lotes grandes sí — es la
 *  monotonicidad aprendida en el replay (v2 vs v2m), expresada en el dial que
 *  el propio proveedor ofrece para eso. */
export const DIAL_CLEAR_AT_LEAST_INPUT_TOKENS = 5_000;

/** La config con la forma EXACTA de la API (se envía tal cual). */
export function configDeDiales(): {
  edits: {
    type: "clear_tool_uses_20250919";
    trigger: { type: "input_tokens"; value: number };
    keep: { type: "tool_uses"; value: number };
    clear_at_least: { type: "input_tokens"; value: number };
  }[];
} {
  return {
    edits: [
      {
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: DIAL_TRIGGER_INPUT_TOKENS },
        keep: { type: "tool_uses", value: DIAL_KEEP_TOOL_USES },
        clear_at_least: { type: "input_tokens", value: DIAL_CLEAR_AT_LEAST_INPUT_TOKENS },
      },
    ],
  };
}
