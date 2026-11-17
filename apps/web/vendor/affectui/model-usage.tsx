/*
 * Derived from affectUI Pro 'model-usage' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";


import { useId, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Model Usage – how much each AI company's models were used: one stacked bar per company in its color, a segment
 * per model (the most used at the bottom, the rest in lighter shades). Point at a bar, or focus it, and its models
 * are listed with their share of that company.
 * BiVelio fork: no demo data, no "change vs. last period", no task breakdown and no rolling digits. Every figure
 * arrives ALREADY FORMATTED per measure (`display`), next to the raw number that sizes the bar (`values`); the
 * component never adds, divides or invents a number except the share inside one company's own bar.
 */

export type ModelUsageMeasure = { id: string; label: string };

export type ModelUsageModel = {
  name: string;
  values: Record<string, number>;
  display: Record<string, string>;
};

export type ModelUsageCompany = {
  id: string;
  name: string;
  /** Any CSS color; stable per company */
  color: string;
  logo?: ReactNode;
  /** Company totals per measure, already formatted */
  display: Record<string, string>;
  models: ModelUsageModel[];
};

export type ModelUsageProps = {
  title: string;
  /** Total per measure, already formatted, and the words under it */
  totals: Record<string, string>;
  totalLabel: string;
  measures: ModelUsageMeasure[];
  /** Accessible name of the measure switch */
  measuresLabel: string;
  companies: ModelUsageCompany[];
  /** Accessible name of a bar: a template with "{company}" and "{value}" */
  barLabel: string;
  /** Label of the total row inside a company's detail */
  detailTotalLabel: string;
  aside?: ReactNode;
  footer?: ReactNode;
  emptyText: string;
  className?: string;
};

const share = (part: number, whole: number) => {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const p = (part / whole) * 100;
  return p < 1 ? "<1%" : p > 99 && p < 100 ? ">99%" : `${Math.round(p)}%`;
};

export function ModelUsage({
  title,
  totals,
  totalLabel,
  measures,
  measuresLabel,
  companies,
  barLabel,
  detailTotalLabel,
  aside,
  footer,
  emptyText,
  className,
}: ModelUsageProps) {
  const uid = useId();
  const [measure, setMeasure] = useState(measures[0]?.id ?? "");
  const [on, setOn] = useState<string | null>(null);

  const sumOf = (c: ModelUsageCompany) => c.models.reduce((n, m) => n + Math.max(0, m.values[measure] ?? 0), 0);
  const sums = companies.map(sumOf);
  const max = Math.max(0, ...sums);
  const empty = companies.length === 0 || !(max > 0);
  const grid = { gridTemplateColumns: `repeat(${Math.max(1, companies.length)}, minmax(0, 1fr))` } as CSSProperties;
  const tip = companies.find((c) => c.id === on) ?? null;
  const tipSum = tip ? sumOf(tip) : 0;
  const sorted = (c: ModelUsageCompany) => [...c.models].sort((a, b) => (b.values[measure] ?? 0) - (a.values[measure] ?? 0));

  return (
    <section className={["ui-muc", className].filter(Boolean).join(" ")}>
      <div className="ui-muc__head">
        <div className="ui-muc__top">
          <h3 className="ui-muc__title">{title}</h3>
          {aside ? <div className="ui-muc__aside">{aside}</div> : null}
        </div>
        <div className="ui-muc__sum">
          <p className="ui-muc__total">
            <b>{totals[measure] ?? "—"}</b> {totalLabel}
          </p>
          {measures.length > 1 && (
            <div className="ui-muc__tabs" role="group" aria-label={measuresLabel}>
              {measures.map((m) => (
                <button key={m.id} type="button" className="ui-muc__tab" aria-pressed={measure === m.id} onClick={() => setMeasure(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ui-muc__chart">
        <div className="ui-muc__grid" aria-hidden="true">
          <span style={{ top: "0%" }} />
          <span style={{ top: "50%" }} />
          <span style={{ top: "100%" }} />
        </div>
        {empty ? <p className="ui-muc__empty">{emptyText}</p> : null}
        {!empty && (
          <div className="ui-muc__cols" style={grid} onPointerLeave={() => setOn(null)}>
            {companies.map((c, i) => {
              const sum = sums[i] ?? 0;
              const h = `${Math.max(sum > 0 ? 2 : 0, (sum / max) * 84)}%`;
              const models = sorted(c);
              return (
                <button
                  key={c.id}
                  type="button"
                  className="ui-muc__col"
                  data-on={on === c.id ? "" : undefined}
                  data-dim={on !== null && on !== c.id ? "" : undefined}
                  aria-label={barLabel.replace("{company}", c.name).replace("{value}", c.display[measure] ?? "—")}
                  aria-describedby={on === c.id ? `${uid}-tip` : undefined}
                  style={{ ["--ui-muc-h" as string]: h, ["--ui-muc-c" as string]: c.color, animationDelay: `${i * 60}ms` }}
                  onPointerEnter={(e) => {
                    if (e.pointerType !== "touch") setOn(c.id);
                  }}
                  onFocus={() => setOn(c.id)}
                  onBlur={() => setOn((v) => (v === c.id ? null : v))}
                  onClick={() => setOn((v) => (v === c.id ? null : c.id))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOn(null);
                  }}
                >
                  <span className="ui-muc__value">{c.display[measure] ?? "—"}</span>
                  <span className="ui-muc__stack" aria-hidden="true">
                    {models.map((m, k) => (
                      <i
                        key={m.name}
                        style={{
                          flexBasis: `${sum > 0 ? (Math.max(0, m.values[measure] ?? 0) / sum) * 100 : 0}%`,
                          ["--ui-muc-s" as string]: Math.max(0.28, 1 - k * 0.22),
                        }}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="ui-muc__tip" id={`${uid}-tip`} role="status" data-open={tip ? "" : undefined} style={tip ? ({ ["--ui-muc-c" as string]: tip.color } as CSSProperties) : undefined}>
          {tip && (
            <>
              <p className="ui-muc__tip-head">
                {tip.logo ? <span className="ui-muc__tip-logo">{tip.logo}</span> : null}
                {tip.name}
              </p>
              <ul>
                {sorted(tip).map((m, k) => (
                  <li key={m.name} style={{ ["--ui-muc-s" as string]: Math.max(0.28, 1 - k * 0.22) } as CSSProperties}>
                    <i />
                    <span>{m.name}</span>
                    <em>{share(m.values[measure] ?? 0, tipSum)}</em>
                    <b>{m.display[measure] ?? "—"}</b>
                  </li>
                ))}
              </ul>
              <p className="ui-muc__tip-total">
                <span>{detailTotalLabel}</span>
                <b>{tip.display[measure] ?? "—"}</b>
              </p>
            </>
          )}
        </div>
      </div>

      {!empty && (
        <div className="ui-muc__axis" aria-hidden="true" style={grid}>
          {companies.map((c) => (
            <span key={c.id} data-on={on === c.id ? "" : undefined} data-dim={on !== null && on !== c.id ? "" : undefined}>
              {c.logo ? <span className="ui-muc__axis-logo">{c.logo}</span> : null}
              <span className="ui-muc__axis-name">{c.name}</span>
            </span>
          ))}
        </div>
      )}

      {footer ? <p className="ui-muc__foot">{footer}</p> : null}
    </section>
  );
}
