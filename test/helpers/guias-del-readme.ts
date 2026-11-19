/**
 * LOS CATORCE APARTADOS OPCIONALES QUE SALIERON DEL README (1.2.3).
 *
 * npm corta el README a 64 KiB y el nuestro pesaba 88 KB: la página del paquete
 * acababa a media frase y sin «Licensing & privacy» (auditoría P7). Los
 * desplegables opcionales se movieron, con el texto tal cual, a docs/guias, y el
 * README deja una línea por apartado con un enlace absoluto a GitHub.
 *
 * Esta lista es la única fuente para las pruebas que antes leían esos textos en
 * el README: siguen leyéndolos, ahora en su guía.
 */
export const APARTADOS_MOVIDOS: ReadonlyArray<{ titulo: string; guia: string }> = [
  { titulo: "Your own A/B — verification sampling (opt-in, off by default)", guia: "docs/guias/medir.md" },
  { titulo: "Cross-provider shadow: what your usage would cost elsewhere (measure-only)", guia: "docs/guias/medir.md" },
  { titulo: "Provider price levers (opt-in, off by default)", guia: "docs/guias/palancas-de-precio.md" },
  { titulo: "Prompt-cache breakpoints placed from your traffic (opt-in)", guia: "docs/guias/cache-de-prompt.md" },
  {
    titulo: "Cache-aware prompt management: mutable tokens out of the cacheable prefix (opt-in)",
    guia: "docs/guias/cache-de-prompt.md",
  },
  { titulo: "Tool outputs, compacted where they are born (opt-in, off by default)", guia: "docs/guias/herramientas.md" },
  { titulo: "Tool calls", guia: "docs/guias/herramientas.md" },
  { titulo: "Serverless: keep what the layer learns between instances", guia: "docs/guias/persistencia.md" },
  { titulo: "Customer-operated PostgreSQL for caches and learning", guia: "docs/guias/persistencia.md" },
  { titulo: "Structured output — validated `data`, not just text", guia: "docs/guias/peticiones.md" },
  { titulo: "Gemini: the native adapter", guia: "docs/guias/peticiones.md" },
  { titulo: "Output cap — with or without a contract", guia: "docs/guias/peticiones.md" },
  { titulo: "Your ledgers in your tracing — OpenTelemetry, Langfuse, Datadog", guia: "docs/guias/exportar.md" },
  {
    titulo: "Your ledgers in your FinOps tool — FOCUS rows and a daily savings series",
    guia: "docs/guias/exportar.md",
  },
];

/** Las guías, sin repetir, en el orden en que el README las enlaza. */
export const GUIAS_DEL_README: readonly string[] = [...new Set(APARTADOS_MOVIDOS.map((a) => a.guia))];
