import type { ReactNode } from "react";

import {
  BATERIAS,
  type Banco,
  type Bateria,
  type Fallo,
  type Intervalo,
  type ParNegativas,
  type Registro,
  type RegistroGsm8k,
} from "@/lib/banco-publico/extraer";

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

/** Repositorio de los arneses y de los informes. */
export const REPO = "https://github.com/BiVelio/bivelio-savings-layer";
/** Contacto para una medición independiente. */
export const CONTACTO = "support@bivelio.com";
/** Umbral con el que la página llama «significativa» una diferencia de negativas A/B. */
export const UMBRAL_P = 0.05;

/** El comando y el arnés de cada batería (un test comprueba que existen en el repo). */
export const REPRODUCIR: Record<Bateria, { comando: string; arnes: string }> = {
  gsm8k: { comando: "pnpm bench:gsm8k", arnes: "benchmarks/publicados/gsm8k/arnes.ts" },
  bfcl: { comando: "pnpm bench:bfcl", arnes: "benchmarks/publicados/bfcl/arnes.ts" },
  xstest: { comando: "pnpm bench:xstest", arnes: "benchmarks/publicados/xstest/banco.ts" },
  "mt-bench": { comando: "pnpm bench:mt-bench", arnes: "benchmarks/publicados/mt-bench/mt-bench.ts" },
};

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
  const ent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const p = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return {
    pct: (x: number) => pct.format(x),
    /** Porcentajes de diseño (nivel de confianza, fracciones del flujo): sin decimales. */
    pctRedondo: (x: number) => pctRedondo.format(x),
    /** Diferencia en puntos porcentuales, con signo. */
    pp: (x: number) => pp.format(x * 100),
    usd: (x: number) => usd.format(x),
    ent: (x: number) => ent.format(x),
    p: (x: number) => p.format(x),
    fecha: (iso: string) => (iso ? fecha.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—"),
    iv: (x: Intervalo) => `${pct.format(x.punto)} [${pct.format(x.inf)} – ${pct.format(x.sup)}]`,
  };
}

type F = ReturnType<typeof formatos>;

const enlace = (ruta: string) => `${REPO}/blob/main/${ruta}`;
const corto = (h: string) => h.slice(0, 12);

function Tirada({ r, f }: { r: Pick<Registro, "version" | "fecha" | "ruta">; f: F }) {
  return (
    <a className="banco-tirada" href={enlace(r.ruta)} target="_blank" rel="noopener noreferrer" data-ruta={r.ruta}>
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
                <td>
                  <a href={`${d.repo}/tree/${d.commit}`} target="_blank" rel="noopener noreferrer">
                    {d.repo.replace("https://github.com/", "")}@{d.commit.slice(0, 7)}
                  </a>
                </td>
                <td className="banco-hash">
                  {d.ficheros.length
                    ? d.ficheros.map((x) => (
                        <span key={x.nombre} title={x.sha256}>
                          {x.nombre} <code>sha256 {corto(x.sha256)}…</code>
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
              <li>
                {t("bugs.found", { version: x.encontradoEn, ocurrencias: f.ent(x.antes.ocurrencias), sobre: f.ent(x.antes.sobre) })}{" "}
                {x.antes.rutas.map((r) => (
                  <a key={r} className="banco-tirada" href={enlace(r)} target="_blank" rel="noopener noreferrer" data-ruta={r}>
                    {r.split("/").pop()}
                  </a>
                ))}
              </li>
              <li>{t("bugs.fixed", { version: x.arregladoEn, prs: prs(x) })}</li>
              <li>
                {x.despues
                  ? t(x.despues.ocurrencias === 0 ? "bugs.verified" : "bugs.stillSeen", {
                      version: x.despues.version,
                      ocurrencias: f.ent(x.despues.ocurrencias),
                      sobre: f.ent(x.despues.sobre),
                    })
                  : t("bugs.pending", { version: x.arregladoEn })}
              </li>
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
      <div className="tbl-scroll">
        <table className="tbl banco-tbl">
          <thead>
            <tr>
              <th scope="col">{t("th.battery")}</th>
              <th scope="col">{t("th.command")}</th>
              <th scope="col">{t("th.harness")}</th>
              <th scope="col">{t("th.reports")}</th>
            </tr>
          </thead>
          <tbody>
            {baterias.map((b) => (
              <tr key={b} data-bateria={b}>
                <td>{NOMBRE_BATERIA[b]}</td>
                <td>
                  <code>{REPRODUCIR[b].comando}</code>
                </td>
                <td>
                  <a href={enlace(REPRODUCIR[b].arnes)} target="_blank" rel="noopener noreferrer">
                    <code>{REPRODUCIR[b].arnes}</code>
                  </a>
                </td>
                <td className="banco-informes">
                  {banco.fuentes
                    .filter((x) => x.bateria === b)
                    .map((x) => (
                      <a key={x.ruta} href={enlace(x.ruta)} target="_blank" rel="noopener noreferrer" data-ruta={x.ruta}>
                        {x.ruta.split("/").pop()}
                      </a>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="banco-nota">{t("repro.readme")}</p>
    </section>
  );
}

export function BancoPublico({ banco, t, locale }: { banco: Banco; t: Traductor; locale: string }) {
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
      <Ahorro banco={banco} t={t} f={f} />
      <Garantias banco={banco} t={t} f={f} />
      <NoAhorra banco={banco} t={t} f={f} ricos={ricos} />
      <EstadoPorModelo banco={banco} t={t} f={f} />
      {banco.fallos.length > 0 && <Fallos banco={banco} t={t} f={f} />}
      <Reproducir banco={banco} t={t} ricos={ricos} />
      <section className="terms-sec banco-invita" aria-labelledby="invite-h" id="invite">
        <h2 id="invite-h">{t("invite.title")}</h2>
        <p>{t("invite.body")}</p>
        <p>
          <a className="btn btn-primary" href={`mailto:${CONTACTO}?subject=${encodeURIComponent(t("invite.subject"))}`}>
            {t("invite.cta", { email: CONTACTO })}
          </a>
        </p>
      </section>
    </main>
  );
}
