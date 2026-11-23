"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { Link } from "@/i18n/navigation";
import type { Eleccion } from "@/lib/consentimiento/consentimiento";
import { EVENTO_ABRIR_AVISO, guardarEleccion, useConsentimiento } from "@/lib/consentimiento/navegador";
import { rutaParaVercel } from "@/lib/medicion/eventos";
import { RUTAS_CON_GOOGLE_ADS } from "@/lib/medicion/google-ads";

/** `cuerpoCorto`: la primera capa en pantallas estrechas (< 640 px); dice lo mismo, más corto. */
export type TextosDelAviso = { titulo: string; cuerpo: string; cuerpoCorto: string; aceptar: string; rechazar: string; privacidad: string };

/**
 * EL AVISO DE COOKIES DE PUBLICIDAD (decisión del dueño, 23-11).
 *
 * UNA FRANJA EN EL FLUJO, justo bajo la cabecera, no un elemento fijo: nunca
 * tapa nada (ni el botón principal del héroe en un móvil con las barras del
 * navegador, ni un control con el foco: WCAG 2.4.11). Empuja la página hacia
 * abajo mientras se ve y desaparece al elegir. Sin velo ni bloqueo: la página
 * se puede usar sin elegir, y mientras no se elige Google Ads no se carga
 * (lib/consentimiento). «Aceptar» y «Rechazar» son el mismo botón con distinto
 * texto. No hay casillas.
 *
 * DÓNDE SALE: solo en las páginas donde Google Ads puede correr
 * (RUTAS_CON_GOOGLE_ADS). En el alta, el acceso, el panel… no hay nada que
 * consentir, y no debe empujar su formulario. Al reabrirlo con «Ajustes de
 * cookies» sale donde se pida.
 *
 * SIN SALTOS: en las páginas estáticas el aviso va en el HTML (estado
 * `pendiente`); si ya hay una elección, el guion previo del <head>
 * (guionPrevioDelAviso) lo esconde antes del primer pintado, y al hidratar el
 * componente lo quita.
 *
 * Foco: en la primera visita no se roba (no es un diálogo); va tras la
 * cabecera, así que el tabulador lo alcanza enseguida. Al reabrirlo, el foco va
 * al aviso, y al elegir vuelve al botón que lo abrió; si se eligió en la
 * primera visita, al destino de «Saltar al contenido» (`idContenido`, el
 * ID_DEL_CONTENIDO que pasa el layout). Escape cierra el aviso reabierto sin
 * cambiar nada.
 */
export function AvisoCookies({ textos, idContenido }: { textos: TextosDelAviso; idContenido: string }) {
  const estado = useConsentimiento();
  const pathname = usePathname();
  const [reabierto, setReabierto] = useState(false);
  const seccion = useRef<HTMLElement>(null);
  const disparador = useRef<HTMLElement | null>(null);
  const idTitulo = useId();

  useEffect(() => {
    const abrir = () => {
      disparador.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setReabierto(true);
    };
    window.addEventListener(EVENTO_ABRIR_AVISO, abrir);
    return () => window.removeEventListener(EVENTO_ABRIR_AVISO, abrir);
  }, []);

  const aqui = (RUTAS_CON_GOOGLE_ADS as readonly string[]).includes(rutaParaVercel(pathname ?? "/").route);
  const visible = reabierto || (aqui && (estado === "sin-eleccion" || estado === "pendiente"));

  useEffect(() => {
    if (visible && reabierto) seccion.current?.focus();
  }, [visible, reabierto]);

  if (!visible) return null;

  const cerrar = (dentro: boolean) => {
    setReabierto(false);
    const volver = disparador.current;
    disparador.current = null;
    if (volver && volver.isConnected) volver.focus();
    else if (dentro) document.getElementById(idContenido)?.focus();
  };

  const elegir = (eleccion: Eleccion) => {
    const dentro = !!seccion.current?.contains(document.activeElement);
    // Si gtag estaba cargado y se rechaza, EtiquetaGoogleAds recarga la página.
    guardarEleccion(eleccion);
    cerrar(dentro);
  };

  return (
    <section
      ref={seccion}
      className="aviso-cookies"
      aria-labelledby={idTitulo}
      tabIndex={-1}
      data-reabierto={reabierto ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && reabierto && estado !== "sin-eleccion") cerrar(true);
      }}
    >
      <div className="aviso-cookies-in">
        <p className="aviso-cookies-c">
          <strong className="aviso-cookies-t" id={idTitulo}>
            {textos.titulo}.
          </strong>{" "}
          <span className="aviso-cookies-largo">{textos.cuerpo}</span>
          <span className="aviso-cookies-corto">{textos.cuerpoCorto}</span>{" "}
          <Link href="/privacy#website">{textos.privacidad}</Link>
        </p>
        <div className="aviso-cookies-acciones">
          <button type="button" className="btn ghost" onClick={() => elegir("denied")}>
            {textos.rechazar}
          </button>
          <button type="button" className="btn ghost" onClick={() => elegir("granted")}>
            {textos.aceptar}
          </button>
        </div>
      </div>
    </section>
  );
}
