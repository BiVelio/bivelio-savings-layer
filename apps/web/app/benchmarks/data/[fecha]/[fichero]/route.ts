import { cuerpoServido, informesServidos } from "@/lib/banco-publico/cargar";

/**
 * /benchmarks/data/<fecha>/<fichero>.json — los informes del banco público,
 * servidos desde la propia web (el repositorio es privado; decisión del dueño,
 * 2026-09-29).
 *
 * Se generan AL CONSTRUIR desde docs/benchmarks (`force-static` +
 * `generateStaticParams`), igual que la página: en ejecución no se lee nada
 * fuera de apps/web, y `dynamicParams = false` da 404 a lo que no se construyó.
 * Lo servido es la copia limpia del informe (lib/banco-publico/publicar.ts).
 * La ruta tiene extensión, así que el middleware de idiomas no la toca.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return informesServidos();
}

export async function GET(_req: Request, { params }: { params: Promise<{ fecha: string; fichero: string }> }) {
  const { fecha, fichero } = await params;
  const cuerpo = cuerpoServido(fecha, fichero);
  if (cuerpo === null) return new Response("Not found", { status: 404 });
  return new Response(cuerpo, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=3600, must-revalidate",
    },
  });
}
