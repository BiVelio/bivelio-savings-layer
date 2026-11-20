"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  INSIGNIA_PH,
  insigniaAlcanzable,
  programarFranja,
  tocaInsignia,
  varianteAlMontar,
  type LugarInsignia,
  type Variante,
} from "./franja-lanzamiento";

/** Nada a lo que suscribirse: solo interesa si el render es de hidratación. */
const sinSuscripcion = () => () => {};

/**
 * ¿Este render es el del servidor o el de la hidratación? React usa
 * `getServerSnapshot` (true) en los dos y `getSnapshot` (false) en cualquier
 * montaje posterior, como el de una navegación dentro de la web. Sirve también
 * en una frontera de Suspense que hidrate más tarde, donde un indicador de
 * módulo ya activado mentiría.
 */
const useHidratando = () => useSyncExternalStore(sinSuscripcion, () => false, () => true);

/**
 * LA VARIANTE EN EL CLIENTE, con el mismo motor que la franja (`programarFranja`):
 * `base` es la de la carga —fija desde el primer render— y `activa` la que toca
 * ahora, que un temporizador cambia al cruzar la frontera con la pestaña
 * abierta. Arrancan en `varianteAlMontar`: al hidratar, `inicial`, igual que
 * el servidor (sin discrepancias; el reloj del navegador la adelanta al montar
 * si el build es viejo, y el guion previo ya lo enseñó antes del primer
 * pintado); montado por una navegación dentro de la web, ya la del reloj, sin
 * pintar primero la ventana que pasó.
 */
function useVariante(inicial: Variante): { base: Variante; activa: Variante } {
  const hidratando = useHidratando();
  const [base, setBase] = useState<Variante>(() => varianteAlMontar(inicial, hidratando, Date.now()));
  const [activa, setActiva] = useState<Variante>(base);
  useEffect(() => {
    const motor = programarFranja(inicial, setActiva, {
      ahora: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
    });
    setBase(motor.variante());
    const alVolver = () => {
      if (document.visibilityState === "visible") motor.reevaluar();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      motor.cancelar();
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [inicial]);
  return { base, activa };
}

/**
 * LA INSIGNIA OFICIAL DE PRODUCT HUNT (tema light), en el héroe de la portada
 * (solo durante la campaña, dos semanas) y en el pie (desde el lanzamiento, siempre).
 *
 * Qué pinta, según la ventana de la CARGA (`base`):
 *   · si toca: el enlace con la imagen de PH, 250×54 reservados por los
 *     atributos (la imagen carga dentro de su hueco, sin empujar nada);
 *   · si todavía no toca pero puede llegar a tocar (un build de antes del
 *     22): un hueco VACÍO de 250×54, escondido (`data-ph-espera`). No hay
 *     <img> en el HTML: la imagen de PH no se pide antes de tiempo. Si el reloj
 *     del navegador ya cruzó (una página sin ISR, o la portada antes de
 *     regenerarse), el guion previo de NavBar enseña el hueco ANTES del primer
 *     pintado, y al montar el componente pone la imagen dentro: ni salto ni
 *     discrepancia de hidratación;
 *   · si ya no puede tocar (el héroe después del 29): nada.
 *
 * La presencia se fija con la variante de la CARGA, como la pila de la franja:
 * en una pestaña abierta al cruzar las 08:00Z la insignia no se inserta (movería
 * la página bajo los ojos de quien lee); sale en la siguiente carga. Al acabar
 * la semana con la pestaña abierta, la del héroe se vuelve invisible SIN soltar
 * su hueco.
 *
 * Privacidad: la imagen se pide a api.producthunt.com, que recibe la IP de
 * quien visita y, con `strict-origin-when-cross-origin`, solo el origen como
 * referer (nunca la ruta). El enlace, con `noreferrer`, no manda ninguno.
 */
export function InsigniaProductHunt({ lugar, inicial, nuevaPestana }: { lugar: LugarInsignia; inicial: Variante; nuevaPestana: string }) {
  const { base, activa } = useVariante(inicial);
  if (!insigniaAlcanzable(lugar, base)) return null;
  if (!tocaInsignia(lugar, base)) return <span className="ph-insignia" data-ph-espera={lugar} aria-hidden="true" />;
  const oculta = !tocaInsignia(lugar, activa);
  return (
    <a
      className="ph-insignia"
      data-ph={lugar}
      data-oculta={oculta || undefined}
      aria-hidden={oculta || undefined}
      href={INSIGNIA_PH.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- la insignia
          oficial, servida por Product Hunt (SVG con el recuento en vivo):
          next/image no puede ni debe tocarla. */}
      <img
        src={INSIGNIA_PH.src}
        width={INSIGNIA_PH.width}
        height={INSIGNIA_PH.height}
        alt={INSIGNIA_PH.alt}
        lang="en"
        // En el héroe está en la primera pantalla; en el pie, lejos.
        loading={lugar === "pie" ? "lazy" : undefined}
        decoding="async"
        // No es el LCP: baja prioridad, y así React no la anuncia con un
        // <link rel="preload"> que competiría con el paisaje del héroe.
        fetchPriority="low"
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <span className="sr-only"> {nuevaPestana}</span>
    </a>
  );
}
