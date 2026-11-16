import { getTranslations } from "next-intl/server";

import { MIN_PARES_POR_ESTRATO, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, money, moneySigned } from "../format";

/**
 * LOS ESTRATOS: cómo sirvió la capa cada petición, cuántas elegibles hubo
 * (N_h, el peso), cuántos pares comparables, las dos medias y la diferencia por
 * cada mil con su intervalo. Un estrato con pocos pares lo dice en vez de
 * enseñar un intervalo que no se sostiene (sus pares sí entran en el titular);
 * uno sin ninguno, que no tiene pares. Se enseña también mientras se reúnen
 * pares: es donde se ve qué grupo falta.
 */
export async function YourBenchStrata({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  const filas = informe.estratos.filter((e) => e.elegibles > 0 || e.pares > 0);
  return (
    <div className="card card-pad yb-card">
      <h2 className="yb-h">{t("yourBench.strataTitle")}</h2>
      <div className="tbl-scroll">
        <table className="tbl tbl--static">
          <thead>
            <tr>
              <th scope="col">{t("yourBench.colKind")}</th>
              <th scope="col">{t("yourBench.colEligible")}</th>
              <th scope="col">{t("yourBench.colPairs")}</th>
              <th scope="col">{t("yourBench.colNaive")}</th>
              <th scope="col">{t("yourBench.colOptimized")}</th>
              <th scope="col">{t("yourBench.colDiff", { per: intfmt(POR_CADA) })}</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((e) => (
              <tr key={e.estrato}>
                <td>{t(`yourBench.stratum.${e.estrato}`)}</td>
                <td className="mono">{intfmt(e.elegibles)}</td>
                <td className="mono">{intfmt(e.pares)}</td>
                <td className="mono">{e.mediaSinCapa === null ? "—" : money(e.mediaSinCapa)}</td>
                <td className="mono">{e.mediaConCapa === null ? "—" : money(e.mediaConCapa)}</td>
                <td className="mono">
                  {e.cubierto && e.diferencia
                    ? `${moneySigned(e.diferencia.point * POR_CADA)} (${moneySigned(e.diferencia.lower * POR_CADA)} … ${moneySigned(e.diferencia.upper * POR_CADA)})`
                    : e.pares === 0
                      ? t("yourBench.noPairs")
                      : t("yourBench.notCovered", { n: intfmt(e.pares), min: intfmt(MIN_PARES_POR_ESTRATO) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
