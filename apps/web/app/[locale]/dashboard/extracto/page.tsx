import { Fragment } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { AccountTabs } from "@/app/components/app/AccountTabs";
import { PageHead } from "@/app/components/app/PageHead";

import { extractoEnSombra, periodoDe } from "@/lib/billing/extracto-sombra";
import { diaSiguiente, diasEntre, MAX_FILAS_POR_DESCARGA } from "@/lib/metering/referencias-csv";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { loadDashboard } from "../load";

/** Una fila del historial: el extracto cerrado con el estado de su cobro. */
interface PeriodoCerrado {
  periodo: string;
  es_calibracion: boolean;
  es_exento: boolean;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  cargo_eur: number;
  cobro: { estado: string; url: string | null; numero: string | null } | null;
  /** Repeticiones medidas por referencia selladas en el período (0029); 0 sin la migración. */
  requests_referencia: number;
}

/**
 * Los períodos cerrados de la organización, con su cobro. Se filtra por
 * `org_id` EXPLÍCITAMENTE: la RLS de miembro devuelve las filas de todas las
 * organizaciones del usuario, y mezclarlas pintaría extractos ajenos.
 */
async function periodosCerrados(orgId: string): Promise<PeriodoCerrado[] | null> {
  const supabase = await createReadOnlyClient();
  const [{ data: extractos, error: e1 }, { data: cargos, error: e2 }, { data: referencias, error: e3 }] = await Promise.all([
    supabase
      .schema("bvsala")
      .from("extractos")
      .select("periodo, es_calibracion, es_exento, base_medida_eur, ahorro_medido_eur, ratio, cargo_eur")
      .eq("org_id", orgId)
      .order("periodo", { ascending: false })
      .limit(24),
    supabase.schema("bvsala").from("cargos").select("periodo, estado, detalle").eq("org_id", orgId),
    // 0029 · aparte y TOLERANTE: sin la migración la columna no existe, y eso no
    // puede tumbar el historial entero — solo deja sin enlace CSV a los períodos.
    supabase
      .schema("bvsala")
      .from("extractos")
      .select("periodo, requests_referencia")
      .eq("org_id", orgId)
      .order("periodo", { ascending: false })
      .limit(24),
  ]);
  if (e1 || e2) return null; // el fallo de lectura se pinta como tal, no como "sin historial"
  if (e3) console.warn("[extracto] historial sin requests_referencia (¿falta la migración 0029?):", e3.message);
  const referenciasPorPeriodo = new Map(
    (e3 ? [] : ((referencias ?? []) as Array<{ periodo: string; requests_referencia: number | string | null }>)).map(
      (r) => [String(r.periodo), Number(r.requests_referencia ?? 0)] as const,
    ),
  );
  const cobroPorPeriodo = new Map(
    (cargos ?? []).map((c) => {
      const detalle = (c.detalle ?? {}) as { hosted_invoice_url?: string | null; numero?: string | null };
      return [String(c.periodo), {
        estado: String(c.estado),
        url: detalle.hosted_invoice_url ?? null,
        numero: detalle.numero ?? null,
      }] as const;
    }),
  );
  return (extractos ?? []).map((x) => ({
    periodo: String(x.periodo),
    es_calibracion: Boolean(x.es_calibracion),
    es_exento: Boolean((x as { es_exento?: boolean }).es_exento),
    base_medida_eur: Number(x.base_medida_eur ?? 0),
    ahorro_medido_eur: Number(x.ahorro_medido_eur ?? 0),
    ratio: Number(x.ratio ?? 0),
    cargo_eur: Number(x.cargo_eur ?? 0),
    cobro: cobroPorPeriodo.get(String(x.periodo)) ?? null,
    requests_referencia: referenciasPorPeriodo.get(String(x.periodo)) ?? 0,
  }));
}

/**
 * Los días del período ya empezados (UTC), para la descarga día a día cuando el
 * mes no cabe en un solo fichero (MAX_FILAS_POR_DESCARGA).
 */
function diasDelPeriodoHastaHoy(periodo: string, hoy: Date): string[] {
  const [y, m] = periodo.split("-").map(Number);
  const finDelMes = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
  const manana = diaSiguiente(hoy.toISOString().slice(0, 10));
  return diasEntre(`${periodo}-01`, manana < finDelMes ? manana : finDelMes);
}

/** La clave i18n del estado del cobro de un período cerrado. */
function claveDeEstado(p: PeriodoCerrado): string {
  if (p.cobro) {
    const porEstado: Record<string, string> = {
      pagado: "estadoPagado",
      facturado: "estadoFacturado",
      fallido: "estadoFallido",
      omitido_sin_cliente: "estadoOmitidoSinCliente",
      omitido_bajo_minimo: "estadoOmitidoBajoMinimo",
    };
    return porEstado[p.cobro.estado] ?? "estadoPendiente";
  }
  if (p.es_calibracion) return "estadoCalibracion";
  // Probadores y cortesías: la comisión se calcula, el cargo es cero, y se dice.
  if (p.es_exento) return "estadoExento";
  if (p.cargo_eur <= 0) return "estadoSinCargo";
  // Cargo sin fila de cobro: el cron del día uno aún no ha pasado (o falló y
  // alertó). "Pendiente" es la verdad — nunca se pinta como pagado ni omitido.
  return "estadoPendiente";
}

/**
 * EL EXTRACTO EN SOMBRA — la pantalla del mes de calibración del plan maestro.
 *
 * Enseña, desde el primer día, el documento exacto que la futura factura
 * variable producirá: base medida, ahorro medido, ratio, rampa, tramos y la
 * comisión resultante — con la etiqueta que corresponda (calibración: 0 €).
 * Nada de esta pantalla cobra: es la sombra. La única fuente de cálculo es
 * `construirExtracto`; aquí solo se pinta.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("extracto.metaTitle") };
}

export default async function ExtractoPage() {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const { ctx, usage, usageFailed, orgId } = await loadDashboard();

  const periodo = periodoDe(new Date());
  // La marca de exención (0028) llega también a la sombra: sin esto la cabecera
  // diría «cargo 12 €» y la tabla de abajo «exento de comisión».
  let esExento = false;
  if (orgId) {
    const supabase = await createReadOnlyClient();
    const { data: org } = await supabase.schema("bvsala").from("organizations").select("comision_exenta").eq("id", orgId).maybeSingle();
    esExento = Boolean((org as { comision_exenta?: boolean } | null)?.comision_exenta);
  }
  const e = extractoEnSombra("panel", usage, periodo, esExento);
  const cerrados = orgId ? await periodosCerrados(orgId) : [];

  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR" });
  const usd = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "USD" });
  const pct = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  return (
    <>
      <AccountTabs role={ctx.role} />
      <PageHead
        eyebrow={t("extracto.eyebrow")}
        title={t("extracto.title")}
        sub={t("extracto.intro", { cero: (0).toLocaleString(locale, { style: "currency", currency: "EUR" }) })}
      />

      <section className="app-section">
        <div className="app-sec-head">
          <div>
            <h2 className="t-section">{t("extracto.periodo", { periodo })}</h2>
          </div>
          <span className="est-tag">{e.esCalibracion ? t("extracto.badgeCalibracion") : t("extracto.badgeSombra")}</span>
        </div>

        {usageFailed ? (
          <p className="app-note warn" role="alert">{t("extracto.lecturaFallo")}</p>
        ) : null}

        <div className="kpi kpi-auto">
          <div className="n">{t("extracto.kpiTitulo")}</div>
          <div className="v pos ck-num">{eur(e.cargoEur)}</div>
          <div className="sub">
            {e.esCalibracion
              ? t("extracto.notaCalibracion", { habria: eur(e.comision.comisionEur) })
              : t("extracto.notaSombra", { comision: eur(e.comision.comisionEur) })}
          </div>
        </div>

        <div className="hiw-two">
          <div className="hiw-mcard">
            <span className="k">{t("extracto.baseMedida")}</span>
            <div className="v">{eur(e.baseMedidaEur)}</div>
            <p>
              {t("extracto.enUsd", { usd: usd(e.baseMedidaUsd) })} · {t("extracto.requests", { n: e.requestsMedidas.toLocaleString(locale) })}
            </p>
          </div>
          <div className="hiw-mcard">
            <span className="k">{t("extracto.ahorroMedido")}</span>
            <div className="v real">{eur(e.ahorroMedidoEur)}</div>
            <p>
              {t("extracto.ratio", { pct: pct(e.comision.ratio) })}
            </p>
          </div>
        </div>

        <h3 className="t-block">{t("extracto.tramosTitulo")}</h3>
        {e.comision.tramos.length === 0 ? (
          <p className="note">{t("extracto.sinAhorro")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("extracto.colTramo")}</th>
                  <th>{t("extracto.colTipo")}</th>
                  <th>{t("extracto.colBase")}</th>
                  <th>{t("extracto.colComision")}</th>
                </tr>
              </thead>
              <tbody>
                {e.comision.tramos.map((tr) => (
                  <tr key={tr.desdeEur}>
                    <td className="ck-num">
                      {eur(tr.desdeEur)} – {Number.isFinite(tr.hastaEur) ? eur(tr.hastaEur) : "∞"}
                    </td>
                    <td className="ck-num">{pct(tr.tipo)}</td>
                    <td className="ck-num">{eur(tr.baseEur)}</td>
                    <td className="ck-num">{eur(tr.comisionEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="note">
          {t("extracto.estimadoExcluido", { usd: usd(e.ahorroEstimadoExcluidoUsd) })}
        </p>
        {/* 0029 · el carril MEDIDO POR REFERENCIA: repeticiones servidas sin
            llamar al proveedor, valoradas con el contador de la petición
            idéntica que ya corrió. Comisionado, ya está dentro de la base de
            arriba; si no, es contexto. Siempre con su CSV línea a línea, para
            que cada fila se pueda contrastar con el uso del proveedor. */}
        {e.referencia && (
          <p className="note">
            {t(e.referencia.comisionada ? "extracto.referencia" : "extracto.referenciaExcluida", {
              usd: usd(e.referencia.ahorroUsd),
              requests: e.referencia.requests.toLocaleString(locale),
            })}{" "}
            {/* Un mes con más filas de las que caben en una descarga se baja
                por días (la ruta respondería 413 al mes entero). */}
            {e.referencia.requests <= MAX_FILAS_POR_DESCARGA ? (
              <a href={`/api/org/reference-hits?periodo=${periodo}`}>{t("extracto.exportarReferencias")}</a>
            ) : (
              <>
                {t("extracto.exportarReferenciasPorDia")}{" "}
                {diasDelPeriodoHastaHoy(periodo, new Date()).map((d, i) => (
                  <Fragment key={d}>
                    {i > 0 ? " · " : ""}
                    <a href={`/api/org/reference-hits?dia=${d}`}>{Number(d.slice(8)).toLocaleString(locale)}</a>
                  </Fragment>
                ))}
              </>
            )}
          </p>
        )}
        {/* El carril sombra (0021): contexto hipotético, jamás en la base — y
            solo cuando hay datos. Con ahorro negativo, la clave lo dice claro. */}
        {e.sombra && (
          <p className="note">
            {t(e.sombra.ahorroUsd < 0 ? "extracto.sombraElisionNegativa" : "extracto.sombraElision", {
              usd: usd(Math.abs(e.sombra.ahorroUsd)),
              requests: e.sombra.requests.toLocaleString(locale),
            })}
          </p>
        )}
        {/* El borrado del proveedor (0025): solo el CONTEO de acreditadas. El
            dólar suelo viaja en `e.elisionProveedor.floorUsd` pero NO se pinta
            hasta medir el neto por modelo — y jamás entra en la base. */}
        {e.elisionProveedor && (
          <p className="note">
            {t("extracto.elisionProveedor", { requests: e.elisionProveedor.requests.toLocaleString(locale) })}
          </p>
        )}
        <p className="note">
          {t("extracto.parametros", {
            version: e.parametros.versionPrecios,
            // La unidad y la fuente van construidas AQUÍ: los ficheros de
            // mensajes tienen prohibido llevar EUR/USD a mano (parity.test.ts).
            fx: `${e.parametros.fx.eurPorUsd.toLocaleString(locale)} EUR/USD — ${e.parametros.fx.fuente}`,
          })}
        </p>
        {/* La regla con la que se valoran las repeticiones (0029): parte de los
            parámetros que hacen el extracto autocontenido. Cifras por parámetro,
            nunca escritas en los mensajes (tarifa-en-parametros.test.ts). Solo
            cuando el período TIENE repeticiones valoradas así: antes de que el
            SDK las emita, describiría como vigente una regla que nada aplica. */}
        {e.referencia && (
          <p className="note">
            {t("extracto.parametrosReferencia", {
              regla: e.parametros.referencia.version,
              cuota: pct(e.parametros.referencia.cuotaSalida),
              dias: e.parametros.referencia.edadMaximaDias,
            })}
          </p>
        )}
        <p className="note">
          <b>{t("extracto.mismaFacturaTitulo")}</b> {t("extracto.mismaFactura")}
        </p>
      </section>

      {/* EL HISTORIAL AUDITABLE: cada período cerrado (documento inmutable) con
          el estado de su cobro y el enlace a la factura de Stripe que lo cita.
          El dinero que este producto cobra tiene que poder rastrearse desde
          aquí hasta la factura sin pedirle nada a nadie. */}
      <section className="app-section">
        <div className="app-sec-head">
          <div>
            <h2 className="t-section">{t("extracto.historialTitulo")}</h2>
            <p className="sub-section">{t("extracto.historialIntro")}</p>
          </div>
        </div>
        {cerrados === null ? (
          <p className="app-note warn" role="alert">{t("extracto.lecturaFallo")}</p>
        ) : cerrados.length === 0 ? (
          <p className="note">{t("extracto.historialVacio")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("extracto.hcolPeriodo")}</th>
                  <th>{t("extracto.hcolBase")}</th>
                  <th>{t("extracto.hcolAhorro")}</th>
                  <th>{t("extracto.hcolRatio")}</th>
                  <th>{t("extracto.hcolCargo")}</th>
                  <th>{t("extracto.hcolCobro")}</th>
                  <th>{t("extracto.hcolFactura")}</th>
                </tr>
              </thead>
              <tbody>
                {cerrados.map((p) => (
                  <tr key={p.periodo}>
                    <td className="ck-num">
                      {p.periodo}
                      {/* 0029 · la prueba fila a fila del período SELLADO (el que
                          se factura), mientras la retención la conserve. */}
                      {p.requests_referencia > 0 && (
                        <>
                          {" · "}
                          <a href={`/api/org/reference-hits?periodo=${p.periodo}`} title={t("extracto.exportarReferencias")}>
                            CSV
                          </a>
                        </>
                      )}
                    </td>
                    <td className="ck-num">{eur(p.base_medida_eur)}</td>
                    <td className="ck-num">{eur(p.ahorro_medido_eur)}</td>
                    <td className="ck-num">{pct(p.ratio)}</td>
                    <td className="ck-num">{eur(p.cargo_eur)}</td>
                    <td>{t(`extracto.${claveDeEstado(p)}`)}</td>
                    <td>
                      {p.cobro?.url ? (
                        <a href={p.cobro.url} target="_blank" rel="noreferrer">
                          {p.cobro.numero ?? t("extracto.verFactura")}
                        </a>
                      ) : (
                        p.cobro?.numero ?? "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
