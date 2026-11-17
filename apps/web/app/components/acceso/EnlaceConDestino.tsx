"use client";

import { useEffect, useState, type ReactNode } from "react";

import { safeNextPath } from "@/app/auth/safe-next";
import { Link } from "@/i18n/navigation";

/**
 * EL ENLACE ENTRE LOGIN Y ALTA QUE NO PIERDE EL DESTINO.
 *
 * LO QUE PASABA. Quien llegaba a `/login?next=/es/invitacion/…` (o a
 * `/signup?next=/es/dashboard?plan=pro`) y pulsaba «Crear una cuenta» (o
 * «Iniciar sesión») aterrizaba en la otra pantalla SIN el `next`: los enlaces
 * eran estáticos. El plan elegido o la invitación se perdían en ese salto.
 *
 * CÓMO SE ARREGLA SIN TOCAR NADA MÁS. El primer pintado es el enlace estático
 * de siempre —el mismo HTML que sale del servidor, así que no hay desajuste de
 * hidratación ni hace falta `useSearchParams()` (que sacaría a /login y
 * /signup de la generación estática; ver AuthForm)—. Después de montar se lee
 * `window.location.search` y, SOLO si trae un `next`, el enlace pasa a llevarlo.
 *
 * Mismo guardián que el resto del acceso (`safeNextPath`), y nunca se añade un
 * destino por defecto: ese guardián devuelve «/dashboard» para lo que rechaza,
 * de modo que un `next` que no sobrevive intacto se descarta en vez de
 * convertirse en un `?next=/dashboard` que nadie pidió.
 */
export function EnlaceConDestino({
  a,
  className,
  children,
}: {
  a: "/login" | "/signup";
  className?: string;
  children: ReactNode;
}) {
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    const pedido = new URLSearchParams(window.location.search).get("next");
    if (!pedido) return;
    const limpio = safeNextPath(pedido);
    if (limpio === "/dashboard" && pedido !== "/dashboard") return;
    setNext(limpio);
  }, []);

  return (
    <Link className={className} href={next ? { pathname: a, query: { next } } : a}>
      {children}
    </Link>
  );
}
