import katex, { type KatexOptions } from "katex";

/**
 * Fórmulas del paper, compuestas con KaTeX EN EL SERVIDOR.
 *
 * /paper es estática: estas llamadas corren al construir y el navegador recibe
 * HTML y MathML ya hechos (ningún JS de KaTeX llega al cliente; solo su CSS y
 * sus fuentes, que Next sirve desde /_next/static/media, dentro de la CSP
 * `font-src 'self'`).
 *
 * `throwOnError: true` y `strict: "error"`: una fórmula rota o fuera del LaTeX
 * estándar hace FALLAR el build, en vez de publicarse en rojo como
 * `.katex-error`. `output: "htmlAndMathml"`: el HTML es lo que se ve y el MathML
 * lo que leen los lectores de pantalla y lo que se copia.
 */
const OPCIONES = {
  output: "htmlAndMathml",
  throwOnError: true,
  strict: "error",
  trust: false,
} as const satisfies KatexOptions;

/** Una fórmula del paper -> HTML de KaTeX (en línea, o en bloque con `bloque`). */
export function formulaHtml(latex: string, bloque = false): string {
  return katex.renderToString(latex, { ...OPCIONES, displayMode: bloque });
}
