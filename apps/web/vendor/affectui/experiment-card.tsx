/*
 * Derived from affectUI Pro 'Experiment Card' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/*
 * Experiment Card – an A/B test in two lines that quietly unfolds into the full comparison, in one self-contained file.
 * Closed, it shows the test, its status and who is ahead, next to a tiny column chart with one column per variant.
 * Hovering (or tapping) unfolds the variants below – the head stays where it is. Inside the open card:
 *   · hover a variant and its column lights up in the head (and the other way round)
 *   · switch the metric and every number rolls, the bars and columns glide, the leader chip follows
 *   · click a variant to pick it as the winner – the action on the tray appears with its name
 *   · the line on the gray tray always says what you are pointing at: visitors and confidence
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

export type ExperimentTone = "red" | "amber" | "green" | "blue" | "violet" | "gray";

export type ExperimentMetric = {
  id: string;
  label: string;
  /** Formats a value of this metric, e.g. (n) => `${n.toFixed(1)}%` */
  format?: (value: number) => string;
  /** Set when a smaller number wins, e.g. bounce rate or cost */
  lowerIsBetter?: boolean;
};

export type ExperimentVariant = {
  id: string;
  /** Short key shown in the badge and the chart, e.g. "A" */
  key: string;
  name: string;
  /** The baseline every lift is measured against – defaults to the first variant */
  control?: boolean;
  visitors?: number;
  /** One number per metric id */
  values: Record<string, number>;
  /** Confidence against the control in percent, per metric id */
  confidence?: Record<string, number>;
  /** Any CSS color – defaults to gray for the control, then blue, violet, amber */
  color?: string;
};

export type ExperimentCardProps = {
  title: string;
  variants: ExperimentVariant[];
  metrics: ExperimentMetric[];
  /** Controlled metric id */
  metric?: string;
  defaultMetric?: string;
  onMetricChange?: (id: string) => void;
  /** Controlled id of the variant picked as the winner */
  winner?: string | null;
  defaultWinner?: string | null;
  onWinnerChange?: (id: string | null) => void;
  /** The tag under the title, e.g. { label: "Running", tone: "green" } */
  status?: { label: string; tone?: ExperimentTone };
  /** Short text next to the status, e.g. "Day 9 of 14" */
  note?: string;
  /** The button that appears on the tray once a winner is picked. `label` gets the picked variant */
  action?: { label: string | ((variant: ExperimentVariant) => string); onClick: (variant: ExperimentVariant) => void };
  /** Replaces the line on the tray while nothing is hovered or picked */
  hint?: ReactNode;
  /** "hover" opens under the pointer (taps and the keyboard still toggle), "click" only on click */
  trigger?: "hover" | "click";
  /** Controlled open state */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** BiVelio: every visible and spoken string, translated by the caller – the kit ships no English text */
  labels: ExperimentCardLabels;
  /** BiVelio: locale for the numbers the card formats itself (lift, visitors). Pass the page locale explicitly */
  locale: string;
  className?: string;
};

export type ExperimentCardLabels = {
  /** Tray line while nothing is hovered or picked, e.g. "Pick a winner" */
  pickWinner: string;
  /** Chip in the head while no variant leads, e.g. "No lift yet" */
  noLift: string;
  /** Lift cell of the control row, e.g. "Base" */
  base: string;
  /** Tray: "baseline" */
  baseline: string;
  /** Tray: (formatted count, raw count) => "1,204 visitors" */
  visitors: (formatted: string, count: number) => string;
  /** Tray: (formatted percent) => "96% confidence" */
  confidence: (percent: string) => string;
  /** Tray: (variant name) => "Variant B picked" */
  picked: (name: string) => string;
  /** Group name of the metric switch */
  metric: string;
  /** Group name of the variant rows */
  winner: string;
  /** Spoken: (variant name, formatted percent) => "B is ahead by 4.2 percent" */
  ahead: (name: string, percent: string) => string;
  /** Spoken: a variant without a value */
  noValue: string;
  /** Spoken: (formatted percent, is it up?) => "up 4.2 percent" */
  change: (percent: string, up: boolean) => string;
};

/* ---------- Helpers ---------- */

const PALETTE = ["var(--ui-xc-c1)", "var(--ui-xc-c2)", "var(--ui-xc-c3)", "var(--ui-xc-c4)"];
/** BiVelio: the three number formats, built per locale instead of the upstream fixed "en-US" */
const formatsFor = (locale: string) => {
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const round = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return {
    defaultFormat: (n: number) => plain.format(n),
    whole: (n: number) => round.format(n),
    tenth: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  };
};
/** NaN and Infinity count as "no value" */
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const ease = (t: number) => 1 - Math.pow(1 - t, 4);
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rolls a set of named numbers from where they are to their targets, in one animation frame loop */
function useRolling(target: Record<string, number>, duration: number) {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const signature = JSON.stringify(target);
  useEffect(() => {
    const to = JSON.parse(signature) as Record<string, number>;
    const from = { ...current.current };
    if (reduced() || Object.keys(to).every((k) => from[k] === to[k])) {
      current.current = to;
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const next: Record<string, number> = {};
      for (const k in to) next[k] = (from[k] ?? to[k]) + (to[k] - (from[k] ?? to[k])) * e;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [signature, duration]);
  return shown;
}

/* ---------- Icons ---------- */

const line = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="m2.2 5.2 1.9 1.9 3.7-4.1" {...line} strokeWidth={1.7} />
  </svg>
);
const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 6h7M6.5 3l3 3-3 3" {...line} strokeWidth={1.4} />
  </svg>
);
const TrendIcon = ({ down }: { down?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={down ? { transform: "scaleY(-1)" } : undefined}>
    <path d="M1.5 7 4 4.5l1.6 1.6L8.5 3M6.2 3h2.3v2.3" {...line} strokeWidth={1.4} />
  </svg>
);
const PulseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.25" {...line} />
    <circle cx="6" cy="6" r="1.5" fill="currentColor" />
  </svg>
);

export function ExperimentCard({
  title,
  variants,
  metrics,
  metric,
  defaultMetric,
  onMetricChange,
  winner,
  defaultWinner = null,
  onWinnerChange,
  status,
  note,
  action,
  hint,
  trigger = "hover",
  open,
  defaultOpen = false,
  onOpenChange,
  labels,
  locale,
  className,
}: ExperimentCardProps) {
  const { defaultFormat, whole, tenth } = useMemo(() => formatsFor(locale), [locale]);
  const uid = useId();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const [innerMetric, setInnerMetric] = useState(defaultMetric ?? metrics[0]?.id);
  const metricNow = metrics.find((m) => m.id === (metric ?? innerMetric)) ?? metrics[0];
  const [innerWinner, setInnerWinner] = useState<string | null>(defaultWinner);
  const winnerId = winner !== undefined ? winner : innerWinner;
  /** The variant under the pointer (row or column) */
  const [hot, setHot] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const format = metricNow?.format ?? defaultFormat;
  const lower = Boolean(metricNow?.lowerIsBetter);
  const has = (v: ExperimentVariant) => finite(v.values[metricNow?.id ?? ""]);
  const valueOf = (v: ExperimentVariant) => (has(v) ? v.values[metricNow?.id ?? ""] : 0);
  const control = variants.find((v) => v.control) ?? variants[0];
  const base = control && has(control) ? valueOf(control) : 0;
  /** Change against the control in percent, as measured – null without a value or a baseline to compare with */
  const changeOf = (v: ExperimentVariant) => (has(v) && base ? ((valueOf(v) - base) / Math.abs(base)) * 100 : null);
  /** The same change counted as "how much better": flipped for metrics where less is better */
  const liftOf = (v: ExperimentVariant) => {
    const change = changeOf(v);
    return change === null ? null : change * (lower ? -1 : 1);
  };
  const signed = (n: number) => {
    const r = Math.round(n * 10) / 10;
    return `${r >= 0 ? "+" : "−"}${tenth.format(Math.abs(r))}%`;
  };
  const leader = variants.reduce<ExperimentVariant | undefined>((best, v) => (!best || (liftOf(v) ?? -Infinity) > (liftOf(best) ?? -Infinity) ? v : best), undefined);
  const known = variants.filter(has).map(valueOf);
  const max = Math.max(...known, 0.0001);
  const min = known.length ? Math.min(...known) : 0;
  /** Column height in the head chart: stretched between the smallest and the largest value, so small gaps stay visible */
  const columnOf = (v: ExperimentVariant) => (!has(v) ? 0.1 : max > min ? 0.38 + 0.62 * ((valueOf(v) - min) / (max - min)) : 0.7);
  const colorOf = (v: ExperimentVariant) => v.color ?? (v === control ? "var(--ui-xc-c0)" : PALETTE[variants.filter((x) => x !== control).indexOf(v) % PALETTE.length]);

  // Numbers roll when the metric changes
  const shown = useRolling(Object.fromEntries(variants.map((v) => [v.id, valueOf(v)])), 620);

  /* ---------- Opening and closing ---------- */

  const timer = useRef(0);
  const change = (next: boolean) => {
    window.clearTimeout(timer.current);
    if (next === isOpen) return;
    if (!next) setHot(null);
    setInnerOpen(next);
    onOpenChange?.(next);
  };
  const later = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => change(next), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hover = trigger === "hover";
  const onEnter = (e: PointerEvent) => {
    if (hover && e.pointerType === "mouse") later(true, 90);
  };
  const onLeave = (e: PointerEvent) => {
    if (hover && e.pointerType === "mouse") later(false, 220);
  };

  // While open, a press outside closes it
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) change(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !isOpen) return;
    e.stopPropagation();
    change(false);
    rootRef.current?.querySelector<HTMLElement>(".ui-xc__toggle")?.focus({ preventScroll: true });
  };

  /* ---------- Metric switch ---------- */

  const switchRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = switchRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!el) return;
    setPill({ left: el.offsetLeft, width: el.offsetWidth });
    // Many or long metrics scroll sideways – keep the chosen one in view
    const sw = switchRef.current!;
    if (el.offsetLeft < sw.scrollLeft) sw.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > sw.scrollLeft + sw.clientWidth) sw.scrollLeft = el.offsetLeft + el.offsetWidth - sw.clientWidth;
  }, [metricNow?.id, metrics.length, isOpen]);

  const setMetric = (id: string) => {
    setInnerMetric(id);
    onMetricChange?.(id);
  };
  const onSwitchKey = (e: KeyboardEvent) => {
    const i = metrics.findIndex((m) => m.id === metricNow?.id);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? metrics.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = metrics[(to + metrics.length) % metrics.length];
    setMetric(next.id);
    requestAnimationFrame(() => switchRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  const pick = (id: string) => {
    const next = winnerId === id ? null : id;
    setInnerWinner(next);
    onWinnerChange?.(next);
  };

  /* ---------- What the head and the tray say ---------- */

  const ahead = leader && leader !== control && (liftOf(leader) ?? 0) > 0 ? leader : null;
  const aheadChange = ahead ? (changeOf(ahead) ?? 0) : 0;
  const picked = variants.find((v) => v.id === winnerId) ?? null;
  const hotVariant = variants.find((v) => v.id === hot) ?? null;
  const about = hotVariant ?? null;
  let caption: ReactNode = hint ?? (picked ? null : labels.pickWinner);
  let captionKey = "rest";
  if (about) {
    const conf = about.confidence?.[metricNow?.id ?? ""];
    caption = (
      <>
        <b>{about.key}</b>
        {finite(about.visitors) && (
          <>
            {" "}· {labels.visitors(whole(about.visitors), about.visitors)}
          </>
        )}
        {about === control ? <> · {labels.baseline}</> : finite(conf) && <> · {labels.confidence(whole(conf))}</>}
      </>
    );
    captionKey = `hot-${about.id}-${metricNow?.id}`;
  } else if (picked) {
    caption = (
      <b>{labels.picked(picked.name)}</b>
    );
    captionKey = `picked-${picked.id}`;
  }
  const actionLabel = picked && action ? (typeof action.label === "function" ? action.label(picked) : action.label) : null;

  return (
    <div
      ref={rootRef}
      className={["ui-xc", className].filter(Boolean).join(" ")}
      data-open={isOpen ? "" : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={onKeyDown}
    >

      <div className="ui-xc__card">
        <div className="ui-xc__head">
          {/* The whole head toggles; the chart on top of it only reacts once the card is open */}
          <button
            type="button"
            className="ui-xc__toggle"
            aria-expanded={isOpen}
            aria-controls={`${uid}-body`}
            aria-label={`${title}${status ? `, ${status.label}` : ""}${ahead ? `, ${labels.ahead(ahead.name, tenth.format(Math.abs(aheadChange)))}` : ""}`}
            onClick={() => change(!isOpen)}
          />

          {/* One column per variant – the same numbers as the rows below, small */}
          <span className="ui-xc__chart" aria-hidden="true" data-many={variants.length > 5 ? "" : undefined} onPointerLeave={() => setHot(null)}>
            {variants.map((v) => (
              <span
                key={v.id}
                className="ui-xc__col"
                data-hot={hot === v.id ? "" : undefined}
                data-dim={hot && hot !== v.id ? "" : undefined}
                data-picked={winnerId === v.id ? "" : undefined}
                data-passed={winnerId && winnerId !== v.id ? "" : undefined}
                style={{ ["--ui-xc-color" as string]: colorOf(v), ["--ui-xc-size" as string]: columnOf(v) }}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHot(v.id)}
                onClick={() => pick(v.id)}
              />
            ))}
          </span>

          <span className="ui-xc__titles">
            <span className="ui-xc__name" dir="auto" title={title}>
              {title}
            </span>
            <span className="ui-xc__sub">
              {status && (
                <span className="ui-xc__tag" data-tone={status.tone ?? "gray"} title={status.label}>
                  <PulseIcon />
                  <span className="ui-xc__tag-text">{status.label}</span>
                </span>
              )}
              {note && (
                <span className="ui-xc__note" dir="auto" title={note}>
                  {note}
                </span>
              )}
            </span>
          </span>

          {ahead ? (
            <span className="ui-xc__lead" data-tone="green" key={`${ahead.id}-${metricNow?.id}`}>
              <b>{ahead.key}</b>
              <TrendIcon down={aheadChange < 0} />
              {signed(aheadChange)}
            </span>
          ) : (
            <span className="ui-xc__lead" data-tone="gray" key={`none-${metricNow?.id}`}>
              {labels.noLift}
            </span>
          )}
        </div>

        <div id={`${uid}-body`} className="ui-xc__fold" inert={!isOpen}>
          <div className="ui-xc__clip">
            <div className="ui-xc__body">
              {metrics.length > 1 && (
                <div ref={switchRef} className="ui-xc__switch" role="radiogroup" aria-label={labels.metric} onKeyDown={onSwitchKey}>
                  {pill && <span className="ui-xc__thumb" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
                  {metrics.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={m.id === metricNow?.id}
                      tabIndex={m.id === metricNow?.id ? 0 : -1}
                      className="ui-xc__metric"
                      onClick={() => setMetric(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="ui-xc__rows" role="radiogroup" aria-label={labels.winner} onPointerLeave={() => setHot(null)}>
                {variants.map((v) => {
                  const lift = liftOf(v);
                  const change = changeOf(v);
                  const isControl = v === control;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={winnerId === v.id}
                      aria-label={`${v.name}: ${has(v) ? format(valueOf(v)) : labels.noValue}${isControl ? `, ${labels.baseline}` : change === null ? "" : `, ${labels.change(tenth.format(Math.abs(change)), change >= 0)}`}`}
                      className="ui-xc__row"
                      data-hot={hot === v.id ? "" : undefined}
                      data-dim={hot && hot !== v.id ? "" : undefined}
                      style={{ ["--ui-xc-color" as string]: colorOf(v) }}
                      onPointerEnter={(e) => e.pointerType === "mouse" && setHot(v.id)}
                      onFocus={() => setHot(v.id)}
                      onBlur={() => setHot(null)}
                      onClick={() => pick(v.id)}
                    >
                      <span className="ui-xc__badge">
                        <span title={v.key}>{v.key}</span>
                        <CheckIcon />
                      </span>
                      <span className="ui-xc__label" dir="auto" title={v.name}>
                        {v.name}
                      </span>
                      <span className="ui-xc__value">{has(v) ? format(shown[v.id] ?? valueOf(v)) : "—"}</span>
                      {isControl ? (
                        <span className="ui-xc__lift" data-tone="gray">
                          {labels.base}
                        </span>
                      ) : (
                        <span className="ui-xc__lift" data-tone={lift === null ? "gray" : lift > 0.05 ? "green" : lift < -0.05 ? "red" : "gray"}>
                          {change === null ? "—" : signed(change)}
                        </span>
                      )}
                      <span className="ui-xc__track">
                        <span className="ui-xc__bar" style={{ transform: `scaleX(${has(v) ? Math.max(0.02, valueOf(v) / max) : 0.02})` }} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The tray: it says what you are pointing at, and holds the action once a winner is picked */}
      <div className="ui-xc__fold" inert={!isOpen}>
        <div className="ui-xc__clip">
          <div className="ui-xc__foot">
            <span className="ui-xc__caption" aria-live="polite">
              <span key={captionKey}>{caption}</span>
            </span>
            {picked && action && (
              <button type="button" className="ui-xc__action" key={picked.id} title={actionLabel ?? undefined} onClick={() => action.onClick(picked)}>
                <span className="ui-xc__action-text">{actionLabel}</span>
                <ArrowIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
