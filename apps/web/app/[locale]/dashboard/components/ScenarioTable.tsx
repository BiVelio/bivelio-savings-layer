"use client";

import { useTranslations } from "next-intl";

import { AyudaDeTermino } from "@/app/components/evidencia/Termino";
import { Badge } from "@/vendor/affectui/badge";
import { DataTableReadonly, type ReadColumn, type ReadRow } from "@/vendor/affectui/data-table-readonly";

import type { AbScenario } from "../data";
import { pct, money, intfmt, LEDGER_COLOR } from "../format";

/**
 * Per-scenario A vs B — la Data Table de affectUI en su bifurcación de SOLO
 * LECTURA: ordenable por cabecera, primera columna fija y desplazamiento
 * lateral con borde suave en pantallas estrechas. Nada se edita ni se
 * selecciona: es evidencia.
 *
 * Cada coste lleva una barra a la MISMA escala (el coste más alto de la tabla),
 * así que A y B se comparan de un vistazo; la barra es decorativa y la cifra
 * exacta va siempre escrita al lado.
 *
 * `piezaDelBanco`: escenarios cuyo ahorro salió de una pieza que el paquete de
 * npm no trae (el compresor del banco). La fila es evidencia y se queda, pero
 * lleva la marca: su cifra no es la de quien instala el SDK. La calcula la
 * página (servidor) con `escenariosConPiezaDelBanco`.
 */
export function ScenarioTable({ scenarios, piezaDelBanco = [] }: { scenarios: AbScenario[]; piezaDelBanco?: string[] }) {
  const t = useTranslations("dashboard");

  const techo = Math.max(...scenarios.map((s) => Math.max(s.armA.meanCost, s.armB.meanCost)), 0);
  const ancho = (v: number) => (techo > 0 ? `${Math.max(v > 0 ? 2 : 0, (v / techo) * 100)}%` : "0%");
  const ayuda = (col: string, definicion: string) => <AyudaDeTermino etiqueta={t("scenarioTable.help", { col })} definicion={definicion} />;
  const ordenar = (col: string) => t("scenarioTable.sortBy", { col });

  const columns: ReadColumn[] = [
    { key: "name", label: t("scenarioTable.colScenario"), sortable: true, sortLabel: ordenar(t("scenarioTable.colScenario")), width: "30%" },
    { key: "kind", label: t("scenarioTable.colKind"), sortable: true, sortLabel: ordenar(t("scenarioTable.colKind")) },
    { key: "aTok", label: t("scenarioTable.colAInOut"), align: "end", help: ayuda(t("scenarioTable.colAInOut"), t("scenarioTable.termTokens")) },
    { key: "bTok", label: t("scenarioTable.colBInOut"), align: "end" },
    { key: "a", label: t("scenarioTable.colACost"), align: "end", sortable: true, sortLabel: ordenar(t("scenarioTable.colACost")), help: ayuda(t("scenarioTable.colACost"), t("scenarioTable.termCost")) },
    { key: "b", label: t("scenarioTable.colBCost"), align: "end", sortable: true, sortLabel: ordenar(t("scenarioTable.colBCost")) },
    { key: "savings", label: t("scenarioTable.colSavings"), align: "end", sortable: true, sortLabel: ordenar(t("scenarioTable.colSavings")), help: ayuda(t("scenarioTable.colSavings"), t("scenarioTable.termSavings")) },
    { key: "quality", label: t("scenarioTable.colQa"), align: "end", sortable: true, sortLabel: ordenar(t("scenarioTable.colQa")), help: ayuda(t("scenarioTable.colQa"), t("scenarioTable.termQa")) },
  ];

  const rows: ReadRow[] = scenarios.map((s) => {
    const sv = s.measured.savings.point;
    return {
      id: s.name,
      sort: {
        name: s.name,
        kind: s.kind,
        a: s.armA.meanCost,
        b: s.armB.meanCost,
        savings: sv,
        quality: s.quality.total ? s.quality.passed / s.quality.total : null,
      },
      cells: {
        name: (
          <span className="st-name">
            <span className="ltag" style={{ background: LEDGER_COLOR[s.ledger] ?? "var(--muted)" }} />
            <span className="st-name-t">
              {s.name}
              {piezaDelBanco.includes(s.name) ? (
                <>
                  {" "}
                  <Badge tone="warning" className="st-flag">
                    {t("scenarioTable.benchOnly")}
                  </Badge>
                </>
              ) : null}
            </span>
          </span>
        ),
        kind: <span className="st-kind mono">{s.kind}</span>,
        aTok: <span className="mono st-tok">{intfmt(s.armA.meanInputTokens)}/{intfmt(s.armA.meanOutputTokens)}</span>,
        bTok: <span className="mono st-tok">{intfmt(s.armB.meanInputTokens)}/{intfmt(s.armB.meanOutputTokens)}</span>,
        a: (
          <span className="st-cost">
            <span className="mono">{money(s.armA.meanCost)}</span>
            <span className="st-bar" aria-hidden>
              <i className="st-bar-a" style={{ width: ancho(s.armA.meanCost) }} />
            </span>
          </span>
        ),
        b: (
          <span className="st-cost">
            <span className="mono">{money(s.armB.meanCost)}</span>
            <span className="st-bar" aria-hidden>
              <i className="st-bar-b" style={{ width: ancho(s.armB.meanCost) }} />
            </span>
          </span>
        ),
        savings: <span className={`mono st-sv ${sv >= 0 ? "pos" : "neg"}`}>{pct(sv)}</span>,
        quality: <span className="mono">{s.quality.passed}/{s.quality.total}</span>,
      },
    };
  });

  return (
    <DataTableReadonly
      className="prf-tbl"
      title={t("scenarioTable.title")}
      description={t("scenarioTable.caption")}
      columns={columns}
      rows={rows}
      defaultSort={{ key: "savings", dir: "desc" }}
      minWidth="880px"
    />
  );
}
