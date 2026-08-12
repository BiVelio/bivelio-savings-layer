import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { pct, money } from "../format";
import { ProvenancePill } from "./ProvenancePill";

/** Two-state hero, SAME slot: the big number is the customer's OWN net savings
 *  or ABSENT (—) — never borrowed from the reference, never a fabricated 0. */
export async function VerdictHero({
  usage,
  failed = false,
  visibilidad,
}: {
  usage: UsageRollup[];
  failed?: boolean;
  /** Por qué está vacío: `oculto` = las filas EXISTEN y esta cuenta no las ve. */
  visibilidad?: "con_datos" | "sin_trafico" | "oculto" | "desconocido";
}) {
  const t = await getTranslations("dashboard");
  const baseline = usage.reduce((n, r) => n + r.baselineCost, 0);
  const actual = usage.reduce((n, r) => n + r.actualCost, 0);
  const saved = baseline - actual;
  const peticionesTotales = usage.reduce((n, r) => n + r.requests, 0);

  // CUATRO cosas que NO son "no tienes tráfico" y que antes se pintaban igual:
  //  · las filas EXISTEN y esta cuenta no las ve (visibilidad "oculto"). Una
  //    denegación de RLS en PostgREST devuelve `[]` con `error: null`, así que era
  //    indistinguible de "aún no has enviado nada" — y decirle eso a un cliente
  //    que lleva semanas midiendo es la forma más rápida de perderlo. Se comprueba
  //    contra el `service_role`, que salta la RLS, y solo cuando ha visto cero.
  //  · la consulta falló (failed): 503/RLS/columna ausente, con datos intactos.
  //  · hay tráfico pero sin precio (filas y peticiones, baseline 0): modelo sin
  //    tarifa o ingerido antes de haber precios. Decir "0 solicitudes vistas" es
  //    un hecho medible y FALSO teniendo el recuento en la mano.
  const sinPrecioConTrafico = !failed && peticionesTotales > 0 && baseline <= 0;

  // "Hay filas" NO es lo mismo que "hay algo que enseñar". Con filas medidas
  // pero baseline 0 —tráfico ingerido antes de que hubiera precios, o un modelo
  // sin tarifa configurada— el cálculo caía a `net = 0` y se pintaba como
  // "0.0%" EN VERDE: un cero fabricado, justo lo que el comentario de este
  // fichero promete no hacer nunca. Ahora eso es su propio estado.
  const live = usage.length > 0 && baseline > 0;
  const net = baseline > 0 ? 1 - actual / baseline : 0;
  // Y un ahorro NEGATIVO (la capa salió más cara) no puede pintarse de verde:
  // la clase `pos` estaba fija, y no existía regla para `neg`.
  const tono = net < 0 ? "neg" : "pos";

  // La parte COMPROBABLE contra la factura: solo peticiones cuyo baseline se
  // reconstruyó desde el contador del proveedor. El resto son llamadas
  // evitadas, donde el baseline es necesariamente estimado. El titular las
  // mezclaba en una sola cifra.
  const mBase = usage.reduce((n, r) => n + (r.measuredBaselineCost ?? 0), 0);
  const mAct = usage.reduce((n, r) => n + (r.measuredActualCost ?? 0), 0);
  const mReq = usage.reduce((n, r) => n + (r.measuredRequests ?? 0), 0);
  const peticiones = usage.reduce((n, r) => n + r.requests, 0);
  const medido = mBase > 0
    ? { net: 1 - mAct / mBase, share: peticiones > 0 ? mReq / peticiones : 0 }
    : null;

  return (
    <div className="verdict">
      <div>
        <p className="ck-eyebrow">{t("verdictHero.eyebrow")}</p>
        {live ? (
          <>
            <div className={`big ${tono} ck-num`}>{pct(net)}</div>
            {medido !== null && (
              <p className="ck-note" style={{ marginTop: "8px" }}>
                {t("verdictHero.measuredSplit", {
                  pct: pct(medido.net),
                  share: `${Math.round(medido.share * 100)}%`,
                })}
              </p>
            )}
            <div className="cap">
              {t.rich("verdictHero.savedLine", {
                money: money(saved),
                b: (chunks) => <b>{chunks}</b>,
              })}
            </div>
          </>
        ) : (
          <>
            <div className="big empty ck-num">—</div>
            <div className="cap">
              {visibilidad === "oculto"
                ? t("verdictHero.hiddenCap")
                : failed
                ? t("verdictHero.errorCap")
                : sinPrecioConTrafico
                  ? t("verdictHero.unpricedCap", { count: peticionesTotales })
                  : t("verdictHero.emptyCap")}
            </div>
          </>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-end" }}>
        <ProvenancePill kind={live ? "live" : "await"} />
        <div className="seg" aria-hidden>
          <button disabled>30d</button>
          <button disabled>90d</button>
          <button disabled>all</button>
        </div>
      </div>
    </div>
  );
}
