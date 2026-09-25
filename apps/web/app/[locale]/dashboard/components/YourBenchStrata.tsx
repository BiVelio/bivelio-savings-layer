import { getTranslations } from "next-intl/server";

import { MIN_PARES_POR_ESTRATO, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, money, moneySigned } from "../format";

/**
 * LOS ESTRATOS: cómo sirvió la capa cada petición, cuántas elegibles hubo
 * (N_h, el peso), cuántos pares, las dos medias y la diferencia por cada mil
 * con su intervalo. Un estrato sin pares suficientes lo dice en vez de enseñar
 * una cifra que no se sostiene.
 */
export async function YourBenchStrata({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  const filas = informe.estratos.filter((e) => e.elegibles > 0 || e.pares > 0);
  return (
    <div className="card card-pad">
      <div className="card-title">{t("yourBench.strataTitle")}</div>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("yourBench.colKind")}</th>
              <th>{t("yourBench.colEligible")}</th>
              <th>{t("yourBench.colPairs")}</th>
              <th>{t("yourBench.colNaive")}</th>
              <th>{t("yourBench.colOptimized")}</th>
              <th>{t("yourBench.colDiff", { per: intfmt(POR_CADA) })}</th>
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
