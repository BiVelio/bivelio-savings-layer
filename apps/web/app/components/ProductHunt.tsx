"use client";

import { useEffect, useState } from "react";

import { ArrowRightIcon } from "./icons";
import {
  INSIGNIA_PH,
  URL_TARJETA_PH,
  atado,
  botonDeLaTarjeta,
  insigniaAlcanzable,
  partirCola,
  programarFranja,
  tocaInsignia,
  type LugarInsignia,
  type Variante,
} from "./franja-lanzamiento";

/**
 * LA VARIANTE EN EL CLIENTE, con el mismo motor que la franja (`programarFranja`):
 * `base` es la de la carga —el servidor la trae y, al montar, el reloj del
 * navegador la adelanta si el build es viejo— y `activa` la que toca ahora,
 * que un temporizador cambia al cruzar la frontera con la pestaña abierta.
 * El primer render del cliente usa `inicial`, igual que el servidor: sin
 * discrepancias de hidratación.
 */
function useVariante(inicial: Variante): { base: Variante; activa: Variante } {
  const [base, setBase] = useState<Variante>(inicial);
  const [activa, setActiva] = useState<Variante>(inicial);
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
 * (solo la semana del lanzamiento) y en el pie (desde el lanzamiento, siempre).
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

/**
 * El botón coral de la tarjeta nativa «Find us on Product Hunt». Sus dos
 * textos —«avísame» antes del lanzamiento, «échale un vistazo →» desde él— se
 * apilan SIEMPRE en la misma celda de rejilla y solo se ve el que toca: el
 * botón, y con él la tarjeta, miden lo mismo en las tres ventanas, al hidratar
 * y al cruzar la frontera con la pestaña abierta. El guion previo cambia el
 * visible antes del primer pintado si la página es de un build viejo.
 */
export function BotonProductHunt({ inicial, aviso, vivo, nuevaPestana }: { inicial: Variante; aviso: string; vivo: string; nuevaPestana: string }) {
  const { activa } = useVariante(inicial);
  const visible = botonDeLaTarjeta(activa);
  const [cabeza, cola] = partirCola(atado(vivo));
  return (
    <a className="ph-boton" href={URL_TARJETA_PH} target="_blank" rel="noopener">
      <span className="ph-pila">
        <span data-ph-boton="aviso" data-oculta={visible !== "aviso" || undefined} aria-hidden={visible !== "aviso" || undefined}>
          {atado(aviso)}
        </span>
        <span data-ph-boton="vivo" data-oculta={visible !== "vivo" || undefined} aria-hidden={visible !== "vivo" || undefined}>
          {cabeza}
          <span className="ph-cola">
            {cola}
            {" "}
            <ArrowRightIcon />
          </span>
        </span>
      </span>
      <span className="sr-only"> {nuevaPestana}</span>
    </a>
  );
}
