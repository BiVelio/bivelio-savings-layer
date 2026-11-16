"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

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

  const orden = visibles(ids, prefs);
  const ocultas = ocultasEfectivas(ids, prefs);
  const porId = new Map(tarjetas.map((c) => [c.id, c] as const));

  return (
    <div className="pe">
      <div className="pe-bar" data-tour="customize">
        <span className="ck-note">{editando ? t("panel.hint") : t("panel.summary", { n: orden.length, hidden: ocultas.length })}</span>
        <div className="pe-actions">
          {editando && !esPorDefecto(prefs) && (
            <button type="button" className="pe-btn" onClick={() => aplicar(PREFS_VACIAS)}>
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
            <button key={id} type="button" className="pe-chip" onClick={() => aplicar(alternar(ids, prefs, id))}>
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
                    <button type="button" className="pe-btn" disabled={i === 0} aria-label={t("panel.up")} title={t("panel.up")} onClick={() => aplicar(mover(ids, prefs, id, -1))}>
                      ↑
                    </button>
                    <button type="button" className="pe-btn" disabled={i === orden.length - 1} aria-label={t("panel.down")} title={t("panel.down")} onClick={() => aplicar(mover(ids, prefs, id, 1))}>
                      ↓
                    </button>
                    <button type="button" className="pe-btn" onClick={() => aplicar(alternar(ids, prefs, id))}>
                      {t("panel.hide")}
                    </button>
                  </div>
                </div>
              )}
              {c.contenido}
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
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => aplicar(alternar(ids, prefs, id))}>
                {ancla.accion}
              </button>
            </section>
          );
        })}
      </div>
    </div>
  );
}
