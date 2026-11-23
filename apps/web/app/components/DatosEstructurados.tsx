import { serializarJsonLd } from "@/lib/seo/datos-estructurados";

/**
 * Un bloque JSON-LD (`<script type="application/ld+json">`). Es un bloque de
 * datos, no un script: el navegador no lo ejecuta y la CSP no lo toca. Se
 * pinta desde la página (no desde el layout) para que cada página declare solo
 * lo que de verdad enseña.
 */
export function DatosEstructurados({ datos }: { datos: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializarJsonLd(datos) }} />;
}
