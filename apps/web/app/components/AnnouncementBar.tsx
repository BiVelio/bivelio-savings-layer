"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { ArrowRightIcon, CloseIcon, VotoIcon } from "./icons";
import {
  URL_PRODUCT_HUNT,
  alcanzables,
  atado,
  fechaAtada,
  partirCola,
  programarFranja,
  retirarHojaPrevia,
  type Variante,
} from "./franja-lanzamiento";

/**
 * La franja negra sobre el nav — misma pieza que abre bivelio.com. Aquí lleva
 * de vuelta a la web corporativa, para que savings.bivelio.com se lea como una
 * superficie más del mismo sitio y no como otro producto.
 *
 * Arranca VISIBLE y sin persistencia, exactamente como el <AnnouncementBar> del
 * origen. Una versión anterior decidía en un useEffect leyendo localStorage: el
 * servidor devolvía null, el documento pintaba con el nav pegado arriba y al
 * hidratar se insertaban 38px que empujaban la página entera. Recordar el
 * cierre cuesta un salto de layout en cada carga, y no lo vale.
 *
 * LANZAMIENTO EN PRODUCT HUNT (22-11-2026). Durante la campaña la franja pasa a
 * ser la de Product Hunt (ver franja-lanzamiento.ts) y cambia SOLA, sin
 * despliegue:
 *
 *   · `inicial` la calcula el servidor (NavBar) con su reloj. Como las páginas
 *     son estáticas, ese reloj es el del BUILD: el de la última regeneración
 *     ISR en la portada y precios (cada hora), y el del DESPLIEGUE en todas las
 *     demás, que no se regeneran. El primer render del cliente usa el mismo
 *     valor, así que el marcado coincide y no hay error de hidratación.
 *   · Antes del primer pintado, el guion en línea de <GuionFranja> (NavBar)
 *     corrige con una hoja de estilo la variante de un build viejo, sin tocar
 *     el DOM (ver guionPrevio en franja-lanzamiento.ts).
 *   · Al montar se reevalúa con el reloj del navegador (`programarFranja`), y
 *     un temporizador dispara justo al cruzar la siguiente frontera si la
 *     pestaña sigue abierta (y al volver a ella, por si el equipo durmió).
 *   · La altura no salta: las variantes que esta página aún puede enseñar se
 *     apilan en la MISMA celda de rejilla y solo la activa es visible. La
 *     franja mide siempre lo que la más alta, en cualquier ancho e idioma. La
 *     pila se fija con la variante AL CARGAR (`base`): las que ya pasaron
 *     salen de ella, como las sacó la hoja del guion, y un cruce con la
 *     pestaña abierta no cambia la altura. Una página cargada después del 29
 *     solo pinta la de BiVelio: idéntica a la de antes.
 */
export function AnnouncementBar({ inicial = "bivelio", fecha = "" }: { inicial?: Variante; fecha?: string }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const [visible, setVisible] = useState(true);
  // `base`: la variante al cargar, que fija la pila; `activa`: la que se ve.
  const [base, setBase] = useState<Variante>(inicial);
  const [activa, setActiva] = useState<Variante>(inicial);
  const [montada, setMontada] = useState(false);

  useEffect(() => {
    const franja = programarFranja(inicial, setActiva, {
      ahora: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
    });
    setBase(franja.variante());
    setMontada(true);
    const alVolver = () => {
      if (document.visibilityState === "visible") franja.reevaluar();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      franja.cancelar();
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [inicial]);

  // Ya pinta el estado lo mismo que pintaba la hoja del guion: fuera la hoja
  // (si no, se quedaría fijando esa variante al cruzar la siguiente frontera).
  useEffect(() => {
    if (montada) retirarHojaPrevia();
  }, [montada]);

  if (!visible) return null;

  const enlace = (v: Variante) => {
    const oculta = v !== activa;
    // Las que no tocan siguen ocupando su sitio (para fijar la altura), pero
    // invisibles: `visibility: hidden` las saca del foco y del árbol accesible.
    // `data-v`: por él las encuentra la hoja del guion previo. Fuera de la
    // campaña no hay guion ni atributo: el marcado de siempre.
    const comunes = { "data-v": inicial === "bivelio" ? undefined : v, "aria-hidden": oculta || undefined, "data-oculta": oculta || undefined } as const;
    if (v === "bivelio") {
      return (
        <a key={v} {...comunes} href={`https://bivelio.com/${locale}`} target="_blank" rel="noopener noreferrer">
          {t("announce")} <ArrowRightIcon />
        </a>
      );
    }
    const [cabeza, cola] = partirCola(
      atado(v === "aviso" ? t("announcePhSoon", { date: fechaAtada(fecha) }) : t("announcePhLive")),
    );
    return (
      <a key={v} {...comunes} href={URL_PRODUCT_HUNT} target="_blank" rel="noopener">
        <VotoIcon className="announce-voto" />
        {cabeza}
        {/* La última palabra y la flecha, juntas: la flecha nunca se queda
            sola en la última línea. El aviso para lectores de pantalla va
            después. */}
        <span className="announce-cola">
          {cola}
          {"\u00A0"}
          <ArrowRightIcon />
        </span>
        <span className="sr-only"> {t("newTab")}</span>
      </a>
    );
  };

  return (
    <div className={activa === "bivelio" ? "announce" : "announce announce--ph"} data-variante={activa}>
      <div className="announce-pila">{alcanzables(base).map(enlace)}</div>
      <button type="button" className="announce-close" aria-label={t("announceClose")} onClick={() => setVisible(false)}>
        <CloseIcon />
      </button>
    </div>
  );
}
