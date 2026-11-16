/*
 * Derived from affectUI Pro 'Experiment Card' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./experiment-readout.css";
import type { ReactNode } from "react";

/*
 * Experiment Readout – the Experiment Card, read instead of played.
 *
 * Upstream folds the comparison behind a hover and asks you to pick a winner. A measurement is not a
 * vote, so this derivative keeps the composition (tray, card, status tag, one row per variant with its
 * key badge and bar) and drops every interaction: it is always open, nothing depends on hover, there is
 * no winner to pick and no number rolls. What replaces the "pick a winner" tray is the statistical
 * reading – sample, interval, period, coverage – and a slot for a link to the methodology.
 *
 * It renders on the server (no client state). Every string, number and bar length arrives already
 * formatted through props: the piece ships no text, computes nothing and holds no demo data.
 */

export type ReadoutTone = "green" | "amber" | "red" | "gray";

export type ReadoutVariant = {
  /** Short key shown in the badge, e.g. "A" */
  key: string;
  name: string;
  /** Second line under the name, e.g. "Baseline" */
  hint?: string;
  /** Already formatted: a cost, a change, or a word such as "Base" */
  value: ReactNode;
  /** Bar length between 0 and 1. Omit it when there is nothing honest to draw */
  share?: number;
  /** The baseline every other row is read against */
  control?: boolean;
};

export type ReadoutFact = { label: string; value: ReactNode };

export type ExperimentReadoutProps = {
  title: string;
  /** Always text, never colour alone, e.g. { label: "Inconclusive", tone: "amber" } */
  status?: { label: string; tone?: ReadoutTone };
  /** Short text next to the status, e.g. the period */
  note?: string;
  /** Slot at the right of the head, e.g. an evidence badge */
  badge?: ReactNode;
  /** The headline figure, already formatted */
  figure?: ReactNode;
  figureTone?: "positive" | "negative" | "neutral";
  /** What the headline figure is, in words */
  caption?: ReactNode;
  variants?: ReadoutVariant[];
  /** Anything between the rows and the tray, e.g. an interval band */
  children?: ReactNode;
  /** The statistical reading on the tray: sample, interval, period, coverage */
  facts?: ReadoutFact[];
  /** Slot at the end of the tray, e.g. a "See methodology" link */
  action?: ReactNode;
  /** Heading level of the title. Defaults to h2 */
  as?: "h2" | "h3";
  className?: string;
};

const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function ExperimentReadout({
  title,
  status,
  note,
  badge,
  figure,
  figureTone = "neutral",
  caption,
  variants = [],
  children,
  facts = [],
  action,
  as: Heading = "h2",
  className,
}: ExperimentReadoutProps) {
  return (
    <section className={["ui-xr", className].filter(Boolean).join(" ")}>
      <div className="ui-xr__card">
        <header className="ui-xr__head">
          <div className="ui-xr__titles">
            <Heading className="ui-xr__name">{title}</Heading>
            {status || note ? (
              <p className="ui-xr__sub">
                {status ? (
                  <span className="ui-xr__tag" data-tone={status.tone ?? "gray"}>
                    <span className="ui-xr__dot" aria-hidden="true" />
                    {status.label}
                  </span>
                ) : null}
                {note ? <span className="ui-xr__note">{note}</span> : null}
              </p>
            ) : null}
          </div>
          {badge ? <div className="ui-xr__badge">{badge}</div> : null}
        </header>

        {figure != null ? (
          <div className="ui-xr__figure">
            <p className="ui-xr__big" data-tone={figureTone}>
              {figure}
            </p>
            {caption ? <p className="ui-xr__cap">{caption}</p> : null}
          </div>
        ) : null}

        {variants.length > 0 ? (
          <ul className="ui-xr__rows">
            {variants.map((v) => (
              <li key={v.key} className="ui-xr__row" data-control={v.control ? "" : undefined}>
                <span className="ui-xr__key" aria-hidden="true">
                  {v.key}
                </span>
                <span className="ui-xr__who">
                  <span className="ui-xr__vname">{v.name}</span>
                  {v.hint ? <span className="ui-xr__hint">{v.hint}</span> : null}
                </span>
                <span className="ui-xr__val">{v.value}</span>
                {typeof v.share === "number" && Number.isFinite(v.share) ? (
                  <span className="ui-xr__track" aria-hidden="true">
                    <i style={{ width: `${clamp(v.share) * 100}%` }} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {children ? <div className="ui-xr__extra">{children}</div> : null}
      </div>

      {facts.length > 0 || action ? (
        <div className="ui-xr__tray">
          {facts.length > 0 ? (
            <dl className="ui-xr__facts">
              {facts.map((f) => (
                <div key={f.label} className="ui-xr__fact">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {action ? <div className="ui-xr__action">{action}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
