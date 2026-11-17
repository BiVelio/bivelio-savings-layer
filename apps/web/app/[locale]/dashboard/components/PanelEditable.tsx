"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Toaster, toast } from "@/vendor/affectui/toaster";
import { Tooltip } from "@/vendor/affectui/tooltip-clean";

import {
  PREFS_VACIAS,
  alternar,
  esPorDefecto,
  guardar,
  leer,
  mover,
  ocultasEfectivas,
  visibles,
  type PanelPrefs,
} from "../panel-preferencias";

/**
 * EL PANEL QUE SE ORDENA. Recibe las tarjetas YA RENDERIZADAS por el servidor
 * (nodos de React con sus datos dentro) y solo decide cuáles se ven y en qué
 * orden. No toca un dato: mover una tarjeta no la recalcula, ocultarla no la
 * deja de medir.
 *
 * Primer render idéntico en servidor y cliente (orden por defecto, nada oculto);
 * las preferencias se aplican tras montar, desde localStorage. El parpadeo que
 * eso produce en quien ha reordenado es el precio de no romper la hidratación
 * ni mandar preferencias de lectura a la base.
 *
 * Lo que queda FUERA a propósito: los avisos de cobro, la espina de activación
 * y el titular. Eso no se puede ocultar porque no es decoración.
 *
 * UN ANCLA QUE NO DESAPARECE (`ancla`, 2026-11). La entrada «Máquinas» del
 * raíl apunta a `#maquinas`, que vive dentro de una tarjeta. Si el cliente la
 * oculta, el enlace se quedaba sin destino. Una tarjeta que declara `ancla`
 * deja, mientras está oculta, un marcador con ese mismo `id`: dice que la
 * tarjeta está oculta y ofrece volver a mostrarla — con `alternar`, la misma
 * función de preferencias que el botón «Ocultar». Si la página se abrió en
 * ese ancla, se lleva la vista hasta el marcador.
 *
 * QUE SE NOTE LO QUE HAS HECHO (2026-11). Ocultar una tarjeta la quitaba de la
 * vista sin más, y restablecer no decía nada. Ahora cada cambio de disposición
 * deja un aviso del Toaster de affectUI con «Deshacer», que vuelve a aplicar
 * las preferencias de justo antes — con el mismo `aplicar` de siempre: no hay
 * ningún estado nuevo que guardar. Subir y bajar son botones de icono con su
 * nombre en un Tooltip. El Toaster no pinta nada en servidor más que su región
 * vacía, así que el primer render sigue siendo idéntico en los dos lados.
 */
export interface TarjetaDelPanel {
  id: string;
  /** Título para la barra de edición; el contenido trae el suyo propio. */
  titulo: string;
  contenido: ReactNode;
  /** Destino estable para cuando la tarjeta está oculta (ver arriba). */
  ancla?: { id: string; titulo: string; texto: string; accion: string };
}

export function PanelEditable({ tarjetas }: { tarjetas: TarjetaDelPanel[] }) {
  const t = useTranslations("dashboard");
  const ids = useMemo(() => tarjetas.map((c) => c.id), [tarjetas]);
  const [prefs, setPrefs] = useState<PanelPrefs>(PREFS_VACIAS);
  const [editando, setEditando] = useState(false);
  const marcadores = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    setPrefs(leer(typeof window === "undefined" ? undefined : window.localStorage));
  }, []);

  // Quien llegó con `#maquinas` y tiene la tarjeta oculta: el navegador saltó
  // antes de hidratar a una tarjeta que ya no está. Se le lleva al marcador.
  const idsOcultos = ocultasEfectivas(ids, prefs).join("|");
  useEffect(() => {
    if (typeof window === "undefined" || !window.location.hash) return;
    const el = marcadores.current.get(window.location.hash.slice(1));
    el?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [idsOcultos]);

  const aplicar = (siguiente: PanelPrefs) => {
    setPrefs(siguiente);
    guardar(typeof window === "undefined" ? undefined : window.localStorage, siguiente);
  };

  /** Aplica un cambio y lo cuenta, con la vuelta atrás a un toque. */
  const cambiar = (siguiente: PanelPrefs, mensaje: string) => {
    const antes = prefs;
    aplicar(siguiente);
    toast(mensaje, {
      id: "panel-disposicion",
      type: "success",
      description: t("panel.toastSaved"),
      action: { label: t("panel.undo"), onClick: () => aplicar(antes) },
    });
  };
  const titulo = (id: string) => tarjetas.find((c) => c.id === id)?.titulo ?? id;

  const orden = visibles(ids, prefs);
  const ocultas = ocultasEfectivas(ids, prefs);
  const porId = new Map(tarjetas.map((c) => [c.id, c] as const));

  return (
    <div className="pe">
      <div className="pe-bar" data-tour="customize">
        <span className="ck-note">{editando ? t("panel.hint") : t("panel.summary", { n: orden.length, hidden: ocultas.length })}</span>
        <div className="pe-actions">
          {editando && !esPorDefecto(prefs) && (
            <button type="button" className="pe-btn" onClick={() => cambiar(PREFS_VACIAS, t("panel.toastReset"))}>
              {t("panel.reset")}
            </button>
          )}
          <button type="button" className="pe-btn primary" aria-pressed={editando} onClick={() => setEditando((e) => !e)}>
            {editando ? t("panel.done") : t("panel.customize")}
          </button>
        </div>
      </div>

      {editando && ocultas.length > 0 && (
        <div className="pe-hidden" role="group" aria-label={t("panel.hiddenCards")}>
          <span className="ck-eyebrow">{t("panel.hiddenCards")}</span>
          {ocultas.map((id) => (
            <button key={id} type="button" className="pe-chip" onClick={() => cambiar(alternar(ids, prefs, id), t("panel.toastShown", { card: titulo(id) }))}>
              + {porId.get(id)?.titulo ?? id}
            </button>
          ))}
        </div>
      )}

      <div className="panel-stack">
        {orden.map((id, i) => {
          const c = porId.get(id);
          if (!c) return null;
          return (
            <section key={id} className={`pe-card ${editando ? "editing" : ""}`.trim()} aria-label={c.titulo}>
              {editando && (
                <div className="pe-head">
                  <span className="pe-title">{c.titulo}</span>
                  <div className="pe-ctl">
                    <Tooltip content={t("panel.up")}>
                      <button type="button" className="pe-btn pe-ico" disabled={i === 0} aria-label={t("panel.up")} onClick={() => aplicar(mover(ids, prefs, id, -1))}>
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip content={t("panel.down")}>
                      <button type="button" className="pe-btn pe-ico" disabled={i === orden.length - 1} aria-label={t("panel.down")} onClick={() => aplicar(mover(ids, prefs, id, 1))}>
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
                        </svg>
                      </button>
                    </Tooltip>
                    <button type="button" className="pe-btn" onClick={() => cambiar(alternar(ids, prefs, id), t("panel.toastHidden", { card: c.titulo }))}>
                      {t("panel.hide")}
                    </button>
                  </div>
                </div>
              )}
              <Fragment key="contenido">{c.contenido}</Fragment>
            </section>
          );
        })}
        {ocultas.map((id) => {
          const ancla = porId.get(id)?.ancla;
          if (!ancla) return null;
          return (
            <section
              key={id}
              id={ancla.id}
              className="pe-ghost"
              aria-label={ancla.titulo}
              ref={(el) => {
                if (el) marcadores.current.set(ancla.id, el);
                else marcadores.current.delete(ancla.id);
              }}
            >
              <div>
                <p className="pe-ghost-t">{ancla.titulo}</p>
                <p className="ck-note">{ancla.texto}</p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => cambiar(alternar(ids, prefs, id), t("panel.toastShown", { card: titulo(id) }))}>
                {ancla.accion}
              </button>
            </section>
          );
        })}
      </div>
      <Toaster label={t("panel.toastRegion")} closeLabel={t("panel.toastClose")} />
    </div>
  );
}
