import { getLocale, getTranslations } from "next-intl/server";

import { extractoEnSombra, periodoDe } from "@/lib/billing/extracto-sombra";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { loadDashboard } from "../load";

/** Una fila del historial: el extracto cerrado con el estado de su cobro. */
interface PeriodoCerrado {
  periodo: string;
  es_calibracion: boolean;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  cargo_eur: number;
  cobro: { estado: string; url: string | null; numero: string | null } | null;
}

/**
 * Los períodos cerrados de la organización, con su cobro. Se filtra por
 * `org_id` EXPLÍCITAMENTE: la RLS de miembro devuelve las filas de todas las
 * organizaciones del usuario, y mezclarlas pintaría extractos ajenos.
 */
async function periodosCerrados(orgId: string): Promise<PeriodoCerrado[] | null> {
  const supabase = await createReadOnlyClient();
  const [{ data: extractos, error: e1 }, { data: cargos, error: e2 }] = await Promise.all([
    supabase
      .schema("bvsala")
      .from("extractos")
      .select("periodo, es_calibracion, base_medida_eur, ahorro_medido_eur, ratio, cargo_eur")
      .eq("org_id", orgId)
      .order("periodo", { ascending: false })
      .limit(24),
    supabase.schema("bvsala").from("cargos").select("periodo, estado, detalle").eq("org_id", orgId),
  ]);
  if (e1 || e2) return null; // el fallo de lectura se pinta como tal, no como "sin historial"
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
    base_medida_eur: Number(x.base_medida_eur ?? 0),
    ahorro_medido_eur: Number(x.ahorro_medido_eur ?? 0),
    ratio: Number(x.ratio ?? 0),
    cargo_eur: Number(x.cargo_eur ?? 0),
    cobro: cobroPorPeriodo.get(String(x.periodo)) ?? null,
  }));
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
  const { usage, usageFailed, orgId } = await loadDashboard();

  const periodo = periodoDe(new Date());
  const e = extractoEnSombra("panel", usage, periodo);
  const cerrados = orgId ? await periodosCerrados(orgId) : [];

  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR" });
  const usd = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "USD" });
  const pct = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("extracto.eyebrow")}</p>
        <h1>{t("extracto.title")}</h1>
        <p>{t("extracto.intro", { cero: (0).toLocaleString(locale, { style: "currency", currency: "EUR" }) })}</p>
      </div>

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <h2>{t("extracto.periodo", { periodo })}</h2>
          </div>
          <span className="est-tag">{e.esCalibracion ? t("extracto.badgeCalibracion") : t("extracto.badgeSombra")}</span>
        </div>

        {usageFailed ? (
          <p className="ck-note" style={{ color: "var(--danger)" }}>{t("extracto.lecturaFallo")}</p>
        ) : null}

        <div className="kpi" style={{ minHeight: "auto", marginBottom: 14 }}>
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

        <h3 style={{ margin: "18px 0 6px", fontSize: "1rem" }}>{t("extracto.tramosTitulo")}</h3>
        {e.comision.tramos.length === 0 ? (
          <p className="ck-note">{t("extracto.sinAhorro")}</p>
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

        <p className="ck-note" style={{ marginTop: 14 }}>
          {t("extracto.estimadoExcluido", { usd: usd(e.ahorroEstimadoExcluidoUsd) })}
        </p>
        {/* El carril sombra (0021): contexto hipotético, jamás en la base — y
            solo cuando hay datos. Con ahorro negativo, la clave lo dice claro. */}
        {e.sombra && (
          <p className="ck-note">
            {t(e.sombra.ahorroUsd < 0 ? "extracto.sombraElisionNegativa" : "extracto.sombraElision", {
              usd: usd(Math.abs(e.sombra.ahorroUsd)),
              requests: e.sombra.requests.toLocaleString(locale),
            })}
          </p>
        )}
        <p className="ck-note">
          {t("extracto.parametros", {
            version: e.parametros.versionPrecios,
            // La unidad y la fuente van construidas AQUÍ: los ficheros de
            // mensajes tienen prohibido llevar EUR/USD a mano (parity.test.ts).
            fx: `${e.parametros.fx.eurPorUsd.toLocaleString(locale)} EUR/USD — ${e.parametros.fx.fuente}`,
          })}
        </p>
        <p className="ck-note">
          <b>{t("extracto.mismaFacturaTitulo")}</b> {t("extracto.mismaFactura")}
        </p>
      </section>

      {/* EL HISTORIAL AUDITABLE: cada período cerrado (documento inmutable) con
          el estado de su cobro y el enlace a la factura de Stripe que lo cita.
          El dinero que este producto cobra tiene que poder rastrearse desde
          aquí hasta la factura sin pedirle nada a nadie. */}
      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <h2>{t("extracto.historialTitulo")}</h2>
            <p className="ck-note">{t("extracto.historialIntro")}</p>
          </div>
        </div>
        {cerrados === null ? (
          <p className="ck-note" style={{ color: "var(--danger)" }}>{t("extracto.lecturaFallo")}</p>
        ) : cerrados.length === 0 ? (
          <p className="ck-note">{t("extracto.historialVacio")}</p>
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
                    <td className="ck-num">{p.periodo}</td>
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
