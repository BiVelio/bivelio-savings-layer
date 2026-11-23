"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Analytics } from "@vercel/analytics/react";

import { propsDeAnalytics } from "@/lib/medicion/eventos";
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
 *
 * Es el `<Analytics>` de React, no el de `@vercel/analytics/next`, a propósito:
 * el de Next calcula la ruta él mismo y la de un 404 salía en bruto
 * (`/[locale]/alguien@example.com`), sin que `beforeSend` pudiera tocarla. Aquí
 * la ruta y el camino llegan ya limpios (`rutaParaVercel`). Lo demás que hace el
 * de Next se repite: `framework`, y el basePath y la configuración que Vercel
 * inyecta en el build (las rutas fijadas mandan sobre ellos).
 */

export function MedicionWeb() {
  const pathname = usePathname();
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

  return (
    <Analytics
      {...propsDeAnalytics(pathname)}
      basePath={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH}
      configString={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG}
    />
  );
}
