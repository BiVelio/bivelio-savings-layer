/** La lista de guías, sin node:fs: la importa también código de cliente (lib/medicion/eventos.ts). */

/**
 * El tema de una guía: la etiqueta de su tarjeta en el índice. El texto, en
 * cada idioma, está en `messages/<idioma>.json` → `guidesPage.topics.<tema>`.
 */
export type TemaDeGuia = "openai" | "anthropic" | "claudeCode" | "deepseekQwen" | "deduplication" | "verification";

export interface Guia {
  /** El último tramo de la URL: /<idioma>/guides/<slug>. */
  slug: string;
  /** El titular inglés: el `<h1>` y el `<title>` de la edición /en. */
  title: string;
  /** La meta description inglesa y la entradilla del índice (≤ 160 caracteres). */
  description: string;
  /** Su tema (la etiqueta del índice), que sale del slug: el proveedor o la técnica de la que trata. */
  tema: TemaDeGuia;
  /** Fecha de publicación, ISO (AAAA-MM-DD). */
  date: string;
  /** Fecha de la última revisión de fondo, si la hubo. */
  updated?: string;
  /**
   * La guía que abre el índice a todo el ancho, con su propia composición en
   * escritorio (titular a la izquierda; descripción y pie a la derecha). Se
   * elige aquí, a mano, y como mucho una: no depende de cuántas guías haya.
   */
  destacada?: true;
}

/** Las guías publicadas, en el orden en que las lista el índice. */
export const GUIAS: readonly Guia[] = [
  {
    slug: "reduce-openai-api-costs",
    title: "How to reduce OpenAI API costs, and prove each saving",
    description:
      "Six levers that cut an OpenAI bill: caching, deduplication, Batch, model choice, output and input size. When each one pays, and how to check it on your usage.",
    tema: "openai",
    date: "2026-11-23",
    destacada: true,
  },
  {
    slug: "claude-prompt-caching-not-working",
    title: "Claude prompt caching not working? Why cache reads stay at 0",
    description:
      "Why cache_read_input_tokens stays at 0 on Claude, how to find the byte that breaks the prefix, and how to check your hit rate against Anthropic's usage numbers.",
    tema: "anthropic",
    date: "2026-11-23",
  },
  {
    slug: "claude-code-cost-per-request",
    title: "How much does Claude Code cost? Measure it request by request",
    description:
      "What Claude Code costs on an API key, what /usage and the Console show, and how to see the cost of every request with a free local gateway.",
    tema: "claudeCode",
    date: "2026-11-23",
  },
  {
    slug: "openai-prompt-caching-cached-tokens",
    title: "OpenAI prompt caching: why cached_tokens is 0 and how to fix it",
    description:
      "A checklist for OpenAI prompt caching when cached_tokens stays at 0: prompt length, prefix order, eviction, routing and streams, with code to track the hit rate.",
    tema: "openai",
    date: "2026-11-23",
  },
  {
    slug: "deduplicate-llm-requests",
    title: "Deduplicate identical LLM requests: exact cache and in-flight coalescing",
    description:
      "Stop paying twice for the same LLM call: a safe cache key, what never to cache, coalescing identical requests in flight, and how to check the saving.",
    tema: "deduplication",
    date: "2026-11-23",
  },
  {
    slug: "deepseek-qwen-api-cost-local-gateway",
    title: "DeepSeek and Qwen API costs: see cache hits and spend per request",
    description:
      "How DeepSeek and Qwen bill cache hits and misses, how to price a request from its usage fields, and how to meter every request with a free local gateway.",
    tema: "deepseekQwen",
    date: "2026-11-23",
  },
  {
    slug: "verify-llm-savings-against-provider-bill",
    title: "How to verify LLM cost savings against your provider's bill",
    description:
      "A method to check any LLM savings claim: log the provider's counters, reconcile tokens before dollars, keep measured and estimated apart, and attribute the saving.",
    tema: "verification",
    date: "2026-11-23",
  },
];
