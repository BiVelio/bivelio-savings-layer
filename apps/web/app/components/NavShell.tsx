"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * ¿Se ha desplazado la página? Solo para pintar el hairline y el velo de la
 * cabecera cuando deja de estar sobre el inicio. Es estado de PRESENTACIÓN:
 * no lee cookies ni sesión, así que no hace dinámica ninguna ruta.
 */
function useDesplazado(umbral = 4): boolean {
  const [desplazado, setDesplazado] = useState(false);
  useEffect(() => {
    const medir = () => setDesplazado(window.scrollY > umbral);
    medir();
    window.addEventListener("scroll", medir, { passive: true });
    return () => window.removeEventListener("scroll", medir);
  }, [umbral]);
  return desplazado;
}

/**
 * La caja pegajosa de la cabecera pública: 56px, marfil translúcido con blur
 * y una línea fina que aparece al desplazarse (`data-scrolled`). El contenido
 * llega como `children` desde `NavBar`, que sigue siendo de servidor.
 */
export function NavShell({ children }: { children: ReactNode }) {
  const desplazado = useDesplazado();
  return (
    <header className="site-nav" data-scrolled={desplazado ? "true" : undefined}>
      {children}
    </header>
  );
}
