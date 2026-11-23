"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { Link } from "@/i18n/navigation";
import type { Eleccion } from "@/lib/consentimiento/consentimiento";
import { EVENTO_ABRIR_AVISO, gtagCargado, guardarEleccion, useConsentimiento } from "@/lib/consentimiento/navegador";

export type TextosDelAviso = { titulo: string; cuerpo: string; aceptar: string; rechazar: string; privacidad: string };

/**
 * EL AVISO DE COOKIES DE PUBLICIDAD (decisión del dueño, 23-11).
 *
 * Una tarjeta abajo, sin velo ni bloqueo: la página se puede usar sin elegir,
 * y mientras no se elige Google Ads no se carga (lib/consentimiento). «Aceptar»
 * y «Rechazar» son el mismo botón con distinto texto: misma clase, mismo
 * tamaño, uno al lado del otro. No hay casillas, ni marcadas ni sin marcar.
 *
 * Foco: en la primera visita no se roba (no es un diálogo), pero el aviso va
 * en el documento justo tras la cabecera, así que el tabulador lo alcanza
 * enseguida; se pinta abajo porque es fijo. Al reabrirlo con «Ajustes de
 * cookies» el foco va al aviso, y al elegir vuelve al botón que lo abrió; si
 * se eligió en la primera visita, al destino de «Saltar al contenido»
 * (`idContenido`, el ID_DEL_CONTENIDO que pasa el layout). Escape cierra el
 * aviso reabierto sin cambiar nada.
 *
 * Mientras se ve, `--aviso-cookies-h` reserva su alto al pie del <body>, para
 * que no tape lo último de la página.
 *
 * No sale en las páginas de captura (`/captura-*`): las usa el script que hace
 * las capturas del producto.
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

  const deCaptura = /^\/[a-z]{2}\/captura-/.test(pathname ?? "");
  const visible = !deCaptura && (estado === "sin-eleccion" || reabierto);

  useEffect(() => {
    if (visible && reabierto) seccion.current?.focus();
  }, [visible, reabierto]);

  useEffect(() => {
    const raiz = document.documentElement;
    const el = seccion.current;
    if (!visible || !el) {
      raiz.style.removeProperty("--aviso-cookies-h");
      return;
    }
    const medir = () => raiz.style.setProperty("--aviso-cookies-h", `${Math.ceil(el.getBoundingClientRect().height) + 16}px`);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => {
      ro.disconnect();
      raiz.style.removeProperty("--aviso-cookies-h");
    };
  }, [visible]);

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
    // Retirar el consentimiento con gtag ya cargado: se recarga para que deje de correr YA.
    const recargar = eleccion === "denied" && gtagCargado();
    guardarEleccion(eleccion);
    if (recargar) {
      location.reload();
      return;
    }
    cerrar(dentro);
  };

  return (
    <section
      ref={seccion}
      className="aviso-cookies"
      aria-labelledby={idTitulo}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && reabierto && estado !== "sin-eleccion") cerrar(true);
      }}
    >
      <div className="aviso-cookies-texto">
        <p className="aviso-cookies-t" id={idTitulo}>
          {textos.titulo}
        </p>
        <p className="aviso-cookies-c">
          {textos.cuerpo}{" "}
          <Link href="/privacy#website">{textos.privacidad}</Link>
        </p>
      </div>
      <div className="aviso-cookies-acciones">
        <button type="button" className="btn ghost" onClick={() => elegir("denied")}>
          {textos.rechazar}
        </button>
        <button type="button" className="btn ghost" onClick={() => elegir("granted")}>
          {textos.aceptar}
        </button>
      </div>
    </section>
  );
}
