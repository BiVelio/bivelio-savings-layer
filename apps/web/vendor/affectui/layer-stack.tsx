/*
 * Vendored from affectUI 'Layer Stack' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

/*
 * Layer Stack – an isometric stack of up to five layers next to a list of entries. The chosen
 * entry lifts its layer out of the stack in blue; the others settle back to glassy gray.
 *
 * BiVelio: it is a MAP of pieces with an explanation each, not a slideshow. It never steps
 * through the entries on its own (nothing moves until the reader picks), every entry opens a
 * panel of facts, and the list is a real tab list: arrows, Home and End move the selection, and
 * each panel is reachable by keyboard. Text is laid out in rem and wraps, so long translations
 * and a 200 % zoom fit; only the drawing scales with the container.
 */

export type LayerIcon = "bolt" | "database" | "plug" | "spark" | "pulse";

export type LayerStackFact = {
  /** e.g. "What it does" */
  label: string;
  value: ReactNode;
};

export type LayerStackItem = {
  /** Main line of the entry */
  title: string;
  /** Short muted hint on the right */
  hint?: string;
  /** Icon drawn onto the layer: one of the built-in names */
  icon?: LayerIcon;
  /** The explanation shown while the entry is chosen */
  facts: LayerStackFact[];
};

export type LayerStackProps = {
  /** Up to five entries, top layer first */
  items: LayerStackItem[];
  /** Accessible name of the list of entries */
  label: string;
  /** Entry to start on */
  defaultIndex?: number;
  /** Called when an entry is picked by the user */
  onChange?: (index: number) => void;
  className?: string;
};

/* Layer geometry on the 600 × 400 grid of upstream */
const SIZE = 104; // side of a layer before the isometric projection (rhombus 208 × 104)
const STEP = 26; // vertical distance between resting layers
const GAP = 34; // the chosen layer lifts off the ones below it
const ABOVE = 24; // and the layers above it lift a little further, so it shows
const THICK = 9; // layer thickness
const CX = 168; // stack centre
const TOP = 109; // y of the top layer's back corner when nothing is lifted

export function LayerStack({ items, label, defaultIndex = 0, onChange, className }: LayerStackProps) {
  const id = "ui-lyr" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const list = items.slice(0, 5);
  const [active, setActive] = useState(Math.max(0, Math.min(defaultIndex, list.length - 1)));

  const pick = (i: number) => {
    setActive(i);
    onChange?.(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const n = (to + list.length) % list.length;
    pick(n);
    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
  };

  // Resting y of each layer: gaps open below and above the chosen one. The bottom layer has nothing
  // below it, so when it's chosen it stays put and only the layers above it rise
  const last = list.length - 1;
  const yOf = (i: number) => TOP + i * STEP - (i < active ? GAP + ABOVE : i === active && active < last ? GAP : 0);

  if (!list.length) return null;

  return (
    <div className={["ui-lyr", className].filter(Boolean).join(" ")}>
      <svg className="ui-lyr-stack" viewBox="44 30 248 316" aria-hidden="true">
        <defs>
          <filter id={`${id}-glow`} x="-60%" y="-120%" width="220%" height="340%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
        </defs>

        {/* Bottom layer first, so the upper ones overlap it */}
        {list
          .map((item, i) => (
            <g
              key={i}
              className="ui-lyr-layer"
              data-active={i === active ? "" : undefined}
              data-above={i < active ? "" : undefined}
              style={{ transform: `translate(${CX}px, ${yOf(i)}px)` }}
            >
              <ellipse className="ui-lyr-glow" cx={0} cy={SIZE / 2 + THICK + 18} rx={70} ry={24} filter={`url(#${id}-glow)`} />
              {/* Thickness: the same rhombus, shifted down, peeks out below the top face */}
              <g transform={`translate(0 ${THICK}) matrix(1 0.5 -1 0.5 0 0)`}>
                <rect className="ui-lyr-side" width={SIZE} height={SIZE} rx={9} />
                <rect className="ui-lyr-side-on" width={SIZE} height={SIZE} rx={9} />
              </g>
              <g transform="matrix(1 0.5 -1 0.5 0 0)">
                <rect className="ui-lyr-face" width={SIZE} height={SIZE} rx={9} />
                <rect className="ui-lyr-face-on" width={SIZE} height={SIZE} rx={9} />
                <g className="ui-lyr-icon" transform={`translate(${SIZE / 2 - 18} ${SIZE / 2 - 18}) scale(1.5)`}>
                  {icons[item.icon ?? "bolt"]}
                </g>
              </g>
            </g>
          ))
          .reverse()}
      </svg>

      <div className="ui-lyr-side-col">
        <div className="ui-lyr-menu" role="tablist" aria-label={label} aria-orientation="vertical">
          {list.map((item, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${id}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              className="ui-lyr-row"
              onClick={() => pick(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="ui-lyr-title">{item.title}</span>
              {item.hint && <span className="ui-lyr-hint">{item.hint}</span>}
            </button>
          ))}
        </div>

        {/* Every panel is in the document; only the chosen one shows */}
        {list.map((item, i) => (
          <div key={i} role="tabpanel" id={`${id}-panel-${i}`} aria-labelledby={`${id}-tab-${i}`} className="ui-lyr-panel" hidden={i !== active} tabIndex={0}>
            <dl className="ui-lyr-facts">
              {item.facts.map((fact, j) => (
                <div className="ui-lyr-fact" key={j}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Icons, drawn on a 24 grid and laid onto the layer ---------- */

const icons: Record<LayerIcon, ReactNode> = {
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8ZM12 16.5V21" />,
  spark: <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7ZM18.5 15.5c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3Z" />,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
};
