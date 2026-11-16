/*
 * Derived from affectUI Pro 'data-table' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./data-table.css";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Data Table – FORKED TO READ-ONLY. Upstream is a small spreadsheet: select cells and ranges, edit in place, paste
 * from Excel, undo, check rows, add rows, pick tags. None of that exists here, on purpose: these rows are measured
 * facts and a cell that looks editable would be a lie. What stays is the look (hairline rows, quiet 12px header)
 * and ONE interaction: sorting by a column (ascending → descending → as delivered), announced with `aria-sort`.
 * Cells arrive already formatted; `sort` is the raw value the column orders by. A `null` sort value always goes
 * last, in both directions: a reading that is missing is not the smallest number.
 */

export type DataTableColumn = {
  key: string;
  label: string;
  align?: "end";
  mono?: boolean;
  nowrap?: boolean;
  sortable?: boolean;
};

export type DataTableCell = {
  /** What the cell shows */
  content: ReactNode;
  /** What the column sorts by; `null` = no reading (always last) */
  sort?: number | string | null;
  quiet?: boolean;
};

export type DataTableRow = { id: string; cells: Record<string, DataTableCell> };

export type DataTableProps = {
  /** Read by screen readers as the table's caption */
  caption: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  /** One summary line under the rows that never takes part in sorting: label spans all columns but the last */
  summary?: { label: ReactNode; value: ReactNode };
  /** Accessible name of a sort button; "{column}" is replaced by the column's label */
  sortLabel: string;
  /** Minimum width before the table scrolls sideways inside its box, in px */
  minWidth?: number;
  className?: string;
};

type Sort = { key: string; dir: "asc" | "desc" } | null;

export function DataTable({ caption, columns, rows, summary, sortLabel, minWidth = 560, className }: DataTableProps) {
  const [sort, setSort] = useState<Sort>(null);

  const shown = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a.cells[sort.key]?.sort ?? null;
      const y = b.cells[sort.key]?.sort ?? null;
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }, [rows, sort]);

  const toggle = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  return (
    <div className={["ui-dtc", className].filter(Boolean).join(" ")} style={{ ["--ui-dtc-min" as string]: `${minWidth}px` } as CSSProperties}>
      <div className="ui-dtc__scroll" role="region" aria-label={caption} tabIndex={0}>
        <table className="ui-dtc__table">
          <caption className="ui-dtc__sr">{caption}</caption>
          <thead>
            <tr>
              {columns.map((col) => {
                const dir = sort?.key === col.key ? sort.dir : null;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    data-align={col.align}
                    aria-sort={col.sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
                  >
                    {col.sortable ? (
                      <button type="button" className="ui-dtc__th" onClick={() => toggle(col.key)} aria-label={sortLabel.replace("{column}", col.label)}>
                        <span>{col.label}</span>
                        <span className="ui-dtc__sort" data-dir={dir ?? undefined} aria-hidden="true">
                          <SortIcon />
                        </span>
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                {columns.map((col) => {
                  const cell = row.cells[col.key];
                  return (
                    <td
                      key={col.key}
                      data-align={col.align}
                      data-mono={col.mono || undefined}
                      data-nowrap={col.nowrap || undefined}
                      data-quiet={cell?.quiet || undefined}
                    >
                      {cell?.content ?? null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {summary ? (
            <tfoot>
              <tr>
                <td colSpan={Math.max(1, columns.length - 1)}>{summary.label}</td>
                <td data-align="end" data-mono="">
                  {summary.value}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}

const SortIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3.5v9M5 9.5l3 3 3-3" />
  </svg>
);
