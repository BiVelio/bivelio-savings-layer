"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import { Marcado } from "@/app/components/campana/Marcado";
import { MINIATURA_PH, atado, partirCola } from "@/app/components/franja-lanzamiento";
import { ArrowRightIcon } from "@/app/components/icons";
import { leerRotacion, leerRotacionEnServidor, rotacion, suscribirRotacion } from "@/app/components/rotacion-lanzamiento";
import {
  PLATAFORMAS,
  estadoDe,
  filasDe,
  piezasDeTarjeta,
  repartir,
  repartoDelServidor,
  retirarHojaDeLanzamiento,
  type TextosDeTarjeta,
} from "@/lib/plataformas-de-lanzamiento";

const FILAS = filasDe();

/** Cada cuánto avanza solo el carrusel. Largo a propósito: da tiempo a leer la tarjeta y la franja no marea. */
export const INTERVALO_MS = 7000;

/**
 * «FIND US ON …» — la tarjeta de las plataformas de lanzamiento, al final de la
 * portada (después del cierre, antes de la banda de NVIDIA y del pie): la
 * tarjeta blanca con hairline sobre el marfil, el cielo cian muy tenue en su
 * esquina y el marcador de la campaña detrás del nombre de la plataforma. Es
 * un CARRUSEL: una diapositiva por plataforma del registro
 * (lib/plataformas-de-lanzamiento.ts), con el botón en el color de cada una.
 *
 * · Todas las diapositivas van en el HTML, apiladas en las MISMAS celdas de la
 *   rejilla de la tarjeta: mide lo que la más alta y no salta al pasar de una a
 *   otra. Solo se ve la que toca; las demás, con `visibility: hidden`, salen
 *   del foco y del árbol accesible.
 * · Cuál se ve al cargar lo decide el reparto al azar de esta carga
 *   (rotacion-lanzamiento.ts), el mismo que usa la franja de arriba, que enseña
 *   siempre OTRA plataforma. El primer render es el del servidor; el guion en
 *   línea de NavBar ya enseñó la que toca antes del primer pintado.
 * · Avanza sola cada 7 s, SOLO mientras la tarjeta está a la vista (la franja
 *   de arriba cambia con ella: mientras se lee el resto de la página, nada se
 *   mueve), y se detiene con el ratón o el foco encima, con la pestaña oculta,
 *   con el botón de pausa (WCAG 2.2.2) y al elegir una plataforma en los
 *   puntos. Con `prefers-reduced-motion` no avanza sola ni anima el cambio.
 * · La miniatura es NUESTRA (public/brand/product-hunt-thumb-2026-11.png),
 *   servida a 64×64 con su 2× por next/image: la tarjeta no conecta con
 *   ninguna plataforma hasta que alguien pulsa su botón.
 * · El botón lleva sus dos textos apilados («avísame» antes de que la
 *   plataforma abra, «échale un vistazo» desde entonces): mide lo mismo en
 *   todas las ventanas.
 */
export function TarjetaLanzamiento({ construido, t }: { construido: number; t: TextosDeTarjeta }) {
  // null: el render del servidor y el de la hidratación.
  const r = useSyncExternalStore(suscribirRotacion, leerRotacion, leerRotacionEnServidor);
  const [pausado, setPausado] = useState(false);
  const [aLaVista, setALaVista] = useState(false);
  const [sinMovimiento, setSinMovimiento] = useState(false);
  const seccion = useRef<HTMLElement>(null);

  const montada = r !== null;
  useEffect(() => {
    if (montada) retirarHojaDeLanzamiento("t");
  }, [montada]);

  useEffect(() => {
    const consulta = window.matchMedia("(prefers-reduced-motion: reduce)");
    const leer = () => setSinMovimiento(consulta.matches);
    leer();
    consulta.addEventListener("change", leer);
    const el = seccion.current;
    const observador = el && "IntersectionObserver" in window ? new IntersectionObserver(([e]) => setALaVista(Boolean(e?.isIntersecting)), { threshold: 0.5 }) : null;
    if (el) observador?.observe(el);
    return () => {
      consulta.removeEventListener("change", leer);
      observador?.disconnect();
      rotacion()?.retener("tarjeta", false);
    };
  }, []);

  const reparto = r ? repartir(FILAS, construido, r.t, r.orden, r.k) : repartoDelServidor(construido);
  const varias = reparto.enTarjeta.length > 1;
  const gira = montada && varias && !pausado && aLaVista && !sinMovimiento;

  useEffect(() => {
    if (!gira) return;
    const id = window.setInterval(() => {
      const viva = rotacion();
      if (viva && !viva.retenida() && document.visibilityState === "visible") viva.avanzar(1);
    }, INTERVALO_MS);
    return () => window.clearInterval(id);
  }, [gira]);

  if (reparto.tarjeta === null) return null;

  const retener = (si: boolean) => () => rotacion()?.retener("tarjeta", si);
  const piezas = piezasDeTarjeta(construido);

  return (
    <section
      ref={seccion}
      className="ph-sec lz-sec"
      aria-roledescription="carousel"
      aria-label={t.carrusel}
      onMouseEnter={retener(true)}
      onMouseLeave={retener(false)}
      onFocus={retener(true)}
      onBlur={retener(false)}
    >
      <div className="ph-tarjeta rv">
        <Image className="ph-miniatura" src={MINIATURA_PH} width={64} height={64} alt="" loading="lazy" />
        {/* Girando sola, los cambios no se anuncian (interrumpirían la lectura);
            en pausa, sí: quien pulsa un punto oye a qué plataforma ha ido. */}
        <div className="lz-pista" aria-live={pausado ? "polite" : "off"}>
          {piezas.map(({ id, conAviso }) => {
            const p = PLATAFORMAS.find((x) => x.id === id)!;
            const textos = t.porPlataforma[id]!;
            const visible = id === reparto.tarjeta;
            const boton = estadoDe(p, r ? r.t : construido) === "antes" ? "antes" : "vivo";
            const [cabeza, cola] = partirCola(atado(textos.vivo));
            return (
              <div
                key={id}
                className="lz-diapo"
                role="group"
                aria-roledescription="slide"
                aria-label={p.nombre}
                data-lz-d={id}
                data-oculta={!visible || undefined}
                aria-hidden={!visible || undefined}
                style={{ "--lz-fondo": p.color.fondo, "--lz-texto": p.color.texto, "--lz-realce": p.color.realce } as CSSProperties}
              >
                <div className="ph-texto">
                  <h2 className="ph-k">
                    <Marcado texto={textos.kicker} marca={p.nombre} />
                  </h2>
                  <p className="ph-nombre">BiVelio Savings Layer</p>
                  <p className="ph-lema">{t.lema}</p>
                </div>
                <a className="ph-boton" href={p.ficha.tarjeta} target="_blank" rel="noopener">
                  <span className="ph-pila">
                    {conAviso && (
                      <span data-lz-b="antes" data-oculta={boton !== "antes" || undefined} aria-hidden={boton !== "antes" || undefined}>
                        {atado(textos.aviso)}
                      </span>
                    )}
                    <span data-lz-b="vivo" data-oculta={boton !== "vivo" || undefined} aria-hidden={boton !== "vivo" || undefined}>
                      {cabeza}
                      <span className="ph-cola">
                        {cola} <ArrowRightIcon />
                      </span>
                    </span>
                  </span>
                  <span className="sr-only"> {t.nuevaPestana}</span>
                </a>
              </div>
            );
          })}
        </div>
      </div>
      {/* Los mandos, solo con más de una plataforma y solo con JavaScript (sin
          él no hay carrusel: se queda la diapositiva del servidor). Su sitio
          está reservado desde el HTML: al aparecer no empujan nada. */}
      {piezas.length > 1 && (
        <div className="lz-mandos" data-listos={(montada && varias) || undefined}>
          {!sinMovimiento && (
            <button type="button" className="lz-pausa" aria-label={pausado ? t.reanudar : t.pausar} onClick={() => setPausado((p) => !p)}>
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                {pausado ? <path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1l-7.3-4.8A.6.6 0 0 0 5 3.2Z" /> : <path d="M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z" />}
              </svg>
            </button>
          )}
          {/* En el orden en que salen en esta carga: el primer punto, la primera que se vio. */}
          {(r ? [...reparto.enTarjeta.slice(1), ...reparto.enTarjeta.slice(0, 1)] : piezas.map((p) => p.id)).map((id) => (
            <button
              key={id}
              type="button"
              className="lz-punto"
              aria-label={t.porPlataforma[id]!.ver}
              aria-current={id === reparto.tarjeta ? "true" : undefined}
              onClick={() => {
                // Quien elige una plataforma quiere quedarse en ella.
                setPausado(true);
                rotacion()?.irA(id);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
