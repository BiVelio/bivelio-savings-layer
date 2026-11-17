import { getTranslations } from "next-intl/server";

import { Badge } from "@/vendor/affectui/badge-clean";
import { CompactBreakdown } from "@/vendor/affectui/compact-breakdown";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/vendor/affectui/data-table-clean";

import { MIN_PARES_POR_ESTRATO, POR_CADA, type InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { intfmt, money, moneySigned } from "../format";

/**
 * LOS ESTRATOS: cómo sirvió la capa cada petición, cuántas elegibles hubo
 * (N_h, el peso), cuántos pares comparables, las dos medias y la diferencia por
 * cada mil con su intervalo. Un estrato con pocos pares lo dice en vez de
 * enseñar un intervalo que no se sostiene (sus pares sí entran en el titular);
 * uno sin ninguno, que no tiene pares. Se enseña también mientras se reúnen
 * pares: es donde se ve qué grupo falta.
 *
 * Dos piezas de affectUI: el Compact Breakdown reparte las peticiones elegibles
 * entre los grupos (es el PESO de cada uno en el titular, y sí es aditivo) y la
 * Data Table de solo lectura lleva las medias y la diferencia, ordenable. Un
 * grupo sin intervalo ordena al final: que falte un dato no lo convierte en cero.
 */
/**
 * Color de cada grupo con la Firma de campaña: el cian como DATO solo para
 * «respondida sin llamar a tu proveedor»; el resto en tinta y en azul de marca,
 * de más a menos intervención de la capa. Un grupo que no esté aquí cae en la
 * rampa, por su posición.
 */
const COLOR_DEL_GRUPO: Record<string, string> = {
  avoided_call: "var(--cian)",
  cheaper_model: "var(--brand)",
  tokens_removed: "var(--ink-2)",
  tokens_compressed: "var(--pagada-borde)",
  unchanged: "#B4BAC4",
};
const RAMPA = ["var(--brand)", "var(--ink-2)", "var(--pagada-borde)", "var(--ink-soft)"];
export async function YourBenchStrata({ informe }: { informe: InformeDelBancoPropio }) {
  const t = await getTranslations("dashboard");
  const filas = informe.estratos.filter((e) => e.elegibles > 0 || e.pares > 0);
  // Color estable por grupo: por su posición en la lista completa del informe.
  const COLOR: Record<string, string> = Object.fromEntries(
    informe.estratos.map((e, i) => [e.estrato, COLOR_DEL_GRUPO[e.estrato] ?? RAMPA[i % RAMPA.length]!]),
  );
  const columns: DataTableColumn[] = [
    { key: "tipo", label: t("yourBench.colKind"), width: "26%" },
    { key: "elegibles", label: t("yourBench.colEligible"), align: "end", sortable: true },
    { key: "pares", label: t("yourBench.colPairs"), align: "end", sortable: true },
    { key: "sin", label: t("yourBench.colNaive"), align: "end" },
    { key: "con", label: t("yourBench.colOptimized"), align: "end" },
    { key: "dif", label: t("yourBench.colDiff", { per: intfmt(POR_CADA) }), align: "end", sortable: true },
  ];
  const rows: DataTableRow[] = filas.map((e) => {
    const medido = e.cubierto && e.diferencia;
    return {
      id: e.estrato,
      sort: { elegibles: e.elegibles, pares: e.pares, dif: medido ? e.diferencia!.point : null },
      cells: {
        tipo: (
          <span className="st-name">
            <span className="ltag" style={{ background: COLOR[e.estrato] }} />
            <span className="st-name-t">{t(`yourBench.stratum.${e.estrato}`)}</span>
          </span>
        ),
        elegibles: <span className="mono">{intfmt(e.elegibles)}</span>,
        pares: <span className="mono">{intfmt(e.pares)}</span>,
        sin: <span className="mono">{e.mediaSinCapa === null ? "—" : money(e.mediaSinCapa)}</span>,
        con: <span className="mono">{e.mediaConCapa === null ? "—" : money(e.mediaConCapa)}</span>,
        dif: medido ? (
          <span className="yb-dif">
            <span className={`mono st-sv ${e.diferencia!.point >= 0 ? "pos" : "neg"}`}>{moneySigned(e.diferencia!.point * POR_CADA)}</span>
            <span className="mono yb-dif-ci">
              ({moneySigned(e.diferencia!.lower * POR_CADA)} … {moneySigned(e.diferencia!.upper * POR_CADA)})
            </span>
          </span>
        ) : (
          <Badge size="sm" tone={e.pares === 0 ? "neutral" : "warning"}>
            {e.pares === 0 ? t("yourBench.noPairs") : t("yourBench.notCovered", { n: intfmt(e.pares), min: intfmt(MIN_PARES_POR_ESTRATO) })}
          </Badge>
        ),
      },
    };
  });
  const conPeso = filas.filter((e) => e.elegibles > 0);
  return (
    <div className="yb-strata">
      {conPeso.length > 1 ? (
        <CompactBreakdown
          className="yb-pesos"
          headingAs="h2"
          title={t("yourBench.weightsTitle")}
          total={intfmt(conPeso.reduce((a, e) => a + e.elegibles, 0))}
          totalLabel={t("yourBench.weightsTotal")}
          items={conPeso.map((e) => ({
            id: e.estrato,
            label: t(`yourBench.stratum.${e.estrato}`),
            value: e.elegibles,
            display: intfmt(e.elegibles),
            color: COLOR[e.estrato]!,
          }))}
          footer={t("yourBench.weightsNote")}
        />
      ) : null}
      <DataTable
        className="yb-tabla"
        headingAs="h2"
        label={t("yourBench.strataTitle")}
        title={t("yourBench.strataTitle")}
        columns={columns}
        rows={rows}
        rowHeader
        pinFirst
        sortLabel={t("scenarioTable.sortBy", { col: "{column}" })}
        minWidth="760px"
      />
    </div>
  );
}
