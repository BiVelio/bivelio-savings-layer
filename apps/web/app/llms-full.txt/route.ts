import { leerReadme, llmsFull } from "@/lib/llms/llms";

/**
 * /llms-full.txt — la sustancia del README del repositorio en texto plano,
 * generada AL CONSTRUIR desde el propio README (lib/llms/llms.ts): en
 * ejecución no se lee nada fuera de apps/web, y si el README pierde una de
 * las secciones que se publican, el build falla en vez de servir un hueco.
 * En la raíz y sin idioma, como /llms.txt.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsFull(leerReadme()), {
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}
