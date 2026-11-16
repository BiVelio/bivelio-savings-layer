/*
 * Derived from affectUI Pro 'Pricing Plans' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./pricing-plans.css";
import type { ReactNode } from "react";

/*
 * Pricing Plans – a billing-period switch and a row of comparable plan cards.
 *
 * BiVelio adaptation:
 *  - NO data of its own. Every amount, limit and label arrives through props, already formatted for the locale by
 *    the caller (from the canonical price readers). The component never formats, divides or multiplies a price.
 *  - A server component. The monthly / yearly switch is two native radio buttons and CSS (`:has()`), so it works
 *    with the keyboard (arrow keys) and without JavaScript, and the page stays static.
 *  - Four plans sit in one row, then two by two, then one column – driven by the section's own width.
 *  - Contract text wraps. Nothing is clipped behind an ellipsis or a tooltip.
 *  - A yearly price is shown as what it is – the yearly charge – with its own period label. There is no
 *    "per month, billed yearly" figure because the price source does not publish one.
 */

export type PricingPeriod = "monthly" | "yearly";

/** A value that may differ between the two billing periods. */
export type ByPeriod<T> = T | { monthly: T; yearly: T };

export type PricingPrice = {
  /** Formatted amount, e.g. the string a price reader returned. */
  amount: string;
  /** What the amount is charged per, e.g. "per seat per month". */
  per?: string;
  /** Short label for the kind of charge, e.g. "Billed monthly" / "Yearly charge". */
  charge?: string;
};

export type PricingLimit = { label: string; value: ByPeriod<ReactNode> };

export type PricingPlan = {
  id: string;
  name: string;
  /** Small pill next to the name. */
  badge?: string;
  /** Soft accent ring: the default paid entry. Contrast comes from the border and the button, not the size. */
  featured?: boolean;
  /** One price for both periods (free, custom) or one per period. */
  price: ByPeriod<PricingPrice>;
  /** The billable unit, shown right under the price. */
  unit?: string;
  /** One or two plain sentences. */
  summary?: ReactNode;
  limits?: PricingLimit[];
  /** The call to action, rendered by the caller (a real link with its own route contract). */
  action?: ReactNode;
  /** Text or link under the limits, e.g. "Plan terms". */
  footer?: ReactNode;
};

export type PricingPlansLabels = {
  /** Accessible name of the period switch. */
  period: string;
  monthly: string;
  yearly: string;
};

export type PricingPlansProps = {
  plans: PricingPlan[];
  labels: PricingPlansLabels;
  /** `name` of the radio group; must be unique on the page. */
  name?: string;
  defaultPeriod?: PricingPeriod;
  /** Hide the switch when no plan has a per-period price. */
  hideSwitch?: boolean;
  /** Accessible name of the list of plans. */
  ariaLabel?: string;
  className?: string;
};

const PERIODS = ["monthly", "yearly"] as const;

function isByPeriod<T>(v: ByPeriod<T>): v is { monthly: T; yearly: T } {
  return typeof v === "object" && v !== null && "monthly" in v && "yearly" in v;
}

/** Renders a per-period value twice, one copy per period; CSS shows the selected one. */
function Period<T>({ value, children }: { value: ByPeriod<T>; children: (v: T) => ReactNode }) {
  if (!isByPeriod(value)) return <>{children(value)}</>;
  return (
    <>
      {PERIODS.map((p) => (
        <span key={p} className="ui-pp__period" data-period={p}>
          {children(value[p])}
        </span>
      ))}
    </>
  );
}

function Price({ price }: { price: PricingPrice }) {
  return (
    <>
      <span className="ui-pp__amount">{price.amount}</span>
      {price.per ? <span className="ui-pp__per">{price.per}</span> : null}
      {price.charge ? <span className="ui-pp__charge">{price.charge}</span> : null}
    </>
  );
}

export function PricingPlans({ plans, labels, name = "ui-pp-period", defaultPeriod = "monthly", hideSwitch = false, ariaLabel, className }: PricingPlansProps) {
  return (
    <div className={["ui-pp", className].filter(Boolean).join(" ")} data-count={plans.length}>
      {hideSwitch ? null : (
        <fieldset className="ui-pp__switch">
          <legend className="ui-pp__sr">{labels.period}</legend>
          <span className="ui-pp__thumb" aria-hidden="true" />
          {PERIODS.map((p) => (
            <label key={p} className="ui-pp__option">
              <input type="radio" name={name} value={p} defaultChecked={p === defaultPeriod} />
              <span>{labels[p]}</span>
            </label>
          ))}
        </fieldset>
      )}

      <ul className="ui-pp__plans" aria-label={ariaLabel}>
        {plans.map((plan) => (
          <li key={plan.id} className="ui-pp__card" data-featured={plan.featured ? "" : undefined}>
            <div className="ui-pp__head">
              <p className="ui-pp__name">
                <span>{plan.name}</span>
                {plan.badge ? <span className="ui-pp__badge">{plan.badge}</span> : null}
              </p>
              <p className="ui-pp__price">
                <Period value={plan.price}>{(price) => <Price price={price} />}</Period>
              </p>
              {plan.unit ? <p className="ui-pp__unit">{plan.unit}</p> : null}
            </div>

            <div className="ui-pp__summary">{plan.summary}</div>

            <div className="ui-pp__action">{plan.action}</div>

            <div className="ui-pp__body">
              {plan.limits?.length ? (
                <dl className="ui-pp__limits">
                  {plan.limits.map((limit, i) => (
                    <div key={`${i}-${limit.label}`}>
                      <dt>{limit.label}</dt>
                      <dd>
                        <Period value={limit.value}>{(v) => v}</Period>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>

            <div className="ui-pp__foot">{plan.footer}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
