"use client";

import { useEffect } from "react";
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

import { RUTAS_DE_VERCEL, urlSinDatos } from "@/lib/medicion/eventos";
import { medirClic, medirCopiaManual } from "@/lib/medicion/medir";

/**
 * MEDICIÓN DE LA WEB (Vercel Web Analytics) — una sola vez, en el layout del idioma.
 *
 * Cuenta las vistas de página y tres acciones (lib/medicion/eventos.ts): copiar
 * un comando de instalación, salir a GitHub/npm/PyPI y pasar al alta. Sin
 * cookies, sin identificadores y en agregado; el paquete sigue sin telemetría.
 *
 * Los clics y las copias a mano se escuchan aquí, en el documento y en fase de
 * captura, en vez de tocar cada enlace: así cuentan también los del pie y la
 * cabecera, y los de páginas futuras. El botón «Copiar» de los bloques de
 * código cuenta por su cuenta (`CopiarCodigo`): `navigator.clipboard` no
 * dispara el evento `copy`, así que no hay doble cuenta.
 */

/** Toda vista y todo evento salen con la URL limpia; si no se puede limpiar, no salen. */
function sinDatos(evento: BeforeSendEvent): BeforeSendEvent | null {
  const url = urlSinDatos(evento.url);
  return url ? { ...evento, url } : null;
}

export function MedicionWeb() {
  useEffect(() => {
    const alClic = (e: MouseEvent) => {
      // `auxclick` solo para el botón central (abrir en otra pestaña).
      if (e.type === "auxclick" && e.button !== 1) return;
      medirClic(e.target);
    };
    const alCopiar = () => medirCopiaManual(document.getSelection());
    document.addEventListener("click", alClic, true);
    document.addEventListener("auxclick", alClic, true);
    document.addEventListener("copy", alCopiar, true);
    return () => {
      document.removeEventListener("click", alClic, true);
      document.removeEventListener("auxclick", alClic, true);
      document.removeEventListener("copy", alCopiar, true);
    };
  }, []);

  return <Analytics beforeSend={sinDatos} {...RUTAS_DE_VERCEL} />;
}
