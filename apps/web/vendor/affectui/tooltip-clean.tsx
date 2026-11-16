/*
 * Derived from affectUI Pro 'Tooltip' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./tooltip-clean.css";
import { useEffect, useState, type ReactNode } from "react";

/*
 * Tooltip – clean style. A small dark label for one control: it shows on hover and on keyboard focus and names what
 * the control does.
 *
 * BiVelio: REDUCED. Upstream measures the trigger and places a top-layer popover on any side, with open and skip
 * delays and a shortcut slot. Here the label is anchored to its trigger with CSS (above it, flipped to the inline
 * end so it never leaves a narrow card), shown by :hover / :focus-within, and the only script is Escape, which
 * dismisses it until the pointer or focus leaves (WCAG 1.4.13). It is decoration for sighted users: the trigger keeps
 * its own accessible name, so the bubble is aria-hidden and never read twice. Not shown on touch screens.
 */

export type TooltipProps = {
  /** The text of the label – the same words as the trigger's accessible name */
  label: string;
  /** The one control it belongs to */
  children: ReactNode;
  className?: string;
};

export function Tooltip({ label, children, className }: TooltipProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissed]);

  return (
    <span
      className={["ui-tipc-anchor", className].filter(Boolean).join(" ")}
      data-dismissed={dismissed || undefined}
      onPointerLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {children}
      <span className="ui-tipc" data-side="top" aria-hidden="true">
        <span className="ui-tipc__text">{label}</span>
      </span>
    </span>
  );
}
