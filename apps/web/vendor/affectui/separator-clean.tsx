/*
 * Derived from affectUI Pro 'Separator' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import type { ComponentPropsWithRef, ReactNode } from "react";

/*
 * Separator – a single self-contained file, clean style.
 * A 0.5px hairline between groups: across a card or a list, or upright between tools in a bar. It can carry a short
 * label in its middle – "or" between two ways in, "Earlier" above older rows.
 * BiVelio: server component, light theme only.
 */

export type SeparatorProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** horizontal: a line across, as wide as its container · vertical: an upright line, 16px high in a row */
  orientation?: "horizontal" | "vertical";
  /**
   * true (the default): only a visual line, hidden from screen readers · false: a real separator (role="separator")
   * that splits content into sections screen readers announce
   */
  decorative?: boolean;
  /** A short word in the middle of a horizontal line – "or", "Earlier", "Today" */
  label?: ReactNode;
};

export function Separator({ orientation = "horizontal", decorative = true, label, className, ...rest }: SeparatorProps) {
  const vertical = orientation === "vertical";
  const hasLabel = !vertical && label != null && label !== false && label !== "";
  // A labelled separator names itself after its label, when the label is text
  const name = hasLabel && (typeof label === "string" || typeof label === "number") ? String(label) : undefined;
  const a11y = decorative
    ? // A decorative line with a label: the label stays readable as plain text, only the lines are hidden
      hasLabel
      ? {}
      : { role: "none" as const }
    : {
        role: "separator" as const,
        "aria-orientation": vertical ? ("vertical" as const) : undefined,
        "aria-label": name,
      };

  return (
    <>
      <div
        className={["ui-sepc", className].filter(Boolean).join(" ")}
        data-orientation={vertical ? "vertical" : "horizontal"}
        data-label={hasLabel ? "" : undefined}
        {...a11y}
        {...rest}
      >
        {hasLabel && (
          <>
            <span className="ui-sepc__line" aria-hidden="true" />
            <span className="ui-sepc__label">{label}</span>
            <span className="ui-sepc__line" aria-hidden="true" />
          </>
        )}
      </div>
    </>
  );
}
