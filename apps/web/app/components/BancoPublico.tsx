import type { ReactNode } from "react";

import {
  BATERIAS,
  type Banco,
  type Bateria,
  type CeldaSemanal,
  type EvidenciaFamilia,
  type EvidenciaSemanal,
  type Fallo,
  type Intervalo,
  type ParNegativas,
  type Registro,
  type RegistroGsm8k,
} from "@/lib/banco-publico/extraer";
import { rutaServida } from "@/lib/banco-publico/publicar";
import type { PalancaTtl } from "@/lib/portada/palanca-ttl";

/**
 * EL BANCO PÚBLICO — la página /benchmarks, sin datos propios.
 *
 * Todo número sale de `banco` (lib/banco-publico/extraer.ts, que lee los
 * informes de docs/benchmarks) y todo texto de `benchmarksPage.*`. El
 * componente es puro: recibe el traductor, así que el test lo renderiza en los
 * 12 idiomas sin servidor y compara cada cifra con su informe.
 *
 * Reglas de la copia (decisión del dueño): ningún competidor por su nombre,
 * ningún «hasta X %», y toda cifra con su n, su intervalo y su fecha.
 */

type Rico = (chunks: ReactNode) => ReactNode;
export interface Traductor {
  (clave: string, valores?: Record<string, string | number>): string;
  rich: (clave: string, valores?: Record<string, string | number | Rico>) => ReactNode;
}

/** Contacto para una medición independiente. */
export const CONTACTO = "support@bivelio.com";
/** Umbral con el que la página llama «significativa» una diferencia de negativas A/B. */
export const UMBRAL_P = 0.05;

/** Pasos del método en «cómo reproducirlo» (el texto, en `repro.steps.<n>`). */
export const PASOS_REPRO = ["dataset", "package", "arms", "cost", "compare"] as const;

/** Los límites del banco de TTL que la sección dice con todas sus letras (`gatewayTtl.limits.<k>`). */
export const LIMITES_TTL = ["oneOrg", "listPrice", "cacheModel", "rebuilt", "ceiling", "gap", "promise"] as const;

const CLASE_ESTADO: Record<Registro["estado"], string> = {
  medido: "banco-estado banco-medido",
  "no-medible": "banco-estado banco-no-medible",
  "capa-falla": "banco-estado banco-capa-falla",
};

const NOMBRE_BATERIA: Record<Bateria, string> = { gsm8k: "GSM8K", bfcl: "BFCL", xstest: "XSTest", "mt-bench": "MT-Bench" };

function formatos(locale: string) {
  const pct = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pctRedondo = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const pp = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const usd2 = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct2 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
  const ent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const p = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const lista = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  return {
    /** Una lista de nombres («a, b y c»), en el idioma de la página. */
    lista: (xs: readonly string[]) => lista.format(xs),
    pct: (x: number) => pct.format(x),
    /** Porcentajes de diseño (nivel de confianza, fracciones del flujo): sin decimales. */
    pctRedondo: (x: number) => pctRedondo.format(x),
    /** Diferencia en puntos porcentuales, con signo. */
    pp: (x: number) => pp.format(x * 100),
    usd: (x: number) => usd.format(x),
    /** Gasto de una tirada: céntimos. */
    usd2: (x: number) => usd2.format(x),
    /** Desvío relativo pequeño (informe frente a factura), con signo. */
    pct2: (x: number) => pct2.format(Math.abs(x) < 5e-5 ? 0 : x),
    ent: (x: number) => ent.format(x),
    p: (x: number) => p.format(x),
    fecha: (iso: string) => (iso ? fecha.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—"),
    iv: (x: Intervalo) => `${pct.format(x.punto)} [${pct.format(x.inf)} – ${pct.format(x.sup)}]`,
  };
}

type F = ReturnType<typeof formatos>;

/**
 * Enlace a un informe: la copia servida por esta web (/benchmarks/data/…), no
 * el repositorio, que es privado (decisión del dueño, 2026-09-29).
 */
const enlace = (ruta: string) => rutaServida(ruta);

function Tirada({ r, f }: { r: Pick<Registro, "version" | "fecha" | "ruta">; f: F }) {
  return (
    <a className="banco-tirada" href={enlace(r.ruta)} target="_blank" rel="noopener" data-ruta={enlace(r.ruta)}>
      {r.version} · {f.fecha(r.fecha)}
    </a>
  );
}

function motivoTexto(r: Registro, t: Traductor): string {
  return t(`status.reason.${r.motivo ?? "otro"}`);
}

function veredicto(x: Intervalo): "ahorro" | "cero" | "sobrecoste" {
  if (x.inf > 0) return "ahorro";
  if (x.sup < 0) return "sobrecoste";
  return "cero";
}

function claseMtBench(clase: string | undefined, ahorro: Intervalo): "ahorro" | "cero" | "sobrecoste" {
  if (clase === "ahorro") return "ahorro";
  if (clase === "sobrecoste") return "sobrecoste";
  if (clase) return "cero";
  return veredicto(ahorro);
}

// ---------------------------------------------------------------------------

function Estadisticas({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const medidos = new Set(banco.registros.filter((r) => r.estado === "medido").map((r) => r.modelo)).size;
  const baterias = new Set(banco.fuentes.map((x) => x.bateria)).size;
  const items: [string, string][] = [
    [f.ent(baterias), t("stats.batteries")],
    [f.ent(banco.modelos.length), t("stats.models")],
    [f.ent(medidos), t("stats.measured")],
    [f.ent(banco.fuentes.length), t("stats.reports")],
    [f.fecha(banco.ultimaFecha), t("stats.last")],
  ];
  return (
    <dl className="banco-stats">
      {items.map(([v, k]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Metodo({ banco, t, f, ricos }: { banco: Banco; t: Traductor; f: F; ricos: Record<string, Rico> }) {
  const versiones = Object.keys(banco.distPorVersion).sort();
  const ultima = versiones[versiones.length - 1];
  return (
    <section className="terms-sec" aria-labelledby="method-h" id="method">
      <h2 id="method-h">{t("method.title")}</h2>
      <ul className="terms-list">
        <li>{t.rich("method.arms", ricos)}</li>
        <li>{t.rich("method.cost", ricos)}</li>
        <li>{t.rich("method.intervals", { ...ricos, nivel: f.pctRedondo(0.95) })}</li>
        {ultima && <li>{t.rich("method.package", { ...ricos, version: ultima, sha: banco.distPorVersion[ultima]! })}</li>}
        <li>{t.rich("method.guard", ricos)}</li>
      </ul>
      <h3>{t("method.batteriesTitle")}</h3>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.battery")}</th>
              <th scope="col">{t("th.what")}</th>
              <th scope="col">{t("th.dataset")}</th>
              <th scope="col">{t("th.pinned")}</th>
              <th scope="col">{t("th.license")}</th>
            </tr>
          </thead>
          <tbody>
            {banco.datasets.map((d) => (
              <tr key={d.bateria} data-bateria={d.bateria}>
                <td>
                  <b>{NOMBRE_BATERIA[d.bateria]}</b>
                </td>
                <td className="banco-texto">{t(`batteries.${d.bateria}`)}</td>
                <td className="banco-hash">
                  <code>{d.repo}</code>
                  <span>
                    commit <code data-commit={d.commit}>{d.commit}</code>
                  </span>
                </td>
                <td className="banco-hash">
                  {d.ficheros.length
                    ? d.ficheros.map((x) => (
                        <span key={x.nombre}>
                          {x.nombre}
                          <br />
                          sha256 <code data-sha256={x.sha256}>{x.sha256}</code>
                        </span>
                      ))
                    : t("method.commitOnly")}
                </td>
                <td>{d.licencia}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ahorro({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const filas = banco.registros.filter((r): r is RegistroGsm8k => r.bateria === "gsm8k");
  return (
    <section className="terms-sec" aria-labelledby="savings-h" id="savings">
      <h2 id="savings-h">{t("savings.title")}</h2>
      {banco.flujoGsm8k && (
        <p>{t("savings.intro", { rep: f.pctRedondo(banco.flujoGsm8k.repeticiones), par: f.pctRedondo(banco.flujoGsm8k.parafrasis) })}</p>
      )}
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.model")}</th>
              <th scope="col">{t("th.n")}</th>
              <th scope="col">{t("th.savings")}</th>
              <th scope="col">{t("th.fromExact")}</th>
              <th scope="col">{t("th.fromCalls")}</th>
              <th scope="col">{t("th.accuracy")}</th>
              <th scope="col">{t("th.run")}</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((r) => (
              <tr key={r.modelo} data-modelo={r.modelo} data-bateria="gsm8k">
                <td>
                  <code>{r.modelo}</code>
                </td>
                {r.estado === "medido" && r.ahorro ? (
                  <>
                    <td>{t("savings.nCell", { n: f.ent(r.n), unicos: f.ent(r.unicos ?? 0) })}</td>
                    <td className="banco-cifra" data-ahorro={r.ahorro.punto}>
                      {f.iv(r.ahorro)}
                    </td>
                    <td>{r.origenCacheCapaUsd !== undefined ? f.usd(r.origenCacheCapaUsd) : "—"}</td>
                    <td>{r.origenLlamadasUsd !== undefined ? f.usd(r.origenLlamadasUsd) : "—"}</td>
                    <td>
                      {r.exactitudA && r.exactitudB
                        ? `${f.pct(r.exactitudA.aciertos / r.exactitudA.n)} → ${f.pct(r.exactitudB.aciertos / r.exactitudB.n)}`
                        : "—"}
                      {r.difExactitud && (
                        <span className="banco-sub banco-delta">
                          {t("savings.delta", { d: f.pp(r.difExactitud.punto), inf: f.pp(r.difExactitud.inf), sup: f.pp(r.difExactitud.sup) })}
                        </span>
                      )}
                    </td>
                  </>
                ) : (
                  <td colSpan={5} className="banco-nomedido">
                    {t(r.estado === "capa-falla" ? "status.layerFailed" : "status.notMeasured", { motivo: motivoTexto(r, t) })}
                  </td>
                )}
                <td>
                  <Tirada r={r} f={f} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("savings.originNote")}</p>
      <p className="banco-nota">{t("savings.accuracyNote")}</p>
    </section>
  );
}

/**
 * LA REBAJA DE CACHÉ DEL GATEWAY — el informe del banco de TTL, en su sección.
 *
 * No es una batería A/B y no sale de `banco`: es un REPLAY a precio de lista
 * sobre sesiones de una sola organización (la nuestra), y la sección lo dice
 * antes que la cifra. Los números llegan de lib/portada/palanca-ttl.ts, que
 * tiene su verja contra el informe; los textos, de `gatewayTtl.*`, sin dígitos.
 * La tarjeta del gateway de la portada enlaza aquí (#gateway-ttl).
 *
 * Sin enlaces: el informe no se sirve (lleva comandos, rutas y el contraste con
 * producción), así que aquí va lo publicable, contado entero. Y sin más dólares
 * que los del veredicto: el bruto y el coste de los fallos, sobre la factura.
 */
function PalancaDeTtl({ p, t, f, ricos }: { p: PalancaTtl; t: Traductor; f: F; ricos: Record<string, Rico> }) {
  const rango = (x: { lower: number; upper: number }) => `${f.pct2(x.lower)} – ${f.pct2(x.upper)}`;
  const muestra: [string, string][] = [
    [f.ent(p.sesiones), t("gatewayTtl.stat.sessions")],
    [f.ent(p.peticiones), t("gatewayTtl.stat.requests")],
    [f.ent(p.dias), t("gatewayTtl.stat.days")],
  ];
  const resultado: [string, string, string][] = [
    ["rebajas", t("gatewayTtl.row.downgrades"), f.ent(p.rebajas)],
    ["bruto", t("gatewayTtl.row.gross"), f.pct2(p.brutoUsd / p.facturaUsd)],
    ["fallos", t("gatewayTtl.row.misses"), f.ent(p.fallos)],
    ["coste-fallos", t("gatewayTtl.row.missCost"), f.pct2(-p.costeFallosUsd / p.facturaUsd)],
    ["neto", t("gatewayTtl.row.net"), `${f.pct2(p.neto.point)} · ${f.usd2(p.netoUsd)}`],
    ["techo", t("gatewayTtl.row.ceiling"), f.pct(p.techo)],
  ];
  return (
    <section className="terms-sec" aria-labelledby="gateway-ttl-h" id="gateway-ttl" data-informe={p.fecha}>
      <h2 id="gateway-ttl-h">{t("gatewayTtl.title")}</h2>
      <p>{t.rich("gatewayTtl.kind", ricos)}</p>
      <p>
        {t.rich("gatewayTtl.verdict", {
          ...ricos,
          fecha: f.fecha(p.fecha),
          neto: f.pct2(p.neto.point),
          netoUsd: f.usd2(p.netoUsd),
          factura: f.usd2(p.facturaUsd),
        })}
      </p>
      <dl className="banco-stats">
        {muestra.map(([v, k]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("gatewayTtl.thInterval", { confianza: f.pctRedondo(p.confianza) })}</th>
              <th scope="col">{t("gatewayTtl.thNet")}</th>
            </tr>
          </thead>
          <tbody>
            <tr data-ttl-ic="sesion">
              <td>{t("gatewayTtl.bySession", { n: f.ent(p.sesiones) })}</td>
              <td className="banco-cifra">{rango(p.neto)}</td>
            </tr>
            <tr data-ttl-ic="dia">
              <td>{t("gatewayTtl.byDay", { n: f.ent(p.dias) })}</td>
              <td className="banco-cifra">{rango(p.netoPorDia)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("gatewayTtl.intervalsNote", { remuestreos: f.ent(p.remuestreos) })}</p>

      <h3>{t("gatewayTtl.resultTitle")}</h3>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <tbody>
            {resultado.map(([clave, etiqueta, valor]) => (
              <tr key={clave} data-ttl-fila={clave}>
                <td>{etiqueta}</td>
                <td className="banco-cifra">{valor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("gatewayTtl.resultNote", { factura: f.usd2(p.facturaUsd) })}</p>

      <h3>{t("gatewayTtl.modelsTitle")}</h3>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.model")}</th>
              <th scope="col">{t("gatewayTtl.stat.requests")}</th>
              <th scope="col">{t("gatewayTtl.row.downgrades")}</th>
              <th scope="col">{t("gatewayTtl.row.misses")}</th>
              <th scope="col">{t("gatewayTtl.thModelNet")}</th>
            </tr>
          </thead>
          <tbody>
            {p.porModelo.map((m) => (
              <tr key={m.modelo} data-ttl-modelo={m.modelo}>
                <td>
                  <code>{m.modelo}</code>
                </td>
                <td>{f.ent(m.peticiones)}</td>
                <td>{f.ent(m.rebajas)}</td>
                <td>{f.ent(m.fallos)}</td>
                <td className="banco-cifra">
                  {m.neto === null ? (
                    <span className="banco-sub">{t("gatewayTtl.tooFew", { n: f.ent(m.peticiones) })}</span>
                  ) : (
                    f.pct2(m.neto)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {t.rich("gatewayTtl.ugly", {
          ...ricos,
          modelo: p.casoFeo.modelo,
          rebajas: f.pctRedondo(p.casoFeo.cuotaRebajas),
          fallos: f.pctRedondo(p.casoFeo.cuotaFallos),
          // En valor absoluto y con el decimal del informe: el texto ya dice «perdió».
          perdida: f.pct(Math.abs(p.casoFeo.netoPrimerPeriodo)),
        })}
      </p>

      <h3>{t("gatewayTtl.howTitle")}</h3>
      <ul className="terms-list">
        <li>{t("gatewayTtl.how.rule", { umbral: f.pctRedondo(p.umbralNuevo) })}</li>
        <li>{t("gatewayTtl.how.baseline")}</li>
        <li>{t("gatewayTtl.how.miss")}</li>
        <li>
          {t("gatewayTtl.how.conservative", { neto: f.pct2(p.conservadora.neto), fallos: f.ent(p.conservadora.fallosDeMas) })}
        </li>
        <li>{t("gatewayTtl.how.aggregates")}</li>
      </ul>

      <h3>{t("gatewayTtl.limitsTitle")}</h3>
      <ul className="terms-list">
        {LIMITES_TTL.map((k) => (
          <li key={k} data-ttl-limite={k}>
            {t.rich(`gatewayTtl.limits.${k}`, {
              ...ricos,
              // Solo los usan «rebuilt» y «ceiling»; a los demás les sobran.
              cuota: f.pctRedondo(p.reconstruidas.peticiones / p.peticiones),
              bajo: f.pct2(p.primerPeriodo.lower),
              alto: f.pct2(p.primerPeriodo.upper),
              sinMarca: f.ent(p.sinMarcaDeHora),
              peticiones: f.ent(p.peticiones),
            })}
          </li>
        ))}
      </ul>
      <p className="banco-nota">
        {t("gatewayTtl.production", { version: p.netoEnProduccionDesde, fecha: f.fecha(p.netoEnProduccionFecha) })}
      </p>
    </section>
  );
}

function Negativa({ par, f }: { par?: ParNegativas; f: F }) {
  if (!par) return <>—</>;
  return (
    <>
      {f.pct(par.A.tasa)} → {f.pct(par.B.tasa)} <span className="banco-sub">(n = {f.ent(par.A.pares)}, p = {f.p(par.p)})</span>
    </>
  );
}

function Garantias({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const g = banco.garantias;
  const neg = g.negativas.modelos;
  const significativas = neg.filter((m) => [m.seguros, m.inseguros].some((x) => x && x.p < UMBRAL_P)).length;
  const sinRed = g.otraPregunta.sinRed;
  const otraOk = g.otraPregunta.deOtra === 0 && (!sinRed || sinRed.erroneas === 0);
  return (
    <section className="terms-sec" aria-labelledby="guarantees-h" id="guarantees">
      <h2 id="guarantees-h">{t("guarantees.title")}</h2>
      <div className="terms-groups banco-garantias">
        <div className="terms-group" data-garantia="herramientas" data-ok={g.herramientas.alteradas === 0}>
          <h3>
            {g.herramientas.alteradas === 0
              ? t("guarantees.tools.title")
              : t("guarantees.tools.titleBroken", { n: f.ent(g.herramientas.alteradas) })}
          </h3>
          <p>
            {t("guarantees.tools.body", {
              alteradas: f.ent(g.herramientas.alteradas),
              comparaciones: f.ent(g.herramientas.comparaciones),
              modelos: f.ent(g.herramientas.modelos),
              desde: g.herramientas.desde,
            })}
          </p>
          <p className="banco-nota">{t("guarantees.tools.note")}</p>
        </div>
        <div className="terms-group" data-garantia="otra-pregunta" data-ok={otraOk}>
          <h3>
            {otraOk
              ? t("guarantees.other.title", { desde: g.otraPregunta.desde })
              : t("guarantees.other.titleBroken", { n: f.ent(g.otraPregunta.deOtra + (sinRed?.erroneas ?? 0)), desde: g.otraPregunta.desde })}
          </h3>
          <p>
            {t("guarantees.other.body", {
              deOtra: f.ent(g.otraPregunta.deOtra),
              variantes: f.ent(g.otraPregunta.variantes),
              modelos: f.ent(g.otraPregunta.modelos),
            })}
          </p>
          {sinRed && (
            <p>
              {t("guarantees.other.replay", {
                erroneas: f.ent(sinRed.erroneas),
                peticiones: f.ent(sinRed.peticiones),
                configs: f.ent(sinRed.configuraciones),
              })}
            </p>
          )}
        </div>
        <div className="terms-group" data-garantia="negativas" data-ok={significativas === 0}>
          <h3>
            {significativas === 0
              ? t("guarantees.refusals.title")
              : t("guarantees.refusals.titleBroken", { n: f.ent(significativas) })}
          </h3>
          <p>
            {t("guarantees.refusals.body", {
              modelos: f.ent(neg.length),
              umbral: f.p(UMBRAL_P),
              comprobados: f.ent(g.negativas.textoComprobado),
              alterados: f.ent(g.negativas.textoAlterado),
            })}
          </p>
          <p className="banco-nota">{t("guarantees.refusals.note")}</p>
        </div>
      </div>
      {neg.length > 0 && (
        <div className="tbl-scroll">
          <table className="tbl banco-tbl">
            <caption>{t("guarantees.refusals.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("th.model")}</th>
                <th scope="col">{t("th.prompts")}</th>
                <th scope="col">{t("th.safe")}</th>
                <th scope="col">{t("th.unsafe")}</th>
                <th scope="col">{t("th.run")}</th>
              </tr>
            </thead>
            <tbody>
              {neg.map((m) => (
                <tr key={m.modelo} data-modelo={m.modelo} data-bateria="xstest">
                  <td>
                    <code>{m.modelo}</code>
                  </td>
                  <td>{f.ent(m.n)}</td>
                  <td>
                    <Negativa par={m.seguros} f={f} />
                  </td>
                  <td>
                    <Negativa par={m.inseguros} f={f} />
                  </td>
                  <td>
                    <Tirada r={m} f={f} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NoAhorra({ banco, t, f, ricos }: { banco: Banco; t: Traductor; f: F; ricos: Record<string, Rico> }) {
  const filas = banco.registros.filter(
    (r): r is Extract<Registro, { bateria: "mt-bench" | "bfcl" }> => (r.bateria === "mt-bench" || r.bateria === "bfcl") && r.estado === "medido" && !!r.ahorro,
  );
  return (
    <section className="terms-sec" aria-labelledby="nosavings-h" id="no-savings">
      <h2 id="nosavings-h">{t("noSavings.title")}</h2>
      <p className="terms-governs">{t.rich("noSavings.lead", { ...ricos, cero: f.pctRedondo(0) })}</p>
      <p>{t("noSavings.why")}</p>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.battery")}</th>
              <th scope="col">{t("th.model")}</th>
              <th scope="col">{t("th.n")}</th>
              <th scope="col">{t("th.savings")}</th>
              <th scope="col">{t("th.verdict")}</th>
              <th scope="col">{t("th.run")}</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((r) => {
              const v = r.bateria === "mt-bench" ? claseMtBench(r.clase, r.ahorro!) : veredicto(r.ahorro!);
              const noAtribuible = r.bateria === "mt-bench" && r.atribuible === false;
              return (
                <tr key={`${r.bateria}-${r.modelo}`} data-modelo={r.modelo} data-bateria={r.bateria}>
                  <td>{NOMBRE_BATERIA[r.bateria]}</td>
                  <td>
                    <code>{r.modelo}</code>
                  </td>
                  <td>{t(r.bateria === "mt-bench" ? "noSavings.nQuestions" : "noSavings.nItems", { n: f.ent(r.n) })}</td>
                  <td className="banco-cifra" data-ahorro={r.ahorro!.punto}>
                    {f.iv(r.ahorro!)}
                  </td>
                  <td>
                    {t(`noSavings.verdict.${v}`)}
                    {noAtribuible && <span className="banco-sub"> · {t("noSavings.notAttributable")}</span>}
                  </td>
                  <td>
                    <Tirada r={r} f={f} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EstadoPorModelo({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const celda = new Map(banco.registros.map((r) => [`${r.bateria}|${r.modelo}`, r]));
  const baterias = BATERIAS.filter((b) => banco.registros.some((r) => r.bateria === b));
  return (
    <section className="terms-sec" aria-labelledby="status-h" id="status">
      <h2 id="status-h">{t("status.title")}</h2>
      <p>{t("status.intro")}</p>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl banco-matriz">
          <thead>
            <tr>
              <th scope="col">{t("th.model")}</th>
              {baterias.map((b) => (
                <th scope="col" key={b}>
                  {NOMBRE_BATERIA[b]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {banco.modelos.map((m) => (
              <tr key={m} data-modelo={m}>
                <td>
                  <code>{m}</code>
                </td>
                {baterias.map((b) => {
                  const r = celda.get(`${b}|${m}`);
                  if (!r) return <td key={b}>—</td>;
                  return (
                    <td key={b} className={CLASE_ESTADO[r.estado]} data-bateria={b}>
                      {r.estado === "medido"
                        ? t("status.measured", { n: f.ent(r.n) })
                        : t(r.estado === "capa-falla" ? "status.layerFailed" : "status.notMeasured", { motivo: motivoTexto(r, t) })}
                      <br />
                      <Tirada r={r} f={f} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InformeEnlace({ ruta }: { ruta: string }) {
  return (
    <a className="banco-tirada" href={enlace(ruta)} target="_blank" rel="noopener" data-ruta={enlace(ruta)}>
      {ruta.split("/").pop()}
    </a>
  );
}

function evidencia(e: EvidenciaSemanal, f: F): Record<string, string> {
  return {
    fecha: f.fecha(e.fecha),
    commit: e.commit,
    cacheadas: f.ent(e.cacheadas),
    acreditadas: f.ent(e.acreditadas),
    sobre: f.ent(e.sobre),
    modelos: f.ent(e.modelos),
  };
}

/** Lo que una tirada semanal contó de un fallo de Gemini, en los modelos que midió. */
function cuentaFamilia(e: EvidenciaFamilia, t: Traductor, f: F): Record<string, string> {
  return {
    fecha: f.fecha(e.fecha),
    commit: e.commit,
    medidos: f.lista(e.medidos),
    cuenta: t(e.tipo === "negativas" ? "bugs.counter.refusals" : "bugs.counter.layerFails", {
      ocurrencias: f.ent(e.ocurrencias),
      sobre: f.ent(e.sobre),
      bateria: NOMBRE_BATERIA[e.bateria],
    }),
  };
}

/** Los modelos de la familia que esa tirada no pudo medir, agrupados por motivo. */
function SinMedirFamilia({ sinMedir, t, f }: { sinMedir: EvidenciaFamilia["sinMedir"]; t: Traductor; f: F }) {
  if (!sinMedir.length) return null;
  const porMotivo = new Map<string, string[]>();
  for (const x of sinMedir) {
    const k = x.motivo ?? "otro";
    porMotivo.set(k, [...(porMotivo.get(k) ?? []), x.modelo]);
  }
  return (
    <>
      {[...porMotivo].map(([motivo, modelos]) => (
        <span key={motivo} data-sin-medir={motivo}>
          {" "}
          {t("bugs.notMeasuredInRun", { modelos: f.lista(modelos), motivo: t(`weekly.reason.${motivo}`) })}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// el banco semanal en vivo

function estadoCelda(c: CeldaSemanal, t: Traductor): string {
  if (c.estado === "medida") return t(c.cortadaPorTope ? "weekly.status.cut" : "weekly.status.measured");
  const motivo = t(`weekly.reason.${c.motivo ?? "otro"}`);
  if (c.estado === "sin-soporte") return t("weekly.status.unsupported", { motivo });
  if (c.estado === "arnes-falla") return t("weekly.status.harnessFailed", { motivo });
  return t("weekly.status.notMeasurable", { motivo });
}

const CLASE_SEMANAL: Record<CeldaSemanal["estado"], string> = {
  medida: "banco-estado banco-medido",
  "no-medible": "banco-estado banco-no-medible",
  "sin-soporte": "banco-estado banco-no-medible",
  "arnes-falla": "banco-estado banco-capa-falla",
};

function Recuentos({ c, t, f }: { c: CeldaSemanal; t: Traductor; f: F }) {
  const partes: string[] = [];
  if (c.respuestasDeOtraPregunta !== undefined) partes.push(t("weekly.counts.otherQuestion", { n: f.ent(c.respuestasDeOtraPregunta) }));
  if (c.llamadasCambiadas !== undefined) partes.push(t("weekly.counts.changedCalls", { n: f.ent(c.llamadasCambiadas) }));
  if (c.negativasCacheadas !== undefined || c.negativasAcreditadas !== undefined) {
    partes.push(t("weekly.counts.refusals", { cacheadas: f.ent(c.negativasCacheadas ?? 0), acreditadas: f.ent(c.negativasAcreditadas ?? 0) }));
  }
  return <>{partes.length ? partes.join(" · ") : "—"}</>;
}

function Diferencia({ c, t, f }: { c: CeldaSemanal; t: Traductor; f: F }) {
  const d = c.diferencia;
  if (!d) return <>—</>;
  if (d.tipo === "exactitud") {
    return <>{d.ic95 ? t("weekly.diff.accuracy", { d: f.pp(d.valor), inf: f.pp(d.ic95.inf), sup: f.pp(d.ic95.sup) }) : t("weekly.diff.accuracyNoCi", { d: f.pp(d.valor) })}</>;
  }
  if (d.tipo === "victoria") {
    return <>{d.ic95 ? t("weekly.diff.win", { w: f.pct(d.valor), inf: f.pct(d.ic95.inf), sup: f.pct(d.ic95.sup) }) : t("weekly.diff.winNoCi", { w: f.pct(d.valor) })}</>;
  }
  const lado = (clave: string, x?: { valor: number; p?: number }) =>
    x ? t(clave, { d: f.pp(x.valor), p: x.p !== undefined ? f.p(x.p) : "—" }) : null;
  return (
    <>
      {[lado("weekly.diff.safe", d.seguros), lado("weekly.diff.unsafe", d.inseguros)].filter(Boolean).map((s, i) => (
        <span key={i} className="banco-delta">
          {s}
        </span>
      ))}
    </>
  );
}

function Semanal({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const s = banco.semanales[0]!;
  const medidas = s.celdas.filter((c) => c.estado === "medida").length;
  const anteriores = banco.semanales.slice(1);
  return (
    <section className="terms-sec" aria-labelledby="weekly-h" id="weekly" data-run={s.runId}>
      <h2 id="weekly-h">{t("weekly.title")}</h2>
      <p>{t("weekly.intro")}</p>
      <p className="terms-governs">
        {t("weekly.meta", {
          fecha: f.fecha(s.fecha),
          commit: s.commit,
          version: s.version,
          gasto: f.usd2(s.gastoUsd),
          tope: s.topeUsd !== undefined ? f.usd2(s.topeUsd) : "—",
          medidas: f.ent(medidas),
          celdas: f.ent(s.celdas.length),
        })}{" "}
        <InformeEnlace ruta={s.ruta} />
      </p>
      <p data-ok={s.ok} className="banco-veredicto">
        {s.ok ? t("weekly.verdictOk") : t("weekly.verdictFailed", { n: f.ent(s.infracciones) })}
      </p>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl banco-semanal">
          <thead>
            <tr>
              <th scope="col">{t("th.battery")}</th>
              <th scope="col">{t("th.model")}</th>
              <th scope="col">{t("th.status")}</th>
              <th scope="col">{t("th.n")}</th>
              <th scope="col">{t("th.spend")}</th>
              <th scope="col">{t("th.layerFails")}</th>
              <th scope="col">{t("th.counts")}</th>
              <th scope="col">{t("th.diff")}</th>
              <th scope="col">{t("th.reportVsInvoice")}</th>
            </tr>
          </thead>
          <tbody>
            {s.celdas.map((c) => (
              <tr key={`${c.bateria}-${c.modelo}`} data-modelo={c.modelo} data-bateria={c.bateria} data-estado={c.estado}>
                <td>{NOMBRE_BATERIA[c.bateria] ?? c.bateria}</td>
                <td>
                  <code>{c.modelo}</code>
                </td>
                <td className={CLASE_SEMANAL[c.estado]}>{estadoCelda(c, t)}</td>
                {c.estado === "medida" ? (
                  <>
                    <td>{f.ent(c.n)}</td>
                    <td>{c.gastoUsd !== undefined ? `${f.usd2(c.gastoUsd)}${c.topeUsd !== undefined ? ` / ${f.usd2(c.topeUsd)}` : ""}` : "—"}</td>
                    <td>{c.fallosDeLaCapa !== undefined ? f.ent(c.fallosDeLaCapa) : "—"}</td>
                    <td>
                      <Recuentos c={c} t={t} f={f} />
                    </td>
                    <td>
                      <Diferencia c={c} t={t} f={f} />
                    </td>
                    <td>{c.informeVsFactura !== undefined ? f.pct2(c.informeVsFactura) : "—"}</td>
                  </>
                ) : (
                  <td colSpan={6}>—</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("weekly.note")}</p>
      {anteriores.length > 0 && (
        <>
          <h3>{t("weekly.earlierTitle")}</h3>
          <ul className="terms-list">
            {anteriores.map((x) => (
              <li key={x.ruta} data-run={x.runId}>
                {t(x.ok ? "weekly.earlierOk" : "weekly.earlierFailed", { fecha: f.fecha(x.fecha), commit: x.commit, n: f.ent(x.infracciones) })}{" "}
                <InformeEnlace ruta={x.ruta} />
              </li>
            ))}
          </ul>
        </>
      )}
      {banco.parciales.length > 0 && (
        <>
          <h3>{t("weekly.partialTitle")}</h3>
          <p>{t("weekly.partialIntro")}</p>
          <ul className="terms-list">
            {banco.parciales.map((x) => (
              <li key={x.ruta} data-run={x.runId} data-parcial={x.parcial!.modelos.join(",")}>
                {t(x.ok ? "weekly.partialOk" : "weekly.partialFailed", {
                  fecha: f.fecha(x.fecha),
                  commit: x.commit,
                  modelos: x.parcial!.modelos.join(", "),
                  baterias: x.parcial!.baterias.map((b) => NOMBRE_BATERIA[b] ?? b).join(", "),
                  n: f.ent(x.infracciones),
                })}{" "}
                <InformeEnlace ruta={x.ruta} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Fallos({ banco, t, f }: { banco: Banco; t: Traductor; f: F }) {
  const prs = (x: Fallo) => x.prs.map((n) => `#${n}`).join(", ");
  return (
    <section className="terms-sec" aria-labelledby="bugs-h" id="bugs">
      <h2 id="bugs-h">{t("bugs.title")}</h2>
      <p>{t("bugs.intro")}</p>
      <ol className="banco-fallos">
        {banco.fallos.map((x) => (
          <li key={x.id} data-fallo={x.id}>
            <h3>
              {t(`bugs.items.${x.id}.title`)} <span className="banco-version">{`${x.encontradoEn} → ${x.arregladoEn}`}</span>
            </h3>
            <p>{t(`bugs.items.${x.id}.body`)}</p>
            <ul className="terms-list">
              {x.antes.ocurrencias > 0 && (
                <li>
                  {t("bugs.found", { version: x.encontradoEn, ocurrencias: f.ent(x.antes.ocurrencias), sobre: f.ent(x.antes.sobre) })}{" "}
                  {x.antes.rutas.map((r) => (
                    <InformeEnlace key={r} ruta={r} />
                  ))}
                </li>
              )}
              {x.antesSemanal && (
                <li>
                  {t("bugs.foundWeekly", evidencia(x.antesSemanal, f))} <InformeEnlace ruta={x.antesSemanal.ruta} />
                </li>
              )}
              {x.antesFamilia && (
                <li>
                  {t("bugs.foundWeeklyModels", cuentaFamilia(x.antesFamilia, t, f))} <InformeEnlace ruta={x.antesFamilia.ruta} />
                </li>
              )}
              <li>{t("bugs.fixed", { version: x.arregladoEn, prs: prs(x) })}</li>
              {x.despues && (
                <li>
                  {t(x.despues.ocurrencias === 0 ? "bugs.verified" : "bugs.stillSeen", {
                    version: x.despues.version,
                    ocurrencias: f.ent(x.despues.ocurrencias),
                    sobre: f.ent(x.despues.sobre),
                  })}
                </li>
              )}
              {x.despuesSemanal && (
                <li data-semanal={x.despuesSemanal.cacheadas + x.despuesSemanal.acreditadas === 0 ? "re-medido" : "aun-visto"}>
                  {t(
                    x.despuesSemanal.cacheadas + x.despuesSemanal.acreditadas === 0 ? "bugs.remeasuredWeekly" : "bugs.stillSeenWeekly",
                    evidencia(x.despuesSemanal, f),
                  )}{" "}
                  <InformeEnlace ruta={x.despuesSemanal.ruta} />
                </li>
              )}
              {x.despuesFamilia && (
                <li data-semanal={x.despuesFamilia.ocurrencias === 0 ? "re-medido" : "aun-visto"}>
                  {t(x.despuesFamilia.ocurrencias === 0 ? "bugs.remeasuredWeeklyModels" : "bugs.stillSeenWeeklyModels", cuentaFamilia(x.despuesFamilia, t, f))}
                  <SinMedirFamilia sinMedir={x.despuesFamilia.sinMedir} t={t} f={f} /> <InformeEnlace ruta={x.despuesFamilia.ruta} />
                </li>
              )}
              {x.sinContarSemanal && (
                <li data-semanal="sin-contar">
                  {t("bugs.notCountedWeekly", {
                    fecha: f.fecha(x.sinContarSemanal.fecha),
                    commit: x.sinContarSemanal.commit,
                    medidos: f.lista(x.sinContarSemanal.medidos),
                  })}
                  <SinMedirFamilia sinMedir={x.sinContarSemanal.sinMedir} t={t} f={f} /> <InformeEnlace ruta={x.sinContarSemanal.ruta} />
                </li>
              )}
              {!x.despues && !x.despuesSemanal && !x.despuesFamilia && !x.sinContarSemanal && (
                <li data-semanal={x.sinMedirSemanal ? "sin-medir" : undefined}>
                  {x.sinMedirSemanal ? (
                    <>
                      {t(`bugs.notRemeasured.${x.sinMedirSemanal.estado === "sin-soporte" ? "unsupported" : "notMeasurable"}`, {
                        fecha: f.fecha(x.sinMedirSemanal.fecha),
                        commit: x.sinMedirSemanal.commit,
                        motivo: t(`weekly.reason.${x.sinMedirSemanal.motivo ?? "otro"}`),
                      })}{" "}
                      <InformeEnlace ruta={x.sinMedirSemanal.ruta} />
                    </>
                  ) : (
                    t("bugs.pending", { version: x.arregladoEn })
                  )}
                </li>
              )}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Reproducir({ banco, t, ricos }: { banco: Banco; t: Traductor; ricos: Record<string, Rico> }) {
  const baterias = BATERIAS.filter((b) => banco.fuentes.some((x) => x.bateria === b));
  return (
    <section className="terms-sec" aria-labelledby="repro-h" id="reproduce">
      <h2 id="repro-h">{t("repro.title")}</h2>
      <p>{t.rich("repro.intro", ricos)}</p>
      <ol className="terms-list banco-pasos">
        {PASOS_REPRO.map((p) => (
          <li key={p}>{t.rich(`repro.steps.${p}`, ricos)}</li>
        ))}
      </ol>
      <h3>{t("repro.reportsTitle")}</h3>
      <p>{t("repro.reportsIntro")}</p>
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.battery")}</th>
              <th scope="col">{t("th.reports")}</th>
            </tr>
          </thead>
          <tbody>
            {baterias.map((b) => (
              <tr key={b} data-bateria={b}>
                <td>{NOMBRE_BATERIA[b]}</td>
                <td className="banco-informes">
                  {banco.fuentes
                    .filter((x) => x.bateria === b)
                    .map((x) => (
                      <a key={x.ruta} href={enlace(x.ruta)} target="_blank" rel="noopener" data-ruta={enlace(x.ruta)}>
                        {x.ruta.split("/").slice(-2).join("/")}
                      </a>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("repro.served")}</p>
    </section>
  );
}

export function BancoPublico({
  banco,
  t,
  locale,
  palancaTtl,
}: {
  banco: Banco;
  t: Traductor;
  locale: string;
  /** El informe del banco de TTL (lib/portada/palanca-ttl.ts). Sin él, la sección no sale. */
  palancaTtl?: PalancaTtl;
}) {
  const f = formatos(locale);
  const ricos: Record<string, Rico> = { b: (c) => <b>{c}</b>, code: (c) => <code>{c}</code> };
  return (
    <main className="wrap banco-page">
      <section className="terms-hero">
        <span className="eyebrow">{t("eyebrow")}</span>
        <h1>{t("title")}</h1>
        <p className="lede">{t("lede", { modelos: f.ent(banco.modelos.length) })}</p>
        <Estadisticas banco={banco} t={t} f={f} />
      </section>
      <Metodo banco={banco} t={t} f={f} ricos={ricos} />
      {banco.semanales.length > 0 && <Semanal banco={banco} t={t} f={f} />}
      <Ahorro banco={banco} t={t} f={f} />
      {palancaTtl && <PalancaDeTtl p={palancaTtl} t={t} f={f} ricos={ricos} />}
      <Garantias banco={banco} t={t} f={f} />
      <NoAhorra banco={banco} t={t} f={f} ricos={ricos} />
      <EstadoPorModelo banco={banco} t={t} f={f} />
      {banco.fallos.length > 0 && <Fallos banco={banco} t={t} f={f} />}
      <Reproducir banco={banco} t={t} ricos={ricos} />
      <section className="terms-sec banco-invita" aria-labelledby="invite-h" id="invite">
        <h2 id="invite-h">{t("invite.title")}</h2>
        <p>{t("invite.body")}</p>
        <p>
          {t("invite.contact")} <span className="banco-email">{CONTACTO}</span>
        </p>
        <p>
          <a className="btn btn-primary" href={`mailto:${CONTACTO}?subject=${encodeURIComponent(t("invite.subject"))}`}>
            {t("invite.cta")}
          </a>
        </p>
      </section>
    </main>
  );
}
