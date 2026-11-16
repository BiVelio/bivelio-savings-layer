/*
 * Derived from affectUI Pro 'badge' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./badge.css";

import type { ReactNode } from "react";

/*
 * Badge – a small status label: a soft tint with matching text and an optional leading dot.
 * BiVelio fork: a server component (no "use client"); no pulsing "live" dot, no count bubble, no remove button; the
 * label wraps instead of being cut; `caps` is the mono, upper-case reading used for evidence-type labels.
 */
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export function Badge({
  tone = "neutral",
  size = "md",
  variant = "soft",
  dot = false,
  caps = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  size?: "sm" | "md";
  variant?: "soft" | "outline";
  /** A leading dot in the tone's color. The words still carry the state. */
  dot?: boolean;
  caps?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={["ui-bdgc", className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-size={size}
      data-variant={variant}
      data-lead={dot || undefined}
      data-caps={caps || undefined}
    >
      {dot ? <span className="ui-bdgc__dot" aria-hidden="true" /> : null}
      <span className="ui-bdgc__label">{children}</span>
    </span>
  );
}
