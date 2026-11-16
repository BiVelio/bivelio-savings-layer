/*
 * Derived from affectUI Pro 'Badge' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./badge-clean.css";
import type { ComponentPropsWithRef, ReactNode } from "react";

/*
 * Badge – clean style, adapted for BiVelio Savings. A small status label – the one place a status gets its colour: a
 * soft tinted fill, the text in the tone's ink, optionally a dot or a glyph in front.
 *
 * BiVelio: ONE badge for the whole site (panel, evidence, public pages). A server component (no state): upstream's
 * Hugeicons objects and the "purple" tone are gone, and the round `count` takes an already-written value instead of
 * formatting with the browser's locale. The label WRAPS instead of ending in "…": twelve languages, and a status
 * that is cut off is not a status. The text always says the status; the colour only repeats it.
 */

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = ComponentPropsWithRef<"span"> & {
  /** neutral: gray · info: blue · success: green · warning: amber · danger: red */
  tone?: BadgeTone;
  /** sm: 18px high, 11px text (inside dense rows) · md: 22px, 12px (the default) · lg: 26px, 12.5px, a pill – a status that heads a section */
  size?: "sm" | "md" | "lg";
  /** A small dot in the tone's colour in front of the label */
  dot?: boolean;
  /** The dot pulses softly – only while something is really in progress. Still under reduced motion. */
  live?: boolean;
  /** An inline SVG in front of the label */
  icon?: ReactNode;
  /** Mono, upper-case reading: evidence-type labels ("ESTIMACIÓN") */
  caps?: boolean;
  /** A round count in place of the label. Pass the value as it must be read (already formatted). */
  count?: number | string;
};

const TONES: BadgeTone[] = ["neutral", "info", "success", "warning", "danger"];

export function Badge({ tone = "neutral", size = "md", dot, live, icon, caps, count, className, children, ...rest }: BadgeProps) {
  // Unknown values fall back to the defaults instead of an unstyled badge
  const hue = TONES.includes(tone) ? tone : "neutral";
  const isCount = typeof count === "string" ? count !== "" : typeof count === "number" && Number.isFinite(count);
  const lead = isCount ? null : live || dot ? "dot" : icon != null && icon !== false ? "icon" : null;
  // Nothing to say – no empty pill (e.g. a count that is missing)
  if (!isCount && !lead && (children == null || children === false || children === "")) return null;
  return (
    <span
      className={["ui-bdgc", className].filter(Boolean).join(" ")}
      data-tone={hue}
      data-size={size === "sm" || size === "lg" ? size : "md"}
      data-lead={lead ?? undefined}
      data-caps={caps || undefined}
      data-count={isCount ? "" : undefined}
      {...rest}
    >
      {lead === "dot" && <span className="ui-bdgc__dot" data-live={live ? "" : undefined} aria-hidden="true" />}
      {lead === "icon" && (
        <span className="ui-bdgc__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {isCount ? count : <span className="ui-bdgc__label">{children}</span>}
    </span>
  );
}
