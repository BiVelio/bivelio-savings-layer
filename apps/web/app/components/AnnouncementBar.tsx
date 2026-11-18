"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { ArrowRightIcon, CloseIcon, VotoIcon } from "./icons";
import {
  URL_PRODUCT_HUNT,
  alcanzables,
  atado,
  elegirVariante,
  esperaHastaLaFrontera,
  laMasAvanzada,
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
 *     son estáticas, ese reloj es el del BUILD (o el de la última regeneración
 *     ISR, cada hora). El primer render del cliente usa
 *     el mismo valor, así que el marcado coincide y no hay error de hidratación.
 *   · Al montar se reevalúa con el reloj del navegador, y un temporizador
 *     dispara justo al cruzar la siguiente frontera si la pestaña sigue abierta
 *     (y al volver a ella, por si el equipo durmió).
 *   · La altura no salta: las variantes que esta página aún puede enseñar se
 *     apilan en la MISMA celda de rejilla y solo la activa es visible. La
 *     franja mide siempre lo que la más alta, en cualquier ancho e idioma.
 *     Una página construida después del 29 solo pinta la de BiVelio: idéntica
 *     a la de antes.
 */
export function AnnouncementBar({ inicial = "bivelio", fecha = "" }: { inicial?: Variante; fecha?: string }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const [visible, setVisible] = useState(true);
  const [activa, setActiva] = useState<Variante>(inicial);

  useEffect(() => {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const reevaluar = () => {
      clearTimeout(temporizador);
      const ahora = Date.now();
      // Nunca hacia atrás: la hora del build es una cota inferior de la real,
      // y un reloj que retrocede no devuelve una ventana que ya pasó.
      setActiva((previa) => laMasAvanzada(laMasAvanzada(inicial, previa), elegirVariante(ahora)));
      const espera = esperaHastaLaFrontera(ahora);
      if (espera !== null) temporizador = setTimeout(reevaluar, espera);
    };
    const alVolver = () => {
      if (document.visibilityState === "visible") reevaluar();
    };
    reevaluar();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      clearTimeout(temporizador);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [inicial]);

  if (!visible) return null;

  const enlace = (v: Variante) => {
    const oculta = v !== activa;
    // Las que no tocan siguen ocupando su sitio (para fijar la altura), pero
    // invisibles: `visibility: hidden` las saca del foco y del árbol accesible.
    const comunes = { "aria-hidden": oculta || undefined, "data-oculta": oculta || undefined } as const;
    if (v === "bivelio") {
      return (
        <a key={v} {...comunes} href={`https://bivelio.com/${locale}`} target="_blank" rel="noopener noreferrer">
          {t("announce")} <ArrowRightIcon />
        </a>
      );
    }
    return (
      <a key={v} {...comunes} href={URL_PRODUCT_HUNT} target="_blank" rel="noopener">
        <VotoIcon className="announce-voto" />
        {atado(v === "aviso" ? t("announcePhSoon", { date: fecha }) : t("announcePhLive"))}
        <span className="sr-only"> {t("newTab")}</span> <ArrowRightIcon />
      </a>
    );
  };

  return (
    <div className={activa === "bivelio" ? "announce" : "announce announce--ph"} data-variante={activa}>
      <div className="announce-pila">{alcanzables(inicial).map(enlace)}</div>
      <button type="button" className="announce-close" aria-label={t("announceClose")} onClick={() => setVisible(false)}>
        <CloseIcon />
      </button>
    </div>
  );
}
