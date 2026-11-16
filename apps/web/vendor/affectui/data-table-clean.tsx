/*
 * Derived from affectUI Pro 'Data Table' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./data-table-clean.css";
import type { ReactNode } from "react";

import { ScrollArea } from "./scroll-area-clean";

/*
 * Data Table – clean style: one white card whose edge is a shadow, a quiet header row of small labels, rows divided
 * by hairlines only (no vertical grid lines) and a soft wash on the row under the pointer.
 *
 * BiVelio: FORKED TO READ-ONLY, as a server component. Upstream is a small spreadsheet: editable cells, a cell
 * cursor, range selection, copy and paste, sorting, row checkboxes, bulk actions, "add row", undo and redo. On a
 * terms page or in a paper NONE of that may exist – a published figure must not look editable – so all of it is
 * gone, and with it every English string and the demo data. What is left is the look, on a real <table>:
 *   · `columns` (label, alignment, share of the width) and `rows` (a key and one node per column) from the caller;
 *   · the first cell of a row can be its header (`rowHeader`, <th scope="row">);
 *   · cells WRAP (upstream cut them with …) and numbers are tabular;
 *   · `caption` names the table for a screen reader; `title` and `footer` are optional slots;
 *   · when the table is wider than its card it scrolls sideways inside the library's Scroll Area, which is then a
 *     named, focusable region (`scrollLabel`) with soft fades on the edge that has more.
 */

export type DataTableColumn = {
  label: ReactNode;
  align?: "start" | "end";
  /** A CSS width for the column, e.g. "34%" */
  width?: string;
  /** Tabular, monospaced figures */
  numeric?: boolean;
};

export type DataTableRow = {
  key: string;
  cells: ReactNode[];
};

export type DataTableProps = {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  /** The table's accessible name (visually hidden <caption>) */
  caption?: string;
  /** A title row inside the card, above the header */
  title?: ReactNode;
  /** A quiet line under the last row, e.g. a note on the figures */
  footer?: ReactNode;
  /** Makes the first cell of every row its header */
  rowHeader?: boolean;
  /** Accessible name of the sideways-scrolling region – translated by the caller */
  scrollLabel?: string;
  /** The least the table measures before it scrolls sideways, as a CSS length */
  minWidth?: string;
  /** Tighter rows */
  dense?: boolean;
  className?: string;
  lang?: string;
};

export function DataTable({ columns, rows, caption, title, footer, rowHeader = false, scrollLabel, minWidth, dense, className, lang }: DataTableProps) {
  return (
    <div className={["ui-dtc", className].filter(Boolean).join(" ")} data-dense={dense || undefined} lang={lang}>
      {title != null && title !== false ? (
        <div className="ui-dtc__head">
          <p className="ui-dtc__title">{title}</p>
        </div>
      ) : null}
      <ScrollArea className="ui-dtc__scroll" orientation="horizontal" fade aria-label={scrollLabel}>
        <table className="ui-dtc__table" style={minWidth ? { minWidth } : undefined}>
          {caption ? <caption className="ui-dtc__caption">{caption}</caption> : null}
          <colgroup>
            {columns.map((c, i) => (
              <col key={i} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} scope="col" data-align={c.align === "end" ? "end" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, i) => {
                  const col = columns[i];
                  const attrs = { "data-align": col?.align === "end" ? "end" : undefined, "data-type": col?.numeric ? "number" : undefined };
                  return rowHeader && i === 0 ? (
                    <th key={i} scope="row" {...attrs}>
                      {cell}
                    </th>
                  ) : (
                    <td key={i} {...attrs}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      {footer != null && footer !== false ? <div className="ui-dtc__foot">{footer}</div> : null}
    </div>
  );
}
