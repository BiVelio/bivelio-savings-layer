"use client";

import { useMemo, useState } from "react";

import { useTranslations } from "next-intl";

import type { AbScenario } from "../data";
import { pct, money, intfmt, LEDGER_COLOR } from "../format";

type Col = "name" | "kind" | "a" | "b" | "savings" | "quality";

/** Per-scenario A vs B, sortable, horizontal-scroll on narrow screens. */
export function ScenarioTable({ scenarios }: { scenarios: AbScenario[] }) {
  const t = useTranslations("dashboard");
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "savings", dir: -1 });

  const rows = useMemo(() => {
    const val = (s: AbScenario): number | string => {
      switch (sort.col) {
        case "name": return s.name;
        case "kind": return s.kind;
        case "a": return s.armA.meanCost;
        case "b": return s.armB.meanCost;
        case "savings": return s.measured.savings.point;
        case "quality": return s.quality.total ? s.quality.passed / s.quality.total : 0;
      }
    };
    return [...scenarios].sort((x, y) => {
      const vx = val(x), vy = val(y);
      if (typeof vx === "string") return String(vx).localeCompare(String(vy)) * sort.dir;
      return ((vx as number) - (vy as number)) * sort.dir;
    });
  }, [scenarios, sort]);

  const th = (col: Col, label: string) => (
    <th onClick={() => setSort((s) => ({ col, dir: s.col === col && s.dir === -1 ? 1 : -1 }))}>
      {label}{sort.col === col ? (sort.dir === -1 ? " ▾" : " ▴") : ""}
    </th>
  );

  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            {th("name", t("scenarioTable.colScenario"))}
            {th("kind", t("scenarioTable.colKind"))}
            <th>{t("scenarioTable.colAInOut")}</th>
            <th>{t("scenarioTable.colBInOut")}</th>
            {th("a", t("scenarioTable.colACost"))}
            {th("b", t("scenarioTable.colBCost"))}
            {th("savings", t("scenarioTable.colSavings"))}
            {th("quality", t("scenarioTable.colQa"))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const sv = s.measured.savings.point;
            return (
              <tr key={s.name}>
                <td>
                  <span className="ltag" style={{ background: LEDGER_COLOR[s.ledger] ?? "var(--muted)" }} />
                  {s.name}
                </td>
                <td className="mono">{s.kind}</td>
                <td className="mono">{intfmt(s.armA.meanInputTokens)}/{intfmt(s.armA.meanOutputTokens)}</td>
                <td className="mono">{intfmt(s.armB.meanInputTokens)}/{intfmt(s.armB.meanOutputTokens)}</td>
                <td className="mono">{money(s.armA.meanCost)}</td>
                <td className="mono">{money(s.armB.meanCost)}</td>
                <td className={`mono ${sv >= 0 ? "pos" : "neg"}`}>{pct(sv)}</td>
                <td className="mono">{s.quality.passed}/{s.quality.total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
