/*
 * Derived from affectUI Pro 'KPI Board' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./kpi-board.css";
import type { ReactNode } from "react";

/*
 * KPI Board – the row under a dashboard headline: small stat cards with one shared look (label, figure, a thin
 * angular line over a quiet fill) and a focus card that names one thing to do next.
 *
 * BiVelio: the COMPOSITION only, static and server-rendered. Upstream owns the date range, aggregates its own series,
 * treats anything non-numeric as zero, compares against a previous period and rolls every number on change. None of
 * that is here: the caller passes figures ALREADY FORMATTED with their unit and base in words, a stat without data is
 * told so with `empty` (never a zero), there is no "vs. last period", no overview chart (the page keeps its own
 * explorer) and nothing animates. The optional line is decoration of real daily values and stays out of the
 * accessibility tree. Every string arrives through props.
 */

export type KpiStatProps = {
  label: string;
  /** The figure as text, already formatted (currency, locale). Omit it when there is no data. */
  value?: string;
  /** What is counted and over which base and period, in words. */
  base?: ReactNode;
  /** Why there is no figure. Shown instead of a number – a missing value is never zero. */
  empty?: string;
  /** A small slot next to the label: where the figure comes from (an evidence badge). */
  badge?: ReactNode;
  /** Colour of the figure. The label and the base already say what it is. */
  tone?: "neutral" | "good" | "bad";
  /** Real values, oldest first, drawn as a thin line. A gap in the data is `null`, never 0. Decorative. */
  series?: (number | null)[];
};

export type KpiFocusProps = {
  /** A small label above the title. */
  eyebrow?: string;
  title: string;
  note?: ReactNode;
  icon?: ReactNode;
  /** One or two links or buttons, rendered by the caller. */
  action?: ReactNode;
  /** Heading level of the title. */
  headingAs?: "h2" | "h3" | "h4";
  children?: ReactNode;
};

const W = 240;
const H = 48;

/** The thin angular line of the board. Returns null when fewer than two real points exist. */
function linePaths(series: (number | null)[]): { line: string; fill: string } | null {
  const points = series.map((v, i) => (typeof v === "number" && Number.isFinite(v) ? { i, v } : null));
  const real = points.filter((p): p is { i: number; v: number } => p !== null);
  if (real.length < 2) return null;
  const min = Math.min(...real.map((p) => p.v));
  const max = Math.max(...real.map((p) => p.v));
  const span = max - min || 1;
  const x = (i: number) => (series.length > 1 ? (i / (series.length - 1)) * W : 0);
  const y = (v: number) => H - 3 - ((v - min) / span) * (H - 8);
  let line = "";
  let fill = "";
  let run: { i: number; v: number }[] = [];
  const flush = () => {
    if (run.length > 1) {
      const d = run.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
      line += `${d} `;
      fill += `${d} L${x(run[run.length - 1]!.i).toFixed(1)} ${H} L${x(run[0]!.i).toFixed(1)} ${H} Z `;
    }
    run = [];
  };
  // A missing day breaks the line: it is not drawn down to zero
  for (const p of points) {
    if (p) run.push(p);
    else flush();
  }
  flush();
  return line ? { line: line.trim(), fill: fill.trim() } : null;
}

export function KpiBoard({ children, className, label }: { children: ReactNode; className?: string; /** Accessible name of the group. */ label: string }) {
  return (
    <div className={["ui-kb", className].filter(Boolean).join(" ")} role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function KpiStat({ label, value, base, empty, badge, tone = "neutral", series }: KpiStatProps) {
  const paths = value !== undefined && series ? linePaths(series) : null;
  return (
    <div className="ui-kb__card ui-kb__stat" data-empty={value === undefined ? "" : undefined}>
      <div className="ui-kb__row">
        <span className="ui-kb__label">{label}</span>
        {badge ? <span className="ui-kb__badge">{badge}</span> : null}
      </div>
      {value !== undefined ? (
        <p className="ui-kb__figure" data-tone={tone}>
          {value}
        </p>
      ) : (
        <>
          <p className="ui-kb__figure" data-tone="empty" aria-hidden="true">
            —
          </p>
          {empty ? <p className="ui-kb__empty">{empty}</p> : null}
        </>
      )}
      {base ? <p className="ui-kb__base">{base}</p> : null}
      {paths ? (
        <div className="ui-kb__plot" aria-hidden="true">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" focusable="false">
            <path className="ui-kb__fill" d={paths.fill} />
            <path className="ui-kb__line" d={paths.line} />
          </svg>
        </div>
      ) : null}
    </div>
  );
}

export function KpiFocus({ eyebrow, title, note, icon, action, headingAs: Heading = "h3", children }: KpiFocusProps) {
  return (
    <div className="ui-kb__card ui-kb__focus">
      <div className="ui-kb__product">
        {icon ? (
          <span className="ui-kb__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="ui-kb__head">
          {eyebrow ? <p className="ui-kb__label">{eyebrow}</p> : null}
          <Heading className="ui-kb__title" dir="auto">
            {title}
          </Heading>
        </div>
      </div>
      {note ? <div className="ui-kb__note">{note}</div> : null}
      {children}
      {action ? <div className="ui-kb__actions">{action}</div> : null}
    </div>
  );
}
