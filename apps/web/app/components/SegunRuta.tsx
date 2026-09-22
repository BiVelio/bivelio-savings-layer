"use client";

import type { ReactNode } from "react";

import { usePathname } from "@/i18n/navigation";

/**
 * UNO DE DOS BLOQUES, SEGÚN LA RUTA — decidido en el navegador, para que la
 * 404 no lea cabeceras en el servidor.
 *
 * LO QUE PASABA. `not-found.tsx` preguntaba a `headers()` si la URL pedida caía
 * bajo /dashboard para ofrecer «volver al resumen». Next incluye el límite de
 * «no encontrado» en el prerender de TODAS las rutas del segmento, así que esa
 * sola llamada hacía dinámicas la portada, «Cómo funciona», el alta y el
 * restablecimiento de contraseña: se renderizaban en una función en cada
 * visita en vez de servirse estáticas desde el borde. Medido el 22-09-2026 con
 * `dynamic = "error"`: «couldn't be rendered statically because it used
 * `headers`», con la pila en `bajoElPanel` de not-found.tsx.
 *
 * Los dos bloques llegan ya renderizados por el servidor con sus textos; aquí
 * solo se elige cuál se ve. `usePathname` de next-intl devuelve la ruta sin el
 * prefijo de idioma.
 */
export function SegunRuta({ panel, publico }: { panel: ReactNode; publico: ReactNode }) {
  const pathname = usePathname();
  const bajoElPanel = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  return <>{bajoElPanel ? panel : publico}</>;
}
