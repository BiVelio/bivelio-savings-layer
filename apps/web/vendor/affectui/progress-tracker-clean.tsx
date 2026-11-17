/*
 * Vendored from affectUI 'Progress Tracker (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
import type { ElementType, ReactNode } from "react";

/*
 * Progress Tracker – a checklist with a progress bar.
 *
 * BiVelio FORK: READ-ONLY and CONTROLLED. Upstream lets the visitor tick steps and can auto-play; here a step is done
 * only because the product measured it (`status`), so there is no checkbox, no toggle, no local state and no timer.
 * The component has no hooks and no "use client": it renders on the server. A row with `href` is a link that opens the
 * instruction of that step — clicking it never marks anything as done. Every string arrives through props.
 */

export type ProgressStepStatus = "done" | "current" | "pending" | "unavailable";

export type ProgressStep = {
  id: string;
  label: string;
  /** Decided by the caller from real state. Never changed by this component. */
  status: ProgressStepStatus;
  /** The status as words ("done", "next", …): status is never colour only. */
  statusLabel: string;
  /** Where the instruction of this step lives. Without it the row is plain text. */
  href?: string;
};

export type ProgressTrackerProps = {
  title: string;
  /** Pass an empty list to show only the title, the counter and the bar. */
  steps: ProgressStep[];
  /** How many steps are done, decided by the caller. */
  done: number;
  total: number;
  /** The visible counter, already localized, e.g. "2 of 5". */
  countLabel: string;
  /** `list` (default) is the upstream card; `steps` lays the same rows out as a horizontal rail when there is room. */
  layout?: "list" | "steps";
  /** Tighter rows for a narrow rail. */
  dense?: boolean;
  /** No card of its own: sits inside another surface. */
  bare?: boolean;
  /** Element used for a row with `href` (a locale-aware Link, for example). Defaults to `a`. */
  linkAs?: ElementType;
  /** Heading level of the title. */
  headingAs?: "h2" | "h3" | "p";
  /** Extra content under the list (a note, an action). */
  footer?: ReactNode;
  className?: string;
};

export function ProgressTracker({
  title,
  steps,
  done,
  total,
  countLabel,
  layout = "list",
  dense = false,
  bare = false,
  linkAs: LinkEl = "a",
  headingAs: Heading = "h3",
  footer,
  className,
}: ProgressTrackerProps) {
  const progress = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;

  return (
    <div
      className={["ui-progressc", className].filter(Boolean).join(" ")}
      data-complete={total > 0 && done === total ? "" : undefined}
      data-layout={layout}
      data-dense={dense ? "" : undefined}
      data-bare={bare ? "" : undefined}
    >
      <div className="ui-progressc__head">
        <Heading className="ui-progressc__title" dir="auto">
          {title}
        </Heading>
        <span className="ui-progressc__count">{countLabel}</span>
      </div>

      {/* The bar repeats the counter written next to the title, so it stays out of the accessibility tree. */}
      <div className="ui-progressc__bar" aria-hidden="true">
        <span className="ui-progressc__fill" style={{ transform: `scaleX(${progress})` }} />
      </div>

      {steps.length > 0 ? (
      <ol className="ui-progressc__list">
        {steps.map((step) => {
          const row = (
            <>
              <span className="ui-progressc__check" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6.5 12.5l3.5 3.5 7.5-8" />
                </svg>
              </span>
              <span className="ui-progressc__label">
                <span dir="auto">{step.label}</span>
              </span>
              <span className="ui-progressc__state">{step.statusLabel}</span>
            </>
          );
          return (
            <li key={step.id} data-status={step.status} aria-current={step.status === "current" ? "step" : undefined}>
              {step.href ? (
                <LinkEl className="ui-progressc__step" href={step.href}>
                  {row}
                </LinkEl>
              ) : (
                <div className="ui-progressc__step">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
      ) : null}

      {footer ? <div className="ui-progressc__foot">{footer}</div> : null}
    </div>
  );
}
