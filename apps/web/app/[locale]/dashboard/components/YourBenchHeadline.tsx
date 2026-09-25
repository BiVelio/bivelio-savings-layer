import { getTranslations } from "next-intl/server";

import { NIVEL, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, moneySigned, pct, pct0 } from "../format";

/**
 * EL TITULAR DE «TU PROPIO BANCO»: el SUELO del IC de la fracción ahorrada
 * (nunca la estimación puntual), con las mismas clases que la banda del banco
 * publicado. Justo debajo, la diferencia media por cada mil peticiones con su
 * intervalo, la base (pares, cobertura, tasa lograda) y, si se calculó sobre un
 * subconjunto, que lo diga.
 */
export async function YourBenchHeadline({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  const f = informe.titular!.fraccion;
  const d = informe.titular!.diferencia;
  const dmin = Math.min(-0.05, f.lower - 0.05);
  const dmax = Math.max(0.6, f.upper + 0.05);
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  const nivel = pct0(NIVEL);
  return (
    <>
      <div className="verdict band">
        <div>
          <div className={`big ck-num ${f.lower >= 0 ? "pos" : "neg"}`}>≥ {pct(f.lower)}</div>
          <div className="cap">
            {t.rich("yourBench.headlineCaption", {
              b: (chunks) => <b>{chunks}</b>,
              pairs: intfmt(informe.paresUsados),
              level: nivel,
              point: pct(f.point),
              upper: pct(f.upper),
            })}
          </div>
        </div>
        <div>
          <div className="ci-track2">
            <div className="ci-fill2" style={{ left: `${xp(f.lower)}%`, width: `${xp(f.upper) - xp(f.lower)}%` }} />
            <div className="ci-zero2" style={{ left: `${xp(0)}%` }} />
            <div className="ci-lo" style={{ left: `${xp(f.lower)}%` }} />
            <div className="ci-pt" style={{ left: `${xp(f.point)}%` }} />
          </div>
          <div className="ci-legend2">
            <span>{pct(dmin)}</span>
            <span>{pct(0)}</span>
            <span>{pct(dmax)}</span>
          </div>
        </div>
      </div>
      <p className="ck-note">
        {t("yourBench.meanDiff", {
          per: intfmt(POR_CADA),
          point: moneySigned(d.point * POR_CADA),
          lower: moneySigned(d.lower * POR_CADA),
          upper: moneySigned(d.upper * POR_CADA),
          level: nivel,
        })}
      </p>
      <p className="ck-note">
        {t("yourBench.basis", {
          pairs: intfmt(informe.paresTotales),
          coverage: pct0(informe.cobertura),
          eligible: intfmt(informe.elegibles),
          rate: pct(informe.tasaLograda),
        })}
      </p>
      {informe.submuestreado ? (
        <p className="ck-note">{t("yourBench.subsampled", { n: intfmt(informe.paresUsados), total: intfmt(informe.paresTotales) })}</p>
      ) : null}
    </>
  );
}
