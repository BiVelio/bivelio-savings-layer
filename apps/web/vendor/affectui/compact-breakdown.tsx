/*
 * Derived from affectUI Pro 'Compact Breakdown' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import { useId, type ReactNode } from "react";

/*
 * Compact Breakdown – one ADDITIVE total split into its parts, in a small card: a big number, a thin stacked bar and
 * the parts as a ranked list on a gray tray.
 *
 * BiVelio: static and server-rendered. Upstream tweens every number and rolls the big figure on hover; here a figure
 * never moves as if it were being measured, so there is no tween, no period switch (the dashboard range is a link in
 * the page) and no `delta` pill (that was a change against a previous period, not a savings rate). Values arrive
 * ALREADY FORMATTED (currency, locale) next to the raw number that sizes the bar. Every string arrives through props.
 */

export type BreakdownItem = {
  /** Stable key – also what keeps a colour attached to a part. */
  id: string;
  label: string;
  /** Raw, additive, same unit for every part. Sizes the bar and the share. */
  value: number;
  /** The value as text, already formatted by the caller. */
  display: string;
  /** Any CSS colour. The caller keeps it stable per part across periods. */
  color: string;
};

export type CompactBreakdownProps = {
  title: string;
  /** The parts, in the order they should be listed (the caller ranks and groups the tail). */
  items: BreakdownItem[];
  /** The total as text, already formatted by the caller. */
  total: string;
  /** What the total is: unit, period and base in words. */
  totalLabel: string;
  /** A small slot next to the title (an evidence badge, a period). */
  aside?: ReactNode;
  /** The line on the gray tray: coverage, source, a link. `null`/omitted hides the tray line. */
  footer?: ReactNode;
  /** Heading level of the title. */
  headingAs?: "h2" | "h3" | "h4";
  className?: string;
};

// NaN, Infinity and negatives count as nothing, so no share or width turns into NaN
const num = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
// A part that exists but rounds to 0% still says so – and one that isn't everything never reads 100%
const pct = (v: number) => (v > 0 && v < 1 ? "<1%" : v > 99 && v < 100 ? ">99%" : `${Math.round(v)}%`);

export function CompactBreakdown({ title, items, total, totalLabel, aside, footer, headingAs: Heading = "h3", className }: CompactBreakdownProps) {
  const uid = useId();
  const sum = items.reduce((a, b) => a + num(b.value), 0);
  const share = (value: number) => (sum > 0 ? (num(value) / sum) * 100 : 0);

  return (
    <div className={["ui-cb", className].filter(Boolean).join(" ")} role="group" aria-labelledby={`${uid}-title`}>
      <div className="ui-cb__card">
        <header className="ui-cb__head">
          <Heading id={`${uid}-title`} className="ui-cb__title" dir="auto">
            {title}
          </Heading>
          {aside ? <div className="ui-cb__aside">{aside}</div> : null}
        </header>

        <p className="ui-cb__big">{total}</p>
        <p className="ui-cb__caption">{totalLabel}</p>

        {sum > 0 ? (
          <div className="ui-cb__bar" aria-hidden="true">
            {items.map((item) =>
              share(item.value) > 0.05 ? <span key={item.id} className="ui-cb__seg" style={{ flexGrow: share(item.value), background: item.color }} /> : null,
            )}
          </div>
        ) : null}

        <ul className="ui-cb__list">
          {items.map((item) => (
            <li key={item.id} className="ui-cb__item">
              <i className="ui-cb__swatch" style={{ background: item.color }} aria-hidden="true" />
              <span className="ui-cb__label" dir="auto">
                {item.label}
              </span>
              <span className="ui-cb__value">{item.display}</span>
              <span className="ui-cb__share">{pct(share(item.value))}</span>
            </li>
          ))}
        </ul>
      </div>

      {footer ? <div className="ui-cb__foot">{footer}</div> : null}
    </div>
  );
}
