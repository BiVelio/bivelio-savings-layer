import type { ReactNode } from "react";

import { corporateUrl } from "@/lib/corporate";

/**
 * Las condiciones de la NUBE (LICENSE-CLOUD.md), en `main` de GitHub: lo que
 * rige Savings Cloud —cuotas (§6), datos (§5)— y lo que acepta quien crea la
 * cuenta (`auth.signupLegal`). La LICENSE del paquete es la Apache-2.0, que no
 * habla de precios ni de datos; enlazarla aquí mandaba al comprador a un texto
 * que no era el suyo (auditoría de medios, nov-2026, m09).
 *
 * `main` y no unpkg: unpkg sirve el fichero de la ÚLTIMA versión publicada en
 * npm, que puede ser anterior a estas páginas (el 2026-09-26 servía la LICENSE
 * de la 0.4.24). Aun así, ninguna frase de /pricing ni de
 * /privacy afirma qué dice el documento enlazado; solo que rige (`governs`). Lo
 * vigila `lib/legal/precios-publicados.test.ts`.
 */
export const LICENSE_CLOUD_URL = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md";

type Etiqueta = (c: ReactNode) => ReactNode;

/**
 * Las dos etiquetas rich de la línea que abre /pricing y /privacy («This page
 * describes how the service works today; the <license>Savings Cloud terms
 * (LICENSE-CLOUD.md)</license> and the <terms>BiVelio Terms</terms> govern.»).
 * Esas páginas DESCRIBEN el servicio de hoy; lo que rige son las condiciones de
 * la nube y los BiVelio Terms. La etiqueta se sigue llamando `license` para no
 * tocar los doce idiomas por un nombre interno.
 */
export function etiquetasQueRigen(locale: string): { license: Etiqueta; terms: Etiqueta } {
  return {
    license: (c) => (
      <a href={LICENSE_CLOUD_URL} target="_blank" rel="noopener noreferrer">
        {c}
      </a>
    ),
    terms: (c) => (
      <a href={corporateUrl("/terms", locale)} target="_blank" rel="noopener noreferrer">
        {c}
      </a>
    ),
  };
}
