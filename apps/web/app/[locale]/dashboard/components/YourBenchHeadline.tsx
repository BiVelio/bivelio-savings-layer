import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { NIVEL, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, moneySigned, pct, pct0, pct0Floor, pctFloor } from "../format";

/**
 * EL TITULAR DE «TU PROPIO BANCO»: el SUELO del IC de la fracción ahorrada
 * (nunca la estimación puntual), con las mismas clases que la banda del banco
 * publicado. Justo debajo, la diferencia media por cada mil peticiones con su
 * intervalo, la base (pares, cobertura, tasa lograda) y, si se calculó sobre un
 * subconjunto, que lo diga.
 *
 * El pie dice SOBRE QUÉ habla la cifra: los pares que de verdad entran en el
 * cálculo (no los leídos) y, si algún grupo de peticiones elegibles no tiene
 * ningún par, que la cifra no lo abarca y qué parte sí. El suelo se pinta
 * redondeado HACIA ABAJO y la cobertura también: una cifra de suelo que sube
 * al pintarse deja de ser un suelo.
 */
export async function YourBenchHeadline({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  const f = informe.titular!.fraccion;
  const d = informe.titular!.diferencia;
  const dmin = Math.min(-0.05, f.lower - 0.05);
  const dmax = Math.max(0.6, f.upper + 0.05);
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  const nivel = pct0(NIVEL);
  const completa = informe.cobertura >= 1;
  const pie = {
    b: (chunks: ReactNode) => <b>{chunks}</b>,
    pairs: intfmt(informe.paresEnTitular),
    level: nivel,
    point: pct(f.point),
    upper: pct(f.upper),
  };
  return (
    <>
      <div className="verdict band">
        <div>
          <div className={`big ck-num ${f.lower >= 0 ? "pos" : "neg"}`}>≥ {pctFloor(f.lower)}</div>
          <div className="cap">
            {completa
              ? t.rich("yourBench.headlineCaption", pie)
              : t.rich("yourBench.headlineCaptionPartial", { ...pie, coverage: pct0Floor(informe.cobertura) })}
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
          pairs: intfmt(informe.paresEnTitular),
          coverage: pct0Floor(informe.cobertura),
          eligible: intfmt(informe.elegibles),
          rate: pct(informe.tasaLograda),
        })}
      </p>
      {informe.submuestreado ? (
        <p className="ck-note">{t("yourBench.subsampled", { n: intfmt(informe.paresLeidos), total: intfmt(informe.paresTotales) })}</p>
      ) : null}
    </>
  );
}
