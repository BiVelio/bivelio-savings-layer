/*
 * Derived from affectUI Pro 'Usage Meter' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */

import { createElement, type ReactNode } from "react";

/*
 * Usage Meter (clean style) – BiVelio: FORKED TO ONE READING, seats in use against seats contracted, and ONE meter
 * for the two screens that show it (the account and the Machines card). A seat is a machine or a service identity,
 * and the caller says so in `unit`; this card never talks about credits.
 * What is kept from upstream: the head with a quiet second line, the big figure with its share as a small tag, the
 * 8px bar and the legend rows with a swatch. What is gone: credits and categories, the period switch, the daily
 * sparkline, plan limits, "resets in N days", the upgrade button, the 80% warning and every count-in animation –
 * none of those exist in this product, and a figure that rolls up from zero would show a zero that was never
 * measured. Server component: no state, no script.
 *   · The bar is drawn from the two raw readings (`used`, `limit`): one slot per seat while they fit, one
 *     continuous fill otherwise; what is above the contracted amount is its own, amber part.
 *   · A missing reading (`figure` omitted) draws NO bar at all and prints the caller's reason instead. Never a zero.
 *   · The state is decided by the caller and also said in words (`stateLabel`, the notice next to it), never by
 *     colour alone. Using every seat ("full") and going over ("over") are notices, in amber – neither is an error.
 */

export type UsageMeterState = "ok" | "full" | "over";

export type UsageMeterRow = {
  label: ReactNode;
  value: ReactNode;
  /** used: the filled part · free: the empty track · over: above what is contracted · plain: no swatch */
  swatch?: "used" | "free" | "over" | "plain";
};

export type UsageMeterProps = {
  title: ReactNode;
  headingAs?: "h2" | "h3" | "h4" | "p";
  /** The unit being counted, next to the title – e.g. "Machines or service identities" */
  unit?: ReactNode;
  /** The big number, already formatted. Leave out when it could not be measured */
  figure?: ReactNode;
  /** What the big number is, e.g. "In use this month" or "of 5 contracted seats" */
  figureLabel: ReactNode;
  /** Shown in place of the bar when there is no figure: why, in words. Never a zero */
  missing?: ReactNode;
  /** The share as a small tag, already formatted, e.g. "70 %" */
  share?: ReactNode;
  state?: UsageMeterState;
  /** Said in the tag when the state is not ok, e.g. "all seats in use" */
  stateLabel?: ReactNode;
  /** The two raw readings: they only size the bar. Without both (or without a figure) there is no bar */
  used?: number | null;
  limit?: number | null;
  /** Read out for the bar, e.g. "7 in use, 10 contracted". Without it the bar is decoration (the figure says it) */
  meterLabel?: string;
  rows?: UsageMeterRow[];
  /** A quiet line under everything */
  note?: ReactNode;
  /** sm: inside another card, under that card's own title */
  size?: "md" | "sm";
  className?: string;
};

/** Up to this many seats each one gets its own slot */
const SLOTS = 40;

export function UsageMeter({
  title,
  headingAs = "h3",
  unit,
  figure,
  figureLabel,
  missing,
  share,
  state = "ok",
  stateLabel,
  used,
  limit,
  meterLabel,
  rows = [],
  note,
  size = "md",
  className,
}: UsageMeterProps) {
  const has = figure != null && figure !== false;
  const paid = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const inUse = typeof used === "number" && Number.isFinite(used) ? Math.max(0, Math.floor(used)) : null;
  const bar = has && inUse !== null && paid > 0;
  const total = bar ? Math.max(paid, inUse) : 0;
  const within = bar ? Math.min(inUse, paid) : 0;
  const tag = [has ? share : null, state !== "ok" ? stateLabel : null].filter((n) => n != null && n !== false && n !== "");
  const a11y = meterLabel ? ({ role: "img", "aria-label": meterLabel } as const) : ({ "aria-hidden": true } as const);
  return (
    <section className={["ui-umc", className].filter(Boolean).join(" ")} data-state={state} data-size={size}>
      <header className="ui-umc__head">
        {createElement(headingAs, { className: "ui-umc__title" }, title)}
        {unit != null && unit !== false ? <p className="ui-umc__sub">{unit}</p> : null}
      </header>

      <div className="ui-umc__figure">
        <p className="ui-umc__amount">
          <span className="ui-umc__big" data-missing={has ? undefined : ""}>
            {has ? figure : "—"}
          </span>
          <span className="ui-umc__of">{figureLabel}</span>
        </p>
        {tag.length > 0 ? (
          <span className="ui-umc__pct" data-state={state}>
            {state !== "ok" ? <span className="ui-umc__dot" aria-hidden="true" /> : null}
            {tag.map((n, i) => (
              <span key={i}>
                {i > 0 ? " · " : null}
                {n}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {bar ? (
        <div className="ui-umc__bar">
          {total <= SLOTS ? (
            <div className="ui-umc__track" data-slots="" {...a11y}>
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className="ui-umc__slot" data-part={i < within ? "used" : i < inUse! ? "over" : undefined} />
              ))}
            </div>
          ) : (
            <div className="ui-umc__track" {...a11y}>
              <span className="ui-umc__seg" data-part="used" style={{ width: `${(within / total) * 100}%` }} />
              {inUse! > paid ? <span className="ui-umc__seg" data-part="over" style={{ width: `${((inUse! - paid) / total) * 100}%` }} /> : null}
            </div>
          )}
        </div>
      ) : !has && missing != null && missing !== false ? (
        <p className="ui-umc__missing">{missing}</p>
      ) : null}

      {rows.length > 0 ? (
        <dl className="ui-umc__legend">
          {rows.map((r, i) => (
            <div key={i} className="ui-umc__item">
              <span className="ui-umc__swatch" data-part={r.swatch ?? "plain"} aria-hidden="true" />
              <dt className="ui-umc__label">{r.label}</dt>
              <dd className="ui-umc__value">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {note != null && note !== false ? <p className="ui-umc__note">{note}</p> : null}
    </section>
  );
}
