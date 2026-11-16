import { Fragment } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, EvidenceBadge, Notice, Recibo } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import type { Extracto } from "@/lib/billing/extracto";

/** Cómo se factura HOY la organización, según lo que la página ya consulta. */
export type RegimenDelExtracto = "fija" | "exenta" | "legado" | "ninguno" | "indeterminado";

/** Un período cerrado, con la clave i18n de su estado ya resuelta por la página. */
export interface PeriodoCerradoVisible {
  periodo: string;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  cargo_eur: number;
  cobro: { estado: string; url: string | null; numero: string | null } | null;
  requests_referencia: number;
  claveDeEstado: string;
}

/**
 * LO QUE SE VE DEL EXTRACTO, en tres partes que antes iban mezcladas:
 *
 *   (a) gasto y ahorro del periodo — lo medido, con su procedencia;
 *   (b) el contrato vigente — cómo se factura HOY (un plan de cuota fija no
 *       lleva comisión);
 *   (c) el histórico de comisión — una modalidad cerrada a nuevas altas, con su
 *       simulación y sus extractos cerrados, rotulada como tal.
 *
 * Solo pinta: las consultas, el régimen y la clave de cada estado los resuelve
 * la página. No calcula ninguna cifra que no venga en `e` o en `cerrados`.
 */
export async function ExtractoVista({
  e,
  periodo,
  regimen,
  usageFailed,
  cerrados,
  diasDeDescarga,
}: {
  e: Extracto;
  periodo: string;
  regimen: RegimenDelExtracto;
  usageFailed: boolean;
  /** `null` = fallo de lectura (se pinta como tal); `[]` = sin historial. */
  cerrados: PeriodoCerradoVisible[] | null;
  /** Los días por los que se descarga el CSV cuando el mes no cabe en un fichero; `null` si cabe. */
  diasDeDescarga: string[] | null;
}) {
  const t = await getTranslations("dashboard");
  const tu = await getTranslations("ui");
  const locale = await getLocale();
  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR" });
  const usd = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "USD" });
  const pct = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  // Un periodo sin tráfico medido no se pinta como una fila de ceros.
  const sinTrafico = e.requestsMedidas === 0 && e.baseMedidaEur === 0 && e.ahorroMedidoEur === 0;
  const aplicaComision = regimen === "legado";

  // LA SIMULACIÓN DE COMISIÓN, tal cual era: mismas cifras, mismas notas. Solo
  // cambia DÓNDE vive: dentro del histórico, rotulada como modalidad histórica.
  const simulacion = (
    <>
      <div className="ext-sim-head">
        <span className="est-tag">{e.esCalibracion ? t("extracto.badgeCalibracion") : t("extracto.badgeSombra")}</span>
      </div>
      <div className="kpi kpi-auto">
        <div className="n">{t("extracto.kpiTitulo")}</div>
        <div className="v pos ck-num">{eur(e.cargoEur)}</div>
        <div className="sub">
          {e.esCalibracion
            ? t("extracto.notaCalibracion", { habria: eur(e.comision.comisionEur) })
            : t("extracto.notaSombra", { comision: eur(e.comision.comisionEur) })}
        </div>
      </div>

      <h4 className="t-block">{t("extracto.tramosTitulo")}</h4>
      {e.comision.tramos.length === 0 ? (
        <p className="note">{t("extracto.sinAhorro")}</p>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl tbl--static">
            <thead>
              <tr>
                <th scope="col">{t("extracto.colTramo")}</th>
                <th scope="col">{t("extracto.colTipo")}</th>
                <th scope="col">{t("extracto.colBase")}</th>
                <th scope="col">{t("extracto.colComision")}</th>
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
      {/* La regla con la que se valoran las repeticiones (0029): parte de los
          parámetros que hacen el extracto autocontenido. Cifras por parámetro,
          nunca escritas en los mensajes (tarifa-en-parametros.test.ts). Solo
          cuando el período TIENE repeticiones valoradas así. */}
      {e.referencia && (
        <p className="note">
          {t("extracto.parametrosReferencia", {
            regla: e.parametros.referencia.version,
            cuota: pct(e.parametros.referencia.cuotaSalida),
            dias: e.parametros.referencia.edadMaximaDias,
          })}
        </p>
      )}
      {/* «Este documento ES la futura factura» solo es verdad para quien
          conserva la modalidad con comisión: a un plan de cuota fija o a una
          cuenta exenta no se le promete una factura que nunca tendrá. */}
      {aplicaComision ? (
        <p className="note">
          <b>{t("extracto.mismaFacturaTitulo")}</b> {t("extracto.mismaFactura")}
        </p>
      ) : null}
    </>
  );

  return (
    <>
      {/* (a) GASTO Y AHORRO DEL PERIODO: lo medido, con su procedencia. */}
      <section className="app-section" aria-labelledby="ext-gasto">
        <div className="app-sec-head">
          <div>
            <h2 className="t-section" id="ext-gasto">{t("extracto.gastoTitulo")}</h2>
            <p className="sub-section">{t("extracto.gastoSub")}</p>
          </div>
          <span className="ext-periodo">{t("extracto.periodo", { periodo })}</span>
        </div>

        {usageFailed ? (
          <Notice tono="danger">{t("extracto.lecturaFallo")}</Notice>
        ) : null}

        {sinTrafico && usageFailed ? null : sinTrafico ? (
          <EmptyState como="h3" titulo={t("extracto.sinTraficoTitulo")} texto={t("extracto.sinTraficoBody")} />
        ) : (
          <div className="ext-grid">
            <Recibo
              ancho
              titulo={t("extracto.periodo", { periodo })}
              meta={t("extracto.requests", { n: e.requestsMedidas.toLocaleString(locale) })}
              filas={[
                { etiqueta: t("extracto.baseMedida"), valor: eur(e.baseMedidaEur) },
                { etiqueta: t("extracto.baseUsd"), valor: usd(e.baseMedidaUsd), tono: "atenuado" },
                { etiqueta: t("extracto.ratioLabel"), valor: pct(e.comision.ratio), tono: "atenuado" },
              ]}
              total={{ etiqueta: t("extracto.ahorroMedido"), valor: eur(e.ahorroMedidoEur), tono: "ahorro" }}
              evidencia={{ tipo: "tus-datos", label: tu("evidence.tusDatos") }}
              procedencia={{
                texto: t("extracto.parametros", {
                  version: e.parametros.versionPrecios,
                  // La unidad y la fuente van construidas AQUÍ: los ficheros de
                  // mensajes tienen prohibido llevar EUR/USD a mano (parity.test.ts).
                  fx: `${e.parametros.fx.eurPorUsd.toLocaleString(locale)} EUR/USD — ${e.parametros.fx.fuente}`,
                }),
              }}
            />
            <div className="ext-contexto">
              <h3 className="ext-h">{t("extracto.contextoTitulo")}</h3>
              <ul className="ext-lineas">
                <li>
                  <EvidenceBadge pequeno tipo="estimacion" label={tu("evidence.estimacion")} />
                  <span>{t("extracto.estimadoExcluido", { usd: usd(e.ahorroEstimadoExcluidoUsd) })}</span>
                </li>
                {/* 0029 · el carril MEDIDO POR REFERENCIA: repeticiones servidas sin
                    llamar al proveedor, valoradas con el contador de la petición
                    idéntica que ya corrió. Siempre con su CSV línea a línea. */}
                {e.referencia && (
                  <li>
                    <EvidenceBadge pequeno tipo="tus-datos" label={tu("evidence.tusDatos")} />
                    <span>
                      {/* `requests` va como NÚMERO: el plural ICU elige la forma y `#` lo
                          formatea con el idioma. */}
                      {t(e.referencia.comisionada ? "extracto.referencia" : "extracto.referenciaExcluida", {
                        usd: usd(e.referencia.ahorroUsd),
                        requests: e.referencia.requests,
                      })}{" "}
                      {/* Un mes con más filas de las que caben en una descarga se baja
                          por días (la ruta respondería 413 al mes entero). */}
                      {diasDeDescarga === null ? (
                        <a href={`/api/org/reference-hits?periodo=${periodo}`}>{t("extracto.exportarReferencias")}</a>
                      ) : (
                        <>
                          {t("extracto.exportarReferenciasPorDia")}{" "}
                          {diasDeDescarga.map((d, i) => (
                            <Fragment key={d}>
                              {i > 0 ? " · " : ""}
                              <a href={`/api/org/reference-hits?dia=${d}`}>{Number(d.slice(8)).toLocaleString(locale)}</a>
                            </Fragment>
                          ))}
                        </>
                      )}
                    </span>
                  </li>
                )}
                {/* El carril sombra (0021): contexto hipotético, jamás en la base — y
                    solo cuando hay datos. Con ahorro negativo, la clave lo dice claro. */}
                {e.sombra && (
                  <li>
                    <EvidenceBadge pequeno tipo="sombra" label={tu("evidence.sombra")} />
                    <span>
                      {t(e.sombra.ahorroUsd < 0 ? "extracto.sombraElisionNegativa" : "extracto.sombraElision", {
                        usd: usd(Math.abs(e.sombra.ahorroUsd)),
                        requests: e.sombra.requests.toLocaleString(locale),
                      })}
                    </span>
                  </li>
                )}
                {/* El borrado del proveedor (0025): solo el CONTEO de acreditadas. El
                    dólar suelo NO se pinta — y jamás entra en la base. */}
                {e.elisionProveedor && (
                  <li>
                    <span>{t("extracto.elisionProveedor", { requests: e.elisionProveedor.requests.toLocaleString(locale) })}</span>
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </section>

      {/* (b) EL CONTRATO VIGENTE: cómo se factura HOY. Un plan de cuota fija no
          lleva comisión, y esta página deja de enseñársela como si la llevara. */}
      <section className="app-section" aria-labelledby="ext-contrato">
        <div className="app-sec-head">
          <div>
            <h2 className="t-section" id="ext-contrato">{t("extracto.contratoTitulo")}</h2>
            <p className="sub-section">{t("extracto.contratoSub")}</p>
          </div>
        </div>
        <div className="card ext-contrato" data-regimen={regimen}>
          <div className="ext-contrato-txt">
            <h3 className="ext-contrato-t">
              {regimen === "fija"
                ? t("extracto.regimenFijaTitulo")
                : regimen === "exenta"
                  ? t("extracto.regimenExentaTitulo")
                  : regimen === "legado"
                    ? t("extracto.regimenLegadoTitulo")
                    : regimen === "indeterminado"
                      ? t("extracto.regimenIndeterminadoTitulo")
                      : t("extracto.regimenNingunoTitulo")}
            </h3>
            <p>
              {regimen === "fija"
                ? t("extracto.regimenFijaBody")
                : regimen === "exenta"
                  ? t("extracto.regimenExentaBody")
                  : regimen === "legado"
                    ? t("extracto.regimenLegadoBody")
                    : regimen === "indeterminado"
                      ? t("extracto.regimenIndeterminadoBody")
                      : t("extracto.regimenNingunoBody")}
            </p>
          </div>
          <Link className="btn btn-ghost btn-sm" href="/dashboard/account">
            {t("extracto.irACuenta")}
          </Link>
        </div>
      </section>

      {/* (c) EL HISTÓRICO DE COMISIÓN, rotulado como lo que es: una modalidad
          cerrada a nuevas altas. La simulación NO se rebautiza como factura. */}
      <section className="app-section" aria-labelledby="ext-historico">
        <div className="app-sec-head">
          <div>
            <h2 className="t-section" id="ext-historico">{t("extracto.historicoTitulo")}</h2>
            <p className="sub-section">{t("extracto.historicoSub")}</p>
          </div>
          <span className="ext-legado">{t("extracto.historicoEtiqueta")}</span>
        </div>

        {sinTrafico ? null : aplicaComision ? (
          <div className="card ext-sim">
            <h3 className="ext-h">{t("extracto.simulacionTitulo")}</h3>
            <p className="note">{t("extracto.simulacionAplica")}</p>
            {simulacion}
          </div>
        ) : (
          <details className="ext-sim ext-sim--plegada">
            <summary>
              <span className="ext-h">{t("extracto.simulacionTitulo")}</span>
              <span className="ext-sim-nota">{t("extracto.simulacionNoAplica")}</span>
            </summary>
            <div className="ext-sim-body">{simulacion}</div>
          </details>
        )}

        {/* EL HISTORIAL AUDITABLE: cada período cerrado (documento inmutable) con
            el estado de su cobro y el enlace a la factura de Stripe que lo cita. */}
        <h3 className="ext-h ext-h--gap">{t("extracto.historialTitulo")}</h3>
        <p className="note">{t("extracto.historialIntro")}</p>
        {cerrados === null ? (
          <Notice tono="danger">{t("extracto.lecturaFallo")}</Notice>
        ) : cerrados.length === 0 ? (
          <p className="note ext-vacio">{t("extracto.historialVacio")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl tbl--static">
              <thead>
                <tr>
                  <th scope="col">{t("extracto.hcolPeriodo")}</th>
                  <th scope="col">{t("extracto.hcolBase")}</th>
                  <th scope="col">{t("extracto.hcolAhorro")}</th>
                  <th scope="col">{t("extracto.hcolRatio")}</th>
                  <th scope="col">{t("extracto.hcolCargo")}</th>
                  <th scope="col">{t("extracto.hcolCobro")}</th>
                  <th scope="col">{t("extracto.hcolFactura")}</th>
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
                    <td>{t(`extracto.${p.claveDeEstado}`)}</td>
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
