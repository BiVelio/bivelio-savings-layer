/*
 * Derived from affectUI Pro 'Badge' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./badge-clean.css";
import type { ComponentPropsWithRef, ReactNode } from "react";

/*
 * Badge – clean style. A small status label – the one place a status gets its colour: a soft tinted fill, the text in
 * the tone's ink, optionally a dot or a glyph in front.
 *
 * BiVelio: server component. The count variant is gone (it formatted with the browser's locale and nothing here counts),
 * and so are the Hugeicons objects and the "purple" tone. The label WRAPS instead of ending in "…": twelve languages,
 * and a status that is cut off is not a status. `size="md"` is the default.
 */

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = ComponentPropsWithRef<"span"> & {
  tone?: BadgeTone;
  size?: "sm" | "md";
  /** A small dot in the tone's colour in front of the label */
  dot?: boolean;
  /** An inline SVG in front of the label */
  icon?: ReactNode;
};

const TONES: BadgeTone[] = ["neutral", "info", "success", "warning", "danger"];

export function Badge({ tone = "neutral", size = "md", dot, icon, className, children, ...rest }: BadgeProps) {
  const hue = TONES.includes(tone) ? tone : "neutral";
  const lead = dot ? "dot" : icon != null && icon !== false ? "icon" : null;
  if (!lead && (children == null || children === false || children === "")) return null;
  return (
    <span className={["ui-bdgc", className].filter(Boolean).join(" ")} data-tone={hue} data-size={size === "sm" ? "sm" : "md"} data-lead={lead ?? undefined} {...rest}>
      {lead === "dot" && <span className="ui-bdgc__dot" aria-hidden="true" />}
      {lead === "icon" && (
        <span className="ui-bdgc__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-bdgc__label">{children}</span>
    </span>
  );
}
