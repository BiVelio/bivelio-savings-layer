/*
 * Derived from affectUI Pro 'kpi-chart' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./kpi-chart.css";

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/*
 * KPI Chart – a metric card with a multi-line chart and a hover tooltip.
 * BiVelio fork: a value that is missing is `null` and STAYS a gap (never a zero, never a line through it); there is
 * no "change against the previous period"; every string arrives localized; a series can be dashed, can be left out
 * of the drawing (`tooltipOnly`, e.g. a difference) and two series can carry a tinted band between them.
 */

export type KpiSeries = {
  label: string;
  /** Line color, any CSS color */
  color: string;
  /** One value per label; `null` = no reading that day */
  values: (number | null)[];
  dashed?: boolean;
  /** Not drawn: only a row in the tooltip (shown last, in ink) */
  tooltipOnly?: boolean;
};

export type KpiChartProps = {
  title: string;
  /** Headline value, already formatted */
  value?: string;
  /** What the headline value is, in words */
  caption?: string;
  /** Top-right slot, e.g. an evidence badge */
  aside?: ReactNode;
  labels: string[];
  tooltipLabels?: string[];
  series: KpiSeries[];
  /** Tints the area between these two series (indexes) where both have a value */
  band?: { between: [number, number]; color: string; label: string };
  format: (n: number) => string;
  footer?: ReactNode;
  /** Accessible name of the plot, e.g. "… – use the arrow keys to read each day" */
  plotLabel: string;
  /** Quiet text in the plot when there is nothing to draw */
  emptyText: string;
  /** Tooltip line for a day without a reading */
  gapText: string;
  className?: string;
  style?: CSSProperties;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Rounds the top of the axis up to a value that halves cleanly */
function niceMax(max: number) {
  if (!finite(max) || max <= 0) return 1;
  const half = max / 2;
  const pow = 10 ** Math.floor(Math.log10(half));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * pow >= half) ?? 10;
  return step * pow * 2;
}

export function KpiChart({
  title,
  value,
  caption,
  aside,
  labels = [],
  tooltipLabels,
  series = [],
  band,
  format,
  footer,
  plotLabel,
  emptyText,
  gapText,
  className,
  style,
}: KpiChartProps) {
  const count = labels.length;
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, Math.round(i)));
  const [hover, setHover] = useState<number | null>(null);
  const vals = useMemo(() => series.map((s) => (s.values ?? []).slice(0, count).map((v) => (finite(v) ? v : null))), [series, count]);
  const drawn = series.map((s, k) => ({ s, k })).filter(({ s }) => !s.tooltipOnly);
  const all = drawn.flatMap(({ k }) => vals[k] ?? []).filter(finite);
  const empty = count === 0 || all.length === 0;
  const active = empty ? null : hover;
  // The tooltip keeps its last content while it fades out
  const [shown, setShown] = useState(0);
  if (active !== null && active !== shown) setShown(active);
  const cur = Math.min(shown, Math.max(0, count - 1));
  const max = niceMax(Math.max(0, ...all));
  const low = Math.min(0, ...all);
  const min = low < 0 ? -niceMax(-low) : 0;
  const x = (i: number) => (count > 1 ? (i / (count - 1)) * 100 : 50);
  const y = (v: number) => ((max - v) / (max - min)) * 100;

  // A gap where a value is missing, instead of a line through it
  const paths = vals.map((vs) => {
    let d = "";
    vs.forEach((v, i) => {
      if (v === null) return;
      d += `${d && vs[i - 1] !== null && vs[i - 1] !== undefined ? "L" : "M"}${x(i)},${y(v)}`;
    });
    return d;
  });
  // A point with no neighbour draws no line – it gets a dot
  const lone = drawn.flatMap(({ k }) =>
    (vals[k] ?? []).flatMap((v, i, vs) => (v !== null && (vs[i - 1] ?? null) === null && (vs[i + 1] ?? null) === null ? [{ k, i, v }] : [])),
  );
  // The band: one closed shape per run of days where BOTH series have a value
  const bands: string[] = [];
  if (band) {
    const a = vals[band.between[0]] ?? [];
    const b = vals[band.between[1]] ?? [];
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        const top = run.map((i) => `${x(i)},${y(a[i] as number)}`).join(" L");
        const bottom = [...run].reverse().map((i) => `${x(i)},${y(b[i] as number)}`).join(" L");
        bands.push(`M${top} L${bottom} Z`);
      }
      run = [];
    };
    for (let i = 0; i < count; i++) {
      if (finite(a[i]) && finite(b[i])) run.push(i);
      else flush();
    }
    flush();
  }

  const indexAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    return clamp(ratio * (count - 1));
  };
  const onKey = (e: KeyboardEvent) => {
    if (empty) return;
    const from = active ?? (e.key === "ArrowLeft" ? count : -1);
    if (e.key === "ArrowRight") setHover(Math.min(count - 1, from + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(0, from - 1));
    else if (e.key === "Home") setHover(0);
    else if (e.key === "End") setHover(count - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const rows = series.map((s, k) => ({ ...s, key: k, value: vals[k]?.[cur] ?? null }));
  const dayHasData = rows.some((r) => r.value !== null);
  const flip = x(cur) > 50;

  // The tooltip stays inside the card
  const rootRef = useRef<HTMLElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const plot = plotRef.current;
    const tip = tipRef.current;
    if (!root || !plot || !tip || active === null) return;
    const card = root.getBoundingClientRect();
    const box = plot.getBoundingClientRect();
    const w = tip.offsetWidth;
    const anchor = box.left + (x(cur) / 100) * box.width;
    const left = flip ? anchor - 14 - w : anchor + 14;
    const lo = card.left + 8;
    const hi = card.right - 8 - w;
    const next = Math.round(left < lo ? lo - left : left > hi ? Math.max(lo, hi) - left : 0);
    if (next !== nudge) setNudge(next);
  });
  const axis = count === 0 ? [] : [0, Math.round(count / 2 - 0.5), count - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <section className={["ui-kpic", className].filter(Boolean).join(" ")} style={style} ref={rootRef}>
      <div className="ui-kpic__body">
        <div className="ui-kpic__head">
          <h3 className="ui-kpic__title" dir="auto">
            {title}
          </h3>
          {aside ? <div className="ui-kpic__aside">{aside}</div> : null}
        </div>
        {value ? (
          <p className="ui-kpic__value">
            <span className="ui-kpic__amount">{value}</span>
            {caption ? <span className="ui-kpic__caption">{caption}</span> : null}
          </p>
        ) : null}

        {!empty && (
          <ul className="ui-kpic__legend">
            {drawn.map(({ s, k }) => (
              <li key={k}>
                <span className="ui-kpic__key" data-dashed={s.dashed || undefined} style={{ ["--ui-kpic-k" as string]: s.color }} aria-hidden="true" />
                {s.label}
              </li>
            ))}
            {band ? (
              <li>
                <span className="ui-kpic__key" data-band="" style={{ ["--ui-kpic-k" as string]: band.color }} aria-hidden="true" />
                {band.label}
              </li>
            ) : null}
          </ul>
        )}

        <div className="ui-kpic__chart">
          <div className="ui-kpic__yaxis" aria-hidden="true">
            {!empty && (
              <>
                <span>{format(max)}</span>
                <span>{format((max + min) / 2)}</span>
                <span>{format(min)}</span>
              </>
            )}
          </div>

          <div
            className="ui-kpic__plot"
            tabIndex={empty ? undefined : 0}
            role="group"
            aria-label={empty ? `${title} – ${emptyText}` : plotLabel}
            data-empty={empty || undefined}
            ref={plotRef}
            onPointerMove={(e) => setHover(indexAt(e))}
            onPointerDown={(e) => setHover(indexAt(e))}
            onPointerLeave={(e) => {
              if (e.pointerType !== "touch") setHover(null);
            }}
            onBlur={() => setHover(null)}
            onKeyDown={onKey}
          >
            <span className="ui-kpic__grid" style={{ top: "0%" }} />
            <span className="ui-kpic__grid" style={{ top: "50%" }} />
            <span className="ui-kpic__grid" style={{ top: "100%" }} />

            {empty && <p className="ui-kpic__empty">{emptyText}</p>}

            <svg className="ui-kpic__lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {bands.map((d, i) => (
                <path key={`b${i}`} className="ui-kpic__band" d={d} style={{ ["--ui-kpic-band" as string]: band?.color }} />
              ))}
              {drawn.map(({ s, k }) => (
                <path key={k} d={paths[k]} stroke={s.color} data-dashed={s.dashed || undefined} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            {lone.map((p) => (
              <span
                key={`${p.k}-${p.i}`}
                className="ui-kpic__point"
                style={{ left: `${x(p.i)}%`, top: `${y(p.v)}%`, background: series[p.k]?.color }}
                aria-hidden="true"
              />
            ))}

            <div className="ui-kpic__marker" data-open={active !== null || undefined} aria-hidden="true">
              <span className="ui-kpic__guide" style={{ left: `${x(cur)}%` }} />
              {drawn.map(({ s, k }) => {
                const v = vals[k]?.[cur];
                return v === null || v === undefined ? null : (
                  <span key={k} className="ui-kpic__dot" style={{ left: `${x(cur)}%`, top: `${y(v)}%`, background: s.color }} />
                );
              })}
            </div>

            <div
              className="ui-kpic__tooltip"
              data-open={active !== null || undefined}
              data-side={flip ? "left" : "right"}
              ref={tipRef}
              style={{ left: `${x(cur)}%`, ["--ui-kpic-nudge" as string]: `${nudge}px` }}
              role="status"
              aria-live="polite"
            >
              {active !== null && (
                <>
                  <p className="ui-kpic__date">{(tooltipLabels ?? labels)[cur]}</p>
                  {dayHasData ? (
                    <ul>
                      {rows.map((r) =>
                        r.value === null ? null : (
                          <li key={r.key} data-total={r.tooltipOnly || undefined}>
                            <span className="ui-kpic__swatch" style={{ background: r.color }} />
                            <span className="ui-kpic__label" dir="auto">
                              {r.label}
                            </span>
                            <span className="ui-kpic__num">{format(r.value)}</span>
                          </li>
                        ),
                      )}
                    </ul>
                  ) : (
                    <p className="ui-kpic__gap">{gapText}</p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="ui-kpic__xaxis" aria-hidden="true">
            {axis.map((i) => (
              <span key={i} style={{ left: `${x(i)}%` }} data-edge={i === 0 ? "start" : i === count - 1 ? "end" : undefined}>
                {labels[i]}
              </span>
            ))}
          </div>
        </div>
      </div>

      {footer ? (
        <p className="ui-kpic__footer" dir="auto">
          {footer}
        </p>
      ) : null}
    </section>
  );
}
