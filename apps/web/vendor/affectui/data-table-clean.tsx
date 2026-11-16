/*
 * Derived from affectUI Pro 'Data Table' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./data-table-clean.css";

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ScrollArea } from "./scroll-area-clean";

/*
 * Data Table – clean style: one white card whose edge is a shadow, a quiet header row of 12px gray labels, rows
 * divided by hairlines only (no vertical grid lines), a soft wash on the row under the pointer and a sort arrow that
 * turns on the header you pick.
 *
 * BiVelio: FORKED TO READ-ONLY, and ONE table for the whole site (panel, statement, evidence, terms, paper).
 * Upstream is a small spreadsheet: editable cells, a cell cursor, range selection, copy and paste, row checkboxes,
 * bulk actions, tag pickers, "add row", undo and redo. None of that exists here, on purpose: these rows are measured,
 * contractual or published facts, and a cell that looks editable would be a lie. What is left is the look, on a
 * real <table>, and ONE interaction – sorting:
 *   · cells are nodes the caller already rendered (formatted and localised on the server); sorting uses the raw
 *     value given next to each one (`row.sort`), so it never parses a localised string;
 *   · a value that is missing (`null` or absent) ALWAYS sorts last, in both directions – a reading that is missing
 *     is not the smallest number, and it is never treated as zero;
 *   · the sorted column says so with `aria-sort`; every sortable header is a <button>, 44px tall under a finger;
 *   · no English: every label, including the sort button's name, arrives through props;
 *   · wider than its box it scrolls sideways inside the library's Scroll Area (a named region that is a Tab stop
 *     only while it really scrolls, with soft fades where there is more), optionally with the first column pinned;
 *     or, with `narrow="stack"`, every row turns into a small label/value sheet under 640px of its own width.
 */

export type DataTableColumn = {
  key: string;
  /** The header */
  label: ReactNode;
  /** Something after the label, outside the sort button – e.g. a "?" with the term's definition */
  help?: ReactNode;
  /** end: figures (right-aligned, tabular, never broken) · start: text */
  align?: "start" | "end";
  /** Figures and identifiers in the mono face */
  mono?: boolean;
  /** Text that must stay on one line (an id, a date) */
  nowrap?: boolean;
  /** Offers sorting on this column – rows then give a `sort` value for it */
  sortable?: boolean;
  /** A CSS width for the column, e.g. "28%" or "64px" */
  width?: string;
  /** narrow="stack": the cell that names the row – first, and without a label */
  lead?: boolean;
  /** narrow="stack": no label – for a cell of controls */
  plain?: boolean;
};

export type DataTableRow = {
  id: string;
  /** One node per column key */
  cells: Record<string, ReactNode>;
  /** Raw values to sort by, per column key. null or absent = no reading (always last) */
  sort?: Record<string, number | string | null | undefined>;
  /** Column keys whose cell is a placeholder ("—", "undeclared"): shown quieter */
  quiet?: string[];
};

export type DataTableSort = { key: string; dir: "asc" | "desc" };

export type DataTableProps = {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  /** The table's accessible name (a visually hidden <caption>) and the name of its scrolling region */
  label: string;
  /** A title row inside the card, above the header */
  title?: ReactNode;
  /** A quiet line under the title: what the table is and how to read it */
  description?: ReactNode;
  /** Slot at the right of the title row: an evidence badge, a count */
  aside?: ReactNode;
  headingAs?: "h2" | "h3" | "h4";
  /** One summary line under the rows that never takes part in sorting: its label spans all columns but the last */
  summary?: { label: ReactNode; value: ReactNode };
  /** A quiet line under the table: a note on the figures, a link */
  footer?: ReactNode;
  /** Accessible name of a sort button; "{column}" is replaced by the column's label (when that is text) */
  sortLabel?: string;
  /** The order it opens in. With it, a header toggles between the two directions; without, a third press gives the delivered order back */
  defaultSort?: DataTableSort;
  /** Locale for comparing text */
  locale?: string;
  /** flat: no card around it – for a table that already sits in one */
  flat?: boolean;
  /** Tighter rows */
  dense?: boolean;
  /** Cells are prose (a paper, a guide): top-aligned, and long tokens may break anywhere */
  prose?: boolean;
  /** Makes the first cell of every row its header (<th scope="row">) */
  rowHeader?: boolean;
  /** Keeps the first column in view while the rest scrolls sideways */
  pinFirst?: boolean;
  /** What happens when it does not fit: scroll sideways (default) · stack every row as a label/value sheet */
  narrow?: "scroll" | "stack";
  /** The least the table measures before it scrolls sideways, as a CSS length */
  minWidth?: string;
  className?: string;
  lang?: string;
};

export function DataTable({
  columns,
  rows,
  label,
  title,
  description,
  aside,
  headingAs: Heading = "h3",
  summary,
  footer,
  sortLabel,
  defaultSort,
  locale,
  flat,
  dense,
  prose,
  rowHeader = false,
  pinFirst,
  narrow = "scroll",
  minWidth,
  className,
  lang,
}: DataTableProps) {
  const [sort, setSort] = useState<DataTableSort | null>(defaultSort ?? null);
  const root = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return [...rows].sort((a, b) => {
      const x = a.sort?.[sort.key] ?? null;
      const y = b.sort?.[sort.key] ?? null;
      // No data is not a zero: it goes last whichever way the column is sorted
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return collator.compare(String(x), String(y)) * dir;
    });
  }, [rows, sort, locale]);

  /* Largest first, then smallest first; without a default order the third press gives the delivered order back */
  const press = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : defaultSort ? { key, dir: "desc" } : null));

  const hasHead = [title, description, aside].some((n) => n != null && n !== false && n !== "");
  const hasFoot = footer != null && footer !== false && footer !== "";

  return (
    <div
      ref={root}
      className={["ui-dtc", className].filter(Boolean).join(" ")}
      data-flat={flat ? "" : undefined}
      data-dense={dense ? "" : undefined}
      data-prose={prose ? "" : undefined}
      data-pin={pinFirst ? "" : undefined}
      data-narrow={narrow}
      style={minWidth ? ({ "--ui-dtc-min": minWidth } as CSSProperties) : undefined}
      lang={lang}
    >
      {hasHead ? (
        <div className="ui-dtc__head">
          <div className="ui-dtc__heading">
            {title ? <Heading className="ui-dtc__title">{title}</Heading> : null}
            {description ? <p className="ui-dtc__desc">{description}</p> : null}
          </div>
          {aside ? <div className="ui-dtc__aside">{aside}</div> : null}
        </div>
      ) : null}
      <ScrollArea
        className="ui-dtc__scroll"
        orientation="horizontal"
        fade
        aria-label={label}
        // The pinned column draws a soft edge only once something has slid under it
        onScroll={pinFirst ? (e) => root.current?.toggleAttribute("data-scrolled", Math.abs(e.currentTarget.scrollLeft) > 1) : undefined}
      >
        <table className="ui-dtc__table">
          <caption className="ui-dtc__caption">{label}</caption>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => {
                const dir = sort?.key === c.key ? sort.dir : null;
                const name = sortLabel && typeof c.label === "string" ? sortLabel.replace("{column}", c.label) : undefined;
                return (
                  <th key={c.key} scope="col" data-align={c.align === "end" ? "end" : undefined} aria-sort={c.sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}>
                    <span className="ui-dtc__th-in">
                      {c.sortable ? (
                        <button type="button" className="ui-dtc__th" onClick={() => press(c.key)} aria-label={name} title={name}>
                          <span className="ui-dtc__th-label">{c.label}</span>
                          <span className="ui-dtc__sort" data-dir={dir ?? undefined} aria-hidden="true">
                            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M6 2.5v7M3 6.5l3 3 3-3" />
                            </svg>
                          </span>
                        </button>
                      ) : (
                        <span className="ui-dtc__th-label ui-dtc__th-plain">{c.label}</span>
                      )}
                      {c.help}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                {columns.map((c, i) => {
                  const Cell = rowHeader && i === 0 ? "th" : "td";
                  return (
                    <Cell
                      key={c.key}
                      scope={Cell === "th" ? "row" : undefined}
                      data-align={c.align === "end" ? "end" : undefined}
                      data-mono={c.mono ? "" : undefined}
                      data-nowrap={c.nowrap ? "" : undefined}
                      data-quiet={r.quiet?.includes(c.key) ? "" : undefined}
                      data-lead={c.lead ? "" : undefined}
                      data-plain={c.plain ? "" : undefined}
                    >
                      {/* narrow="stack" prints the column's name before the value; hidden from the table layout and from AT (the header already names it) */}
                      {narrow === "stack" && !c.lead && !c.plain ? (
                        <span className="ui-dtc__cell-label" aria-hidden="true">
                          {c.label}
                        </span>
                      ) : null}
                      <span className="ui-dtc__cell">{r.cells[c.key] ?? null}</span>
                    </Cell>
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
      </ScrollArea>
      {hasFoot ? <div className="ui-dtc__foot">{footer}</div> : null}
    </div>
  );
}
