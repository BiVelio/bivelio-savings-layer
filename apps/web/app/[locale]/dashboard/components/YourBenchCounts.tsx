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
  // Barras a la escala de la fila mayor de CADA lista: dicen qué motivo pesa
  // más dentro de su lista, no comparan una lista con la otra. Decorativas.
  const techo = (ns: number[]) => Math.max(1, ...ns);
  const maxExcl = techo(informe.exclusiones.map((x) => x.peticiones));
  const maxRes = techo(informe.resultados.map((x) => x.muestras));
  return (
    <div className="yb-duo">
      <div className="card card-pad yb-card">
        <h2 className="yb-h">{t("yourBench.exclusionsTitle")}</h2>
        <p className="ck-note">{t("yourBench.exclusionsIntro")}</p>
        {informe.exclusiones.length === 0 ? (
          <p className="ck-note">{t("yourBench.exclusionsNone")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl tbl--static yb-tbl2">
              <tbody>
                {informe.exclusiones.map((x) => (
                  <tr key={x.motivo}>
                    <th scope="row">
                      {t(`yourBench.excluded.${x.motivo}`)}
                      <span className="yb-bar" aria-hidden>
                        <i style={{ width: `${(x.peticiones / maxExcl) * 100}%` }} />
                      </span>
                    </th>
                    <td className="mono">{intfmt(x.peticiones)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-pad yb-card">
        <h2 className="yb-h">{t("yourBench.outcomesTitle")}</h2>
        {informe.resultados.length === 0 ? (
          <p className="ck-note">{t("yourBench.outcomesNone")}</p>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl tbl--static yb-tbl2">
              <tbody>
                {informe.resultados.map((x) => (
                  <tr key={x.resultado}>
                    <th scope="row">
                      {t(`yourBench.outcome.${x.resultado}`)}
                      <span className="yb-bar" aria-hidden>
                        <i style={{ width: `${(x.muestras / maxRes) * 100}%` }} />
                      </span>
                    </th>
                    <td className="mono">{intfmt(x.muestras)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
