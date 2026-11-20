"use client";

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  CLAVE_FRANJA_CERRADA,
  PLATAFORMAS,
  filasDe,
  piezasDeFranja,
  plataforma,
  repartir,
  repartoDelServidor,
  retirarHojaDeLanzamiento,
  textoDe,
  type Traductor,
} from "@/lib/plataformas-de-lanzamiento";

import { ArrowRightIcon, CloseIcon } from "./icons";
import { atado, fechaAtada, partirCola, retirarHojaPrevia } from "./franja-lanzamiento";
import { leerRotacion, leerRotacionEnServidor, rotacion, suscribirRotacion } from "./rotacion-lanzamiento";

const FILAS = filasDe();

/**
 * La franja negra sobre el nav — misma pieza que abre bivelio.com. Aquí lleva
 * de vuelta a la web corporativa, para que savings.bivelio.com se lea como una
 * superficie más del mismo sitio y no como otro producto.
 *
 * Arranca VISIBLE en el HTML, como el <AnnouncementBar> del origen. Una versión
 * anterior decidía en un useEffect leyendo localStorage: el servidor devolvía
 * null, el documento pintaba con el nav pegado arriba y al hidratar se
 * insertaban 38px que empujaban la página entera.
 *
 * LAS PLATAFORMAS DE LANZAMIENTO (desde el 22-11-2026). Mientras alguna
 * plataforma del registro (lib/plataformas-de-lanzamiento.ts) está en campaña,
 * la franja es la de UNA de ellas —con su color— y cambia SOLA, sin despliegue:
 *
 *   · Cuál: la que le toca en el reparto de esta carga (al azar), siempre
 *     DISTINTA de la que enseña la tarjeta del final de la portada. Si el
 *     carrusel de la tarjeta avanza, la franja toma la que la tarjeta suelta;
 *     en las páginas sin tarjeta se queda fija.
 *   · `construido` es el reloj del servidor (NavBar): el de la última
 *     regeneración ISR en la portada y precios, el del DESPLIEGUE en las demás.
 *     El HTML lleva una pieza por plataforma y estado que aún pueda tocar
 *     (`piezasDeFranja`), apiladas en la MISMA celda de rejilla: la franja mide
 *     siempre lo que la más alta y no salta al cambiar de una a otra.
 *   · El primer render del cliente es el del servidor (sin error de
 *     hidratación). Antes del primer pintado, el guion en línea de NavBar
 *     (`guionDeLanzamiento`) ya enseñó con una hoja de estilo lo que toca en
 *     esta carga, sin tocar el DOM; al montar, la franja lee el mismo reparto
 *     (rotacion-lanzamiento.ts), pinta lo mismo con su estado y retira la hoja.
 *   · Al cruzar una frontera con la pestaña abierta (una plataforma abre o
 *     acaba), el reloj de la rotación salta y la franja se recalcula. Las
 *     piezas que ya habían pasado AL CARGAR salen de la pila, como las sacó la
 *     hoja del guion; un cruce con la pestaña abierta no cambia la altura.
 *   · Sin ninguna plataforma en campaña (después del 6-12): la franja negra de
 *     BiVelio, idéntica a la de antes.
 *
 * LA ✕ cierra, y el cierre dura lo que la pestaña (sessionStorage): al
 * recargar, el guion en línea esconde la franja ANTES del primer pintado, así
 * que recordarlo ya no cuesta un salto de layout.
 */
export function AnnouncementBar({ construido = Number.NaN, fechas = {} }: { construido?: number; fechas?: Record<string, string> }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const [visible, setVisible] = useState(true);
  // null: el render del servidor y el de la hidratación.
  const r = useSyncExternalStore(suscribirRotacion, leerRotacion, leerRotacionEnServidor);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(CLAVE_FRANJA_CERRADA) === "1") setVisible(false);
    } catch {
      /* sin almacenamiento (modo privado estricto): la franja no recuerda el cierre */
    }
    // La hoja de la insignia de Product Hunt (guionPrevio): sus componentes ya
    // pintan lo mismo con su estado.
    retirarHojaPrevia();
  }, []);

  // Ya pinta el estado lo mismo que pintaba la hoja del guion: fuera la hoja
  // (si no, se quedaría fijando ese reparto cuando el carrusel avance).
  const montada = r !== null;
  useEffect(() => {
    if (montada) retirarHojaDeLanzamiento("f");
  }, [montada]);

  if (!visible) return null;

  // Las piezas se fijan AL CARGAR; el reparto se mueve con el reloj y el carrusel.
  const base = r ? Math.max(construido, r.t0) : construido;
  const piezas = piezasDeFranja(Number.isNaN(base) ? construido : base);
  const reparto = r ? repartir(FILAS, construido, r.t, r.orden, r.k) : repartoDelServidor(construido);
  const activa = reparto.franja !== null && piezas.some((p) => p.id === reparto.franja && p.estado === reparto.estadoFranja) ? `${reparto.franja}:${reparto.estadoFranja}` : null;
  const deLaActiva = reparto.franja !== null && activa !== null ? plataforma(reparto.franja) : undefined;

  // Las que no tocan siguen ocupando su sitio (para fijar la altura), pero
  // invisibles: `visibility: hidden` las saca del foco y del árbol accesible.
  const oculta = (si: boolean) => ({ "aria-hidden": si || undefined, "data-oculta": si || undefined }) as const;

  const cerrar = () => {
    setVisible(false);
    rotacion()?.retener("franja", false);
    try {
      window.sessionStorage.setItem(CLAVE_FRANJA_CERRADA, "1");
    } catch {
      /* sin almacenamiento: se cierra solo hasta la siguiente carga */
    }
  };
  // Con el ratón o el foco en la franja, el carrusel no la cambia bajo el cursor.
  const retener = (si: boolean) => () => rotacion()?.retener("franja", si);

  return (
    <div
      className={deLaActiva ? "announce announce--lz" : "announce"}
      data-variante={activa ?? "bivelio"}
      style={deLaActiva ? ({ "--lz-fondo": deLaActiva.color.fondo, "--lz-texto": deLaActiva.color.texto } as CSSProperties) : undefined}
      onMouseEnter={retener(true)}
      onMouseLeave={retener(false)}
      onFocus={retener(true)}
      onBlur={retener(false)}
    >
      <div className="announce-pila">
        {piezas.map(({ id, estado }) => {
          const p = PLATAFORMAS.find((x) => x.id === id)!;
          const clave = `${id}:${estado}`;
          const texto = estado === "antes" ? textoDe(t as unknown as Traductor, "launchSoon", p, { date: fechaAtada(fechas[id] ?? "") }) : textoDe(t as unknown as Traductor, "launchLive", p);
          const [cabeza, cola] = partirCola(atado(texto));
          return (
            <a key={clave} data-lz={clave} {...oculta(clave !== activa)} href={p.ficha.franja} target="_blank" rel="noopener">
              <svg className="announce-voto" viewBox={p.icono.viewBox} fill="currentColor" aria-hidden="true">
                {p.icono.trazos.map((d) => (
                  <path key={d.slice(0, 24)} fillRule="evenodd" clipRule="evenodd" d={d} />
                ))}
              </svg>
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
        })}
        <a {...oculta(activa !== null)} href={`https://bivelio.com/${locale}`} target="_blank" rel="noopener noreferrer">
          {t("announce")} <ArrowRightIcon />
        </a>
      </div>
      <button type="button" className="announce-close" aria-label={t("announceClose")} onClick={cerrar}>
        <CloseIcon />
      </button>
    </div>
  );
}
