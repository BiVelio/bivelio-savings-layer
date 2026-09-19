"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
 */
export interface TarjetaDelPanel {
  id: string;
  /** Título para la barra de edición; el contenido trae el suyo propio. */
  titulo: string;
  contenido: ReactNode;
}

export function PanelEditable({ tarjetas }: { tarjetas: TarjetaDelPanel[] }) {
  const t = useTranslations("dashboard");
  const ids = useMemo(() => tarjetas.map((c) => c.id), [tarjetas]);
  const [prefs, setPrefs] = useState<PanelPrefs>(PREFS_VACIAS);
  const [editando, setEditando] = useState(false);

  useEffect(() => {
    setPrefs(leer(typeof window === "undefined" ? undefined : window.localStorage));
  }, []);

  const aplicar = (siguiente: PanelPrefs) => {
    setPrefs(siguiente);
    guardar(typeof window === "undefined" ? undefined : window.localStorage, siguiente);
  };

  const orden = visibles(ids, prefs);
  const ocultas = ocultasEfectivas(ids, prefs);
  const porId = new Map(tarjetas.map((c) => [c.id, c] as const));

  return (
    <div className="pe">
      <div className="pe-bar">
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
      </div>
    </div>
  );
}
