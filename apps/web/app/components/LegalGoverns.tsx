import type { ReactNode } from "react";

import { corporateUrl } from "@/lib/corporate";

/**
 * La LICENSE tal como viaja en la última versión publicada del paquete (el
 * texto que acepta quien instala). unpkg sirve el fichero del tarball de npm,
 * sin una copia nuestra que se pueda quedar atrás.
 */
export const LICENSE_URL = "https://unpkg.com/@bivelio/savings-layer/LICENSE";

type Etiqueta = (c: ReactNode) => ReactNode;

/**
 * Las dos etiquetas rich de la línea que abre /pricing y /privacy («This page
 * describes how the service works today; the <license>LICENSE</license> and
 * the <terms>BiVelio Terms</terms> govern.»). Esas páginas DESCRIBEN el
 * servicio de hoy; lo que rige es la LICENSE y los BiVelio Terms.
 */
export function etiquetasQueRigen(locale: string): { license: Etiqueta; terms: Etiqueta } {
  return {
    license: (c) => (
      <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
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
