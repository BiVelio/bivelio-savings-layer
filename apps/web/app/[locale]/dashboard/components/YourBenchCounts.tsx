import { getTranslations } from "next-intl/server";

import type { InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt } from "../format";

/**
 * LO QUE NO ENTRA EN LOS PARES, CONTADO Y A LA VISTA: las peticiones nunca
 * comprobadas (y por qué) y las comprobaciones que no llegaron a par. Esconder
 * las exclusiones sería la forma más barata de mejorar la cifra.
 */
export async function YourBenchCounts({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  return (
    <>
      <div className="card card-pad">
        <div className="card-title">{t("yourBench.exclusionsTitle")}</div>
        <p className="ck-note">{t("yourBench.exclusionsIntro")}</p>
        {informe.exclusiones.length === 0 ? (
          <p className="ck-note">{t("yourBench.exclusionsNone")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <tbody>
                {informe.exclusiones.map((x) => (
                  <tr key={x.motivo}>
                    <td>{t(`yourBench.excluded.${x.motivo}`)}</td>
                    <td className="mono">{intfmt(x.peticiones)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-pad app-gap">
        <div className="card-title">{t("yourBench.outcomesTitle")}</div>
        {informe.resultados.length === 0 ? (
          <p className="ck-note">{t("yourBench.outcomesNone")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <tbody>
                {informe.resultados.map((x) => (
                  <tr key={x.resultado}>
                    <td>{t(`yourBench.outcome.${x.resultado}`)}</td>
                    <td className="mono">{intfmt(x.muestras)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
