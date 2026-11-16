"use client";

/* Derived from affectUI Pro 'data-table' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit. */

import "./data-table-readonly.css";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * Data Table (Clean) – FORKED TO READ-ONLY for BiVelio Savings.
 *
 * Upstream is a small spreadsheet: cell selection, in-place editing, copy/paste, undo, row checkboxes, tag pickers
 * and an "add row" footer. Evidence is not editable, and a table that LOOKS editable would say otherwise, so all of
 * that is gone. What stays is the clean card (title row, hairline rows, quiet 12px header labels) and the sortable
 * header with its arrow. What is new:
 *  - a real <table> (upstream is a role="grid" over a presentation table), with `aria-sort` on the sorted column
 *    and a <button> in every sortable header;
 *  - cells are nodes rendered by the caller (already formatted, already localised); sorting uses a separate
 *    `sort` value per cell, and a missing value (null) always sorts last – it is never treated as zero;
 *  - a sticky header when `maxHeight` is set, a sticky first column, and soft edges on the sides that can scroll
 *    (the idea of affectUI's Scroll Area, with the browser's own scrollbar);
 *  - no English: every label, including the sort button's title, arrives through props.
 */

export type ReadColumn = {
  key: string;
  /** Header text */
  label: string;
  /** Something after the label, outside the sort button – e.g. a term with its definition */
  help?: ReactNode;
  align?: "start" | "end";
  /** Renders a sort button in the header; `sortLabel` is its title, e.g. "Sort by cost" */
  sortable?: boolean;
  sortLabel?: string;
  /** Any CSS width, e.g. "28%" */
  width?: string;
};

export type ReadRow = {
  id: string;
  cells: Record<string, ReactNode>;
  /** Values to sort by, per column key. null = no data (sorts last in both directions) */
  sort?: Record<string, number | string | null>;
};

export type ReadSort = { key: string; dir: "asc" | "desc" };

export type DataTableReadonlyProps = {
  /** Visible title of the card */
  title?: ReactNode;
  /** A quiet line under the title: what the table is and how to read it */
  description?: ReactNode;
  /** Slot at the right of the head: an evidence badge, a count */
  aside?: ReactNode;
  /** Accessible name of the table when there is no visible title */
  label?: string;
  columns: ReadColumn[];
  rows: ReadRow[];
  defaultSort?: ReadSort;
  /** Locale for comparing text */
  locale?: string;
  /** With a max height the body scrolls and the header stays in view */
  maxHeight?: string;
  /** Min width of the table before it scrolls sideways */
  minWidth?: string;
  /** The line on the last row of the card: a note, a link */
  footer?: ReactNode;
  headingAs?: "h2" | "h3" | "h4";
  className?: string;
};

export function DataTableReadonly({
  title,
  description,
  aside,
  label,
  columns,
  rows,
  defaultSort,
  locale,
  maxHeight,
  minWidth,
  footer,
  headingAs: Heading = "h3",
  className,
}: DataTableReadonlyProps) {
  const [sort, setSort] = useState<ReadSort | null>(defaultSort ?? null);
  const scroller = useRef<HTMLDivElement>(null);

  const view = useMemo(() => {
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

  // Soft edges only on the sides that can still scroll
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const fades = () => {
      const max = s.scrollWidth - s.clientWidth;
      s.toggleAttribute("data-fade-start", s.scrollLeft > 1);
      s.toggleAttribute("data-fade-end", s.scrollLeft < max - 1);
    };
    fades();
    s.addEventListener("scroll", fades, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fades);
    ro?.observe(s);
    return () => {
      s.removeEventListener("scroll", fades);
      ro?.disconnect();
    };
  }, []);

  const toggle = (key: string) => setSort((s) => ({ key, dir: s?.key === key && s.dir === "desc" ? "asc" : "desc" }));

  return (
    <section className={["ui-dtr", className].filter(Boolean).join(" ")}>
      {(title || description || aside) && (
        <header className="ui-dtr__head">
          <div className="ui-dtr__heading">
            {title ? <Heading className="ui-dtr__title">{title}</Heading> : null}
            {description ? <p className="ui-dtr__desc">{description}</p> : null}
          </div>
          {aside ? <div className="ui-dtr__aside">{aside}</div> : null}
        </header>
      )}
      <div className="ui-dtr__body">
        {/* Focusable, so a keyboard can scroll it sideways */}
        <div className="ui-dtr__scroll" ref={scroller} style={maxHeight ? { maxHeight } : undefined} data-sticky={maxHeight ? "" : undefined} tabIndex={0} role="group" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
          <table className="ui-dtr__table" style={minWidth ? { minWidth } : undefined}>
            <colgroup>
              {columns.map((c) => (
                <col key={c.key} style={c.width ? { width: c.width } : undefined} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((c) => {
                  const dir = sort?.key === c.key ? sort.dir : null;
                  return (
                    <th key={c.key} scope="col" data-align={c.align ?? "start"} aria-sort={c.sortable ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}>
                      <span className="ui-dtr__th-in">
                        {c.sortable ? (
                          <button type="button" className="ui-dtr__th" title={c.sortLabel} onClick={() => toggle(c.key)}>
                            <span className="ui-dtr__th-label">{c.label}</span>
                            <span className="ui-dtr__sort" data-dir={dir ?? undefined} aria-hidden="true">
                              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M6 2.5v7M3 6.5l3 3 3-3" />
                              </svg>
                            </span>
                          </button>
                        ) : (
                          <span className="ui-dtr__th-label ui-dtr__th-plain">{c.label}</span>
                        )}
                        {c.help}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <tr key={r.id}>
                  {columns.map((c, i) =>
                    i === 0 ? (
                      <th key={c.key} scope="row" data-align={c.align ?? "start"}>
                        {r.cells[c.key]}
                      </th>
                    ) : (
                      <td key={c.key} data-align={c.align ?? "start"}>
                        {r.cells[c.key]}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {footer ? <footer className="ui-dtr__foot">{footer}</footer> : null}
    </section>
  );
}
