import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { AlertIcon, EyeOffIcon, InstallIcon, ProofIcon, ReceiptIcon, TrendIcon } from "@/app/components/icons";
import { TitularMarcado } from "@/app/components/app/CabeceraDePagina";
import { Recibo } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { NumberTicker } from "@/vendor/affectui/number-ticker";

import type { UsageRollup } from "../data";
import { deriveVerdict } from "../derive";
import { pct, pct0Floor, money, moneySigned } from "../format";
import { RANGO_POR_DEFECTO, type Rango } from "../rango";
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
 *
 * REDISEÑO 2026-11 — NUEVE COMPOSICIONES, NO UNA RAYA CON NUEVE PIES. Cada
 * estado dice con palabras (y un icono, no solo un color) qué pasa y qué se
 * puede hacer: ahorro positivo, sobrecoste, medición parcial, sin integrar,
 * sin tráfico en el periodo, sin precio, sin medición, lectura fallida y
 * acceso limitado. El estado se DERIVA de lo que ya decidían `deriveVerdict`,
 * `failed` y `visibilidad`; aquí no se calcula nada nuevo. Un estado sin
 * cifra no pinta ninguna: ni un cero ni una raya gigante.
 *
 * El titular medido lleva su RECIBO: línea base, coste real y ahorro de las
 * peticiones con contador, con la insignia «Tus datos». Las dos primeras
 * salen de lo que `deriveVerdict` devuelve (`saved` = base − real y
 * `net` = 1 − real ÷ base, así que base = saved ÷ net): es la misma cuenta
 * leída al revés, no otra cuenta. Con `net` a cero no hay división y esas dos
 * filas no salen. La letra pequeña (total con lo estimado, parte medida por
 * referencia, columnas de origen) va tras «Ver fuente y metodología».
 *
 * La cifra grande rueda SOLO cuando cambia el rango (el componente persiste
 * entre navegaciones y `NumberTicker` no cuenta desde cero al entrar).
 */

type Estado =
  | "positive"
  | "negative"
  | "partial"
  | "notIntegrated"
  | "noTraffic"
  | "noPrice"
  | "notMeasured"
  | "readFailed"
  | "limited";
export async function VerdictHero({
  usage,
  failed = false,
  visibilidad,
  rango,
  rotulos,
  integrado,
}: {
  /** Ya CORTADO al rango: el titular suma exactamente lo que el rango dice. */
  usage: UsageRollup[];
  failed?: boolean;
  /** Días que abarca `usage`. Se escribe al lado del titular y manda en el selector. */
  rango: Rango;
  /** Por qué está vacío: `oculto` = las filas EXISTEN y esta cuenta no las ve. */
  visibilidad?: "con_datos" | "sin_trafico" | "oculto" | "desconocido";
  /**
   * SOLO para la captura del héroe de la portada (`/[locale]/captura-panel`),
   * que pinta una organización de demostración con UN día del banco público:
   * ahí «tu factura», «últimos 30 días», «live · tu organización» y el
   * selector de rango serían falsos. Con `rotulos`, el antetítulo, la píldora
   * y el pie son los que se pasan y el selector no sale. El panel de los
   * clientes nunca lo pasa: sin él, todo sigue igual.
   */
  rotulos?: { antetitulo: string; pastilla: string; pie: ReactNode };
  /**
   * Si la instalación ya está acreditada (el hito «SDK o gateway instalado»).
   * Solo distingue dos vacíos: `false` = aún no hay nada conectado; cualquier
   * otro valor = conectado pero sin tráfico en este periodo.
   */
  integrado?: boolean;
}) {
  const t = await getTranslations("dashboard");
  const u = await getTranslations("ui");
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

  // La MISMA precedencia que tenía el pie: medido; si no, oculto; si no, fallo;
  // si no, lo que diga `deriveVerdict`.
  const estado: Estado =
    live && v.kind === "measured"
      ? v.tone === "neg"
        ? "negative"
        : v.share < 1
          ? "partial"
          : "positive"
      : visibilidad === "oculto"
        ? "limited"
        : failed
          ? "readFailed"
          : v.kind === "unpriced"
            ? "noPrice"
            : v.kind === "sin_medir"
              ? "notMeasured"
              : integrado === false
                ? "notIntegrated"
                : "noTraffic";

  const rotulo: Record<Estado, string> = {
    positive: t("verdictHero.status.positive"),
    negative: t("verdictHero.status.negative"),
    partial: t("verdictHero.status.partial"),
    notIntegrated: t("verdictHero.status.notIntegrated"),
    noTraffic: t("verdictHero.status.noTraffic"),
    noPrice: t("verdictHero.status.noPrice"),
    notMeasured: t("verdictHero.status.notMeasured"),
    readFailed: t("verdictHero.status.readFailed"),
    limited: t("verdictHero.status.limited"),
  };
  const icono: Record<Estado, ReactNode> = {
    positive: <TrendIcon />,
    negative: <AlertIcon />,
    partial: <TrendIcon />,
    notIntegrated: <InstallIcon />,
    noTraffic: <ProofIcon />,
    noPrice: <ReceiptIcon />,
    notMeasured: <ProofIcon />,
    readFailed: <AlertIcon />,
    limited: <EyeOffIcon />,
  };

  const antetitulo = rotulos ? rotulos.antetitulo : `${t("verdictHero.eyebrow")} · ${t("verdictHero.rangeDays", { n: rango })}`;
  const controles = (
    <div className="verdict-ctl">
      {rotulos ? (
        <span className="pill await">
          <span className="dot" />
          {rotulos.pastilla}
        </span>
      ) : (
        <ProvenancePill kind={live ? "live" : "await"} />
      )}
      {/* Vivo desde el 2026-09-19. Eran tres botones deshabilitados con
          `aria-hidden`: un control que promete y no hace nada es peor que
          ninguno. Ahora el rango viaja en la URL y lo aplica el servidor. */}
      {rotulos ? null : <RangeSwitch activo={rango} />}
    </div>
  );

  if (live && v.kind === "measured") {
    // base = saved ÷ net (ver la cabecera). Sin `net`, sin esas dos filas.
    const base = v.net !== 0 ? v.saved / v.net : null;
    return (
      <div className="verdict" data-state={estado} data-tour="verdict">
        <div className="verdict-main">
          <p className="ck-eyebrow">{antetitulo}</p>
          {rotulos ? null : (
            <p className="verdict-status" data-tone={v.tone}>
              <span className="verdict-status-ic" aria-hidden>
                {icono[estado]}
              </span>
              {rotulo[estado]}
            </p>
          )}
          <div className={`big ${v.tone} ck-num`}>
            {v.net < 0 ? "−" : ""}
            <NumberTicker
              value={Math.abs(v.net)}
              locale="en-US"
              format={{ style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }}
            />
          </div>
          <div className="cap">
            {rotulos
              ? rotulos.pie
              : v.tone === "neg"
                ? t.rich("verdictHero.lostLine", {
                    money: money(Math.abs(v.saved)),
                    b: (chunks) => <b>{chunks}</b>,
                  })
                : t.rich("verdictHero.savedLine", {
                    money: money(v.saved),
                    b: (chunks) => <b>{chunks}</b>,
                  })}
          </div>
          {rotulos ? (
            v.total !== null ? (
              <p className="ck-note">
                {t("verdictHero.totalSplit", { pct: pct(v.total.net), share: `${Math.round(v.share * 100)}%` })}
              </p>
            ) : null
          ) : (
            <details className="disc">
              <summary>{t("verdictHero.method")}</summary>
              <div className="disc-body">
                {v.total !== null && (
                  <p className="ck-note">
                    {t("verdictHero.totalSplit", {
                      pct: pct(v.total.net),
                      share: `${Math.round(v.share * 100)}%`,
                    })}
                  </p>
                )}
                {/* 0029 · la parte del titular medida POR REFERENCIA: repeticiones
                    servidas sin llamar al proveedor, valoradas con el contador de
                    la petición idéntica que ya corrió. Ya está DENTRO del titular
                    (deriveVerdict la suma bajo COMISIONAR_REFERENCIA); esta línea
                    solo dice cuánto y de dónde sale. */}
                {v.byReference && (
                  <p className="ck-note">
                    {t.rich("verdictHero.referenceNote", {
                      money: money(v.byReference.saved),
                      count: v.byReference.requests,
                      b: (chunks) => <b>{chunks}</b>,
                    })}
                  </p>
                )}
                <p className="ck-note">{t("verdictHero.methodBody")}</p>
                <p className="disc-src">bvsala.usage_daily · measured_baseline_cost − measured_actual_cost</p>
              </div>
            </details>
          )}
        </div>
        <div className="verdict-side">
          {controles}
          {rotulos ? null : (
            <Recibo
              compacto
              titulo={t("verdictHero.receipt.title")}
              meta={t("verdictHero.rangeDays", { n: rango })}
              filas={[
                ...(base !== null
                  ? [
                      { etiqueta: t("verdictHero.receipt.baseline"), valor: money(base) },
                      { etiqueta: t("verdictHero.receipt.actual"), valor: money(base - v.saved), tono: "coste" as const },
                    ]
                  : []),
                { etiqueta: t("verdictHero.receipt.coverage"), valor: pct0Floor(v.share), tono: "atenuado" as const },
              ]}
              total={{
                etiqueta: t("verdictHero.receipt.saved"),
                valor: moneySigned(v.saved),
                tono: v.tone === "neg" ? "coste" : "ahorro",
              }}
              evidencia={{ tipo: "tus-datos", label: u("evidence.tusDatos") }}
              procedencia={{ texto: t("verdictHero.receipt.origin"), href: "/dashboard/how-it-works", enlace: u("recibo.comoSeMidio") }}
            />
          )}
        </div>
      </div>
    );
  }

  const pie =
    estado === "limited"
      ? t("verdictHero.hiddenCap")
      : estado === "readFailed"
        ? t("verdictHero.errorCap")
        : estado === "noPrice"
          ? t("verdictHero.unpricedCap", { count: peticionesSinPrecio })
          : estado === "notMeasured" && v.kind === "sin_medir"
            ? t("verdictHero.unmeasuredCap", { count: v.requests })
            : estado === "noTraffic" && integrado === true
              ? t("verdictHero.noTrafficCap")
              : t("verdictHero.emptyCap");

  return (
    <div className="verdict verdict-empty" data-state={estado} data-tour="verdict">
      <div className="verdict-main">
        <p className="ck-eyebrow">{antetitulo}</p>
        <div className="verdict-lead">
          <span className="verdict-ic" aria-hidden>
            {icono[estado]}
          </span>
          <h3 className="verdict-title">
            {/* El marcador de la Firma de campaña, calculado sobre la última palabra. */}
            <TitularMarcado texto={rotulo[estado]} />
          </h3>
        </div>
        <div className="cap">{pie}</div>
        {rotulos ? null : (
          <div className="verdict-actions">
            {estado === "notIntegrated" ? (
              <Link className="btn btn-primary" href="/dashboard/install">
                {t("verdictHero.actions.install")}
              </Link>
            ) : null}
            {estado === "noTraffic" && rango !== RANGO_POR_DEFECTO ? (
              <Link className="btn btn-primary" href="/dashboard" scroll={false}>
                {t("verdictHero.actions.widen", { n: RANGO_POR_DEFECTO })}
              </Link>
            ) : null}
            {estado === "noTraffic" || estado === "notMeasured" ? (
              <Link className="btn btn-ghost" href="/dashboard/install">
                {t("verdictHero.actions.checkInstall")}
              </Link>
            ) : null}
            {estado === "readFailed" || estado === "limited" ? (
              <a className="btn btn-ghost" href="mailto:support@bivelio.com">
                {t("verdictHero.actions.support")}
              </a>
            ) : null}
            <Link className="btn btn-quiet" href="/dashboard/how-it-works">
              {t("verdictHero.actions.how")}
            </Link>
          </div>
        )}
      </div>
      <div className="verdict-side">{controles}</div>
    </div>
  );
}
