import { llmsTxt } from "@/lib/llms/llms";

/**
 * /llms.txt — el índice para asistentes (formato de llmstxt.org): qué es,
 * cómo se instala y dónde está cada cosa. Va en la RAÍZ, sin idioma: el
 * `matcher` de middleware.ts lo deja fuera de next-intl (antes, `/llms.txt`
 * redirigía a `/en/llms.txt`, que daba 404). Se genera al construir.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsTxt(), {
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}
