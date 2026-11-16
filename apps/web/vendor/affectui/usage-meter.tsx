/*
 * Derived from affectUI Pro 'usage-meter' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./usage-meter.css";

import type { ReactNode } from "react";

/*
 * Usage Meter – FORKED TO ONE READING: SEATS in use against seats contracted. Upstream is the "Usage" card of an AI
 * product: a credits meter split into categories, a period switch, a daily sparkline, plan limits and an upgrade
 * button. BiVelio Savings has no credits and no quota of requests, so all of that is gone; what stays is the
 * figure ("3 of 5"), its share as a tinted chip and the thin bar – drawn as one slot per seat while they fit.
 * A server component: no state, no tween, no hover. Every string arrives localized; the state (ok / warn / limit)
 * is decided by the caller and also said in words (`stateLabel`), never by color alone.
 */
export type UsageMeterState = "ok" | "warn" | "limit";

export function UsageMeter({
  title,
  used,
  limit,
  figure,
  ofLabel,
  shareLabel,
  state = "ok",
  stateLabel,
  note,
  framed = false,
  className,
}: {
  title: string;
  /** Raw numbers: they only size the bar */
  used: number;
  limit: number;
  /** The used count, already formatted */
  figure: string;
  /** "of 5 contracted seats" */
  ofLabel: string;
  /** "60%" – the caller formats it */
  shareLabel?: string;
  state?: UsageMeterState;
  /** Said next to the share when the state is not ok, e.g. "all seats in use" */
  stateLabel?: string;
  note?: ReactNode;
  framed?: boolean;
  className?: string;
}) {
  const total = Math.max(0, Math.floor(limit));
  const on = Math.min(total, Math.max(0, Math.floor(used)));
  const slots = total > 0 && total <= 40;
  return (
    <div className={["ui-umc", className].filter(Boolean).join(" ")} data-state={state} data-framed={framed || undefined}>
      <p className="ui-umc__title">{title}</p>
      <div className="ui-umc__figure">
        <p className="ui-umc__amount">
          <span className="ui-umc__big">{figure}</span>
          <span className="ui-umc__of">{ofLabel}</span>
        </p>
        {shareLabel || stateLabel ? (
          <span className="ui-umc__pct" data-state={state}>
            {state !== "ok" ? <span className="ui-umc__dot" aria-hidden="true" /> : null}
            {[shareLabel, state !== "ok" ? stateLabel : null].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </div>
      {/* The figure above already says it; the bar repeats it for the eye */}
      {slots ? (
        <div className="ui-umc__track" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className="ui-umc__slot" data-on={i < on ? "" : undefined} />
          ))}
        </div>
      ) : (
        <div className="ui-umc__track" data-solid="" aria-hidden="true">
          <span className="ui-umc__fill" style={{ width: `${total > 0 ? Math.min(100, (on / total) * 100) : 0}%` }} />
        </div>
      )}
      {note ? <p className="ui-umc__note">{note}</p> : null}
    </div>
  );
}
