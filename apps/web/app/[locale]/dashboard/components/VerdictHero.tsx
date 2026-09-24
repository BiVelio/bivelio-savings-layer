import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { deriveVerdict } from "../derive";
import { pct, money } from "../format";
import type { Rango } from "../rango";
import { ProvenancePill } from "./ProvenancePill";
import { RangeSwitch } from "./RangeSwitch";

/**
 * El titular del panel: el ahorro MEDIDO del cliente, o ausente (—). Nunca
 * prestado de la referencia, nunca un 0 fabricado, y nunca —desde el
 * 2026-09-10— la suma de lo medido con lo estimado bajo un rótulo que dice
 * «medido».
 *
 * Este componente REIMPLEMENTABA la aritmética que `deriveVerdict` ya hacía, y
 * la hacía peor: sumaba el total. Ahora solo pinta lo que esa función decide, de
 * modo que un único sitio define qué significa «ahorro» en todo el producto.
 */
export async function VerdictHero({
  usage,
  failed = false,
  visibilidad,
  rango,
}: {
  /** Ya CORTADO al rango: el titular suma exactamente lo que el rango dice. */
  usage: UsageRollup[];
  failed?: boolean;
  /** Días que abarca `usage`. Se escribe al lado del titular y manda en el selector. */
  rango: Rango;
  /** Por qué está vacío: `oculto` = las filas EXISTEN y esta cuenta no las ve. */
  visibilidad?: "con_datos" | "sin_trafico" | "oculto" | "desconocido";
}) {
  const t = await getTranslations("dashboard");
  const v = deriveVerdict(usage);
  const live = !failed && v.kind === "measured";

  // CUATRO cosas que NO son "no tienes tráfico" y que antes se pintaban igual:
  //  · las filas EXISTEN y esta cuenta no las ve (visibilidad "oculto"). Una
  //    denegación de RLS en PostgREST devuelve `[]` con `error: null`, así que era
  //    indistinguible de "aún no has enviado nada" — y decirle eso a un cliente
  //    que lleva semanas midiendo es la forma más rápida de perderlo.
  //  · la consulta falló (failed): 503/RLS/columna ausente, con datos intactos.
  //  · hay tráfico pero sin precio (unpriced): modelo sin tarifa o ingerido antes
  //    de haber precios. Decir "0 solicitudes vistas" es FALSO con el recuento
  //    en la mano.
  //  · hay tráfico con precio pero NADA medido (sin_medir). Antes este caso caía
  //    al total y lo llamaba medido; ahora dice lo que pasa.
  const peticionesSinPrecio = v.kind === "unpriced" ? usage.reduce((n, r) => n + r.requests, 0) : 0;

  return (
    <div className="verdict">
      <div>
        <p className="ck-eyebrow">
          {t("verdictHero.eyebrow")} · {t("verdictHero.rangeDays", { n: rango })}
        </p>
        {live && v.kind === "measured" ? (
          <>
            <div className={`big ${v.tone} ck-num`}>{pct(v.net)}</div>
            {v.total !== null && (
              <p className="ck-note" style={{ marginTop: "8px" }}>
                {t("verdictHero.totalSplit", {
                  pct: pct(v.total.net),
                  share: `${Math.round(v.share * 100)}%`,
                })}
              </p>
            )}
            <div className="cap">
              {t.rich("verdictHero.savedLine", {
                money: money(v.saved),
                b: (chunks) => <b>{chunks}</b>,
              })}
            </div>
            {/* 0029 · la parte del titular medida POR REFERENCIA: repeticiones
                servidas sin llamar al proveedor, valoradas con el contador de
                la petición idéntica que ya corrió. Ya está DENTRO del titular
                (deriveVerdict la suma bajo COMISIONAR_REFERENCIA); esta línea
                solo dice cuánto y de dónde sale. Va DETRÁS de savedLine: su
                «De eso» se refiere al importe ahorrado, no al total con lo
                estimado de totalSplit. */}
            {v.byReference && (
              <p className="ck-note">
                {t.rich("verdictHero.referenceNote", {
                  money: money(v.byReference.saved),
                  count: v.byReference.requests,
                  b: (chunks) => <b>{chunks}</b>,
                })}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="big empty ck-num">—</div>
            <div className="cap">
              {visibilidad === "oculto"
                ? t("verdictHero.hiddenCap")
                : failed
                ? t("verdictHero.errorCap")
                : v.kind === "unpriced"
                  ? t("verdictHero.unpricedCap", { count: peticionesSinPrecio })
                  : v.kind === "sin_medir"
                    ? t("verdictHero.unmeasuredCap", { count: v.requests })
                    : t("verdictHero.emptyCap")}
            </div>
          </>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-end" }}>
        <ProvenancePill kind={live ? "live" : "await"} />
        {/* Vivo desde el 2026-09-19. Eran tres botones deshabilitados con
            `aria-hidden`: un control que promete y no hace nada es peor que
            ninguno. Ahora el rango viaja en la URL y lo aplica el servidor. */}
        <RangeSwitch activo={rango} />
      </div>
    </div>
  );
}
