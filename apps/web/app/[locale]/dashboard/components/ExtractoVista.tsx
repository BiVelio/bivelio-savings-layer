import { Fragment, type ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { EvidenceBadge, Notice, Recibo } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import type { Extracto } from "@/lib/billing/extracto";
import { Badge, type BadgeTone } from "@/vendor/affectui/badge-clean";
import { DataTable } from "@/vendor/affectui/data-table-clean";
import { EmptyCalendar } from "@/vendor/affectui/empty-calendar";
import { EmptyState } from "@/vendor/affectui/empty-state-clean";

/**
 * El tono de la insignia de cada estado de cobro. Solo color: el texto es el
 * mismo de siempre. Un estado que no esté aquí sale neutro, nunca verde.
 */
const TONO_DEL_ESTADO: Record<string, BadgeTone> = {
  estadoPagado: "success",
  estadoFacturado: "info",
  estadoPendiente: "warning",
  estadoFallido: "danger",
};

/**
 * Cómo se factura HOY la organización, según lo que la página ya consulta.
 *
 * `medir`: la organización solo tiene la licencia gratuita Measure — modo
 * sombra, ahorro ESTIMADO que nunca se factura ni entra en comisión alguna
 * (LICENSE-CLOUD §1). `ninguno`: sin plan vivo y sin Measure; la página no
 * puede confirmar la modalidad y lo dice con el aviso neutro, sin atribuir
 * nada a las condiciones publicadas (§6(b) solo da comisión al plan que la lleva).
 */
export type RegimenDelExtracto = "fija" | "exenta" | "legado" | "medir" | "ninguno" | "indeterminado";

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
  // FIRMA DE CAMPAÑA (2026-11-17): la hoja en sombra de la dirección B —un
  // panel rayado, la insignia en contorno y el cargo como cifra protagonista—
  // con la tipografía del armazón. Mismos textos y mismas cifras.
  const simulacion = (
    <div className="pcu-sombra">
      <span className="pfc-insignia pfc-insignia--sombra pcu-sombra-insignia">
        {e.esCalibracion ? t("extracto.badgeCalibracion") : t("extracto.badgeSombra")}
      </span>
      <div className="pcu-cargo">
        <p className="pcu-cargo-k">{t("extracto.kpiTitulo")}</p>
        <p className="pfc-cifra pcu-cargo-v">{eur(e.cargoEur)}</p>
        <p className="pcu-cargo-n">
          {e.esCalibracion
            ? t("extracto.notaCalibracion", { habria: eur(e.comision.comisionEur) })
            : // «Ninguna factura la incluye todavía» promete una factura futura:
              // solo es verdad para quien conserva la modalidad con comisión.
              t(aplicaComision ? "extracto.notaSombra" : "extracto.notaSombraReferencia", {
                comision: eur(e.comision.comisionEur),
              })}
        </p>
      </div>

      <h4 className="pcu-h4">{t("extracto.tramosTitulo")}</h4>
      {e.comision.tramos.length === 0 ? (
        <p className="pfc-nota">{t("extracto.sinAhorro")}</p>
      ) : (
        <DataTable
          flat
          narrow="stack"
          className="ext-tramos pcu-tabla"
          label={t("extracto.tramosTitulo")}
          columns={[
            { key: "tramo", label: t("extracto.colTramo"), lead: true, mono: true },
            { key: "tipo", label: t("extracto.colTipo"), align: "end", mono: true },
            { key: "base", label: t("extracto.colBase"), align: "end", mono: true },
            { key: "comision", label: t("extracto.colComision"), align: "end", mono: true },
          ]}
          rows={e.comision.tramos.map((tr) => ({
            id: String(tr.desdeEur),
            cells: {
              tramo: (
                <>
                  {eur(tr.desdeEur)} – {Number.isFinite(tr.hastaEur) ? eur(tr.hastaEur) : "∞"}
                </>
              ),
              tipo: pct(tr.tipo),
              base: eur(tr.baseEur),
              comision: eur(tr.comisionEur),
            },
          }))}
        />
      )}
      {/* La regla con la que se valoran las repeticiones (0029): parte de los
          parámetros que hacen el extracto autocontenido. Cifras por parámetro,
          nunca escritas en los mensajes (tarifa-en-parametros.test.ts). Solo
          cuando el período TIENE repeticiones valoradas así. */}
      {e.referencia && (
        <p className="pfc-nota">
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
        <p className="pfc-nota">
          <b>{t("extracto.mismaFacturaTitulo")}</b> {t("extracto.mismaFactura")}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="pcu-ext">
      {/* (a) GASTO Y AHORRO DEL PERIODO: lo medido, con su procedencia. */}
      <section className="pfc-sec" aria-labelledby="ext-gasto">
        <CabeceraDeSeccion
          n="01"
          id="ext-gasto"
          titulo={t("extracto.gastoTitulo")}
          sub={t("extracto.gastoSub")}
          aside={<span className="pfc-chip pcu-chip-mono">{t("extracto.periodo", { periodo })}</span>}
        />

        {usageFailed ? (
          <Notice tono="danger">{t("extracto.lecturaFallo")}</Notice>
        ) : null}

        {sinTrafico && usageFailed ? null : sinTrafico ? (
          <div className="ext-vacio-grande">
            <EmptyCalendar className="ext-ilustracion" />
            <EmptyState bare icon={null} title={t("extracto.sinTraficoTitulo")} text={t("extracto.sinTraficoBody")} />
          </div>
        ) : (
          <div className="pcu-gasto">
            <Recibo
              ancho
              className="pcu-recibo"
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
            <div className="pcu-fuera">
              <h3 className="pcu-fuera-t">{t("extracto.contextoTitulo")}</h3>
              <ul className="pcu-lineas">
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
                        <a className="pcu-descarga" href={`/api/org/reference-hits?periodo=${periodo}`}>
                          <IconoDescarga />
                          {t("extracto.exportarReferencias")}
                        </a>
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
      <section className="pfc-sec" aria-labelledby="ext-contrato">
        <CabeceraDeSeccion n="02" id="ext-contrato" titulo={t("extracto.contratoTitulo")} sub={t("extracto.contratoSub")} />
        <div className="pfc-tarjeta pcu-contrato" data-regimen={regimen}>
          <div className="pcu-contrato-txt">
            <h3 className="pcu-contrato-t">
              {regimen === "fija"
                ? t("extracto.regimenFijaTitulo")
                : regimen === "exenta"
                  ? t("extracto.regimenExentaTitulo")
                  : regimen === "legado"
                    ? t("extracto.regimenLegadoTitulo")
                    : regimen === "medir"
                      ? t("extracto.regimenMedirTitulo")
                      : // «ninguno» comparte el rótulo neutro de «indeterminado».
                        t("extracto.regimenIndeterminadoTitulo")}
            </h3>
            <p>
              {regimen === "fija"
                ? t("extracto.regimenFijaBody")
                : regimen === "exenta"
                  ? t("extracto.regimenExentaBody")
                  : regimen === "legado"
                    ? t("extracto.regimenLegadoBody")
                    : regimen === "medir"
                      ? t("extracto.regimenMedirBody")
                      : regimen === "indeterminado"
                        ? t("extracto.regimenIndeterminadoBody")
                        : t("extracto.regimenNingunoBody")}
            </p>
          </div>
          <Link className="btn btn-ghost pcu-contrato-btn" href="/dashboard/account">
            {t("extracto.irACuenta")}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
      </section>

      {/* (c) EL HISTÓRICO DE COMISIÓN, rotulado como lo que es: una modalidad
          cerrada a nuevas altas. La simulación NO se rebautiza como factura. */}
      <section className="pfc-sec" aria-labelledby="ext-historico">
        <CabeceraDeSeccion
          n="03"
          id="ext-historico"
          titulo={t("extracto.historicoTitulo")}
          sub={t("extracto.historicoSub")}
          aside={<span className="pfc-chip pcu-chip-linea">{t("extracto.historicoEtiqueta")}</span>}
        />

        {sinTrafico ? null : aplicaComision ? (
          <div className="pfc-tarjeta pcu-sim">
            <div className="pcu-sim-cab">
              <h3 className="pcu-sim-t">{t("extracto.simulacionTitulo")}</h3>
              <p className="pcu-sim-nota">{t("extracto.simulacionAplica")}</p>
            </div>
            <div className="pcu-sim-cuerpo">{simulacion}</div>
          </div>
        ) : (
          <details className="pfc-tarjeta pcu-sim pcu-sim--plegada">
            <summary>
              <span className="pcu-sim-t">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="m9 6 6 6-6 6" />
                </svg>
                {t("extracto.simulacionTitulo")}
              </span>
              {/* «No se aplica» solo se afirma cuando se SABE (cuota fija o
                  exenta). En Measure es una simulación que nunca se factura;
                  sin poder confirmar la modalidad, puede aplicarse según el
                  contrato. */}
              <span className="pcu-sim-nota">
                {regimen === "medir"
                  ? t("extracto.simulacionMedir")
                  : regimen === "ninguno" || regimen === "indeterminado"
                    ? t("extracto.simulacionPuedeAplicar")
                    : t("extracto.simulacionNoAplica")}
              </span>
            </summary>
            <div className="pcu-sim-cuerpo">{simulacion}</div>
          </details>
        )}

        {/* EL HISTORIAL AUDITABLE: cada período cerrado (documento inmutable) con
            el estado de su cobro y el enlace a la factura de Stripe que lo cita. */}
        <div className="pfc-tarjeta pcu-historial">
          <div className="pfc-tarjeta-cab">
            <div>
              <h3 className="pfc-tarjeta-t">{t("extracto.historialTitulo")}</h3>
              <p className="pfc-tarjeta-sub pcu-historial-sub">{t(aplicaComision ? "extracto.historialIntro" : "extracto.historialIntroNeutro")}</p>
            </div>
          </div>
          <div className="pfc-tarjeta-cuerpo">
            {cerrados === null ? (
              <Notice tono="danger">{t("extracto.lecturaFallo")}</Notice>
            ) : cerrados.length === 0 ? (
              <p className="pfc-bandeja pcu-vacio">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <rect x="3.5" y="4.5" width="17" height="16" rx="3" />
                  <path d="M3.5 9.5h17M8 2.75v3.5M16 2.75v3.5" />
                </svg>
                <span>{t("extracto.historialVacio")}</span>
              </p>
            ) : (
              <DataTable
                flat
                narrow="stack"
                className="ext-historial pcu-tabla"
                label={t("extracto.historialTitulo")}
                sortLabel={t("panel.sortBy", { column: "{column}" })}
                columns={[
                  { key: "periodo", label: t("extracto.hcolPeriodo"), lead: true, mono: true, sortable: true },
                  { key: "base", label: t("extracto.hcolBase"), align: "end", mono: true, sortable: true },
                  { key: "ahorro", label: t("extracto.hcolAhorro"), align: "end", mono: true, sortable: true },
                  { key: "ratio", label: t("extracto.hcolRatio"), align: "end", mono: true, sortable: true },
                  { key: "cargo", label: t("extracto.hcolCargo"), align: "end", mono: true, sortable: true },
                  { key: "cobro", label: t("extracto.hcolCobro") },
                  { key: "factura", label: t("extracto.hcolFactura"), align: "end" },
                ]}
                rows={cerrados.map((p) => ({
                  id: p.periodo,
                  sort: {
                    periodo: p.periodo,
                    base: p.base_medida_eur,
                    ahorro: p.ahorro_medido_eur,
                    ratio: p.ratio,
                    cargo: p.cargo_eur,
                  },
                  cells: {
                    periodo: (
                      <>
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
                      </>
                    ),
                    base: eur(p.base_medida_eur),
                    ahorro: <span className="ext-ahorro">{eur(p.ahorro_medido_eur)}</span>,
                    ratio: pct(p.ratio),
                    cargo: eur(p.cargo_eur),
                    cobro: (
                      <Badge size="md" dot tone={TONO_DEL_ESTADO[p.claveDeEstado] ?? "neutral"}>
                        {t(`extracto.${p.claveDeEstado}`)}
                      </Badge>
                    ),
                    factura: p.cobro?.url ? (
                      <a href={p.cobro.url} target="_blank" rel="noreferrer">
                        {p.cobro.numero ?? t("extracto.verFactura")}
                      </a>
                    ) : (
                      p.cobro?.numero ?? "—"
                    ),
                  },
                }))}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * La cabecera numerada de cada parte del extracto (la estructura de la
 * dirección B): «01 ────», título y bajada, y a la derecha su etiqueta. El
 * número es decoración: el título ya dice qué es cada parte.
 */
function CabeceraDeSeccion({ n, id, titulo, sub, aside }: { n: string; id: string; titulo: string; sub: string; aside?: ReactNode }) {
  return (
    <div className="pfc-sec-cab pcu-sec-cab">
      <p className="pfc-rotulo" aria-hidden="true">
        <span className="pcu-num">{n}</span>
      </p>
      <div className="pfc-sec-fila">
        <div className="pcu-sec-txt">
          <h2 className="pfc-sec-t" id={id}>{titulo}</h2>
          <p className="pfc-sec-sub">{sub}</p>
        </div>
        {aside}
      </div>
    </div>
  );
}

function IconoDescarga() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </svg>
  );
}
