/*
 * Derived from affectUI Pro 'Empty State' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./empty-state-clean.css";
import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

/*
 * Empty State – a single self-contained file, clean style.
 * What a list, table or panel shows while there is nothing in it: an icon on a soft tile, a title, one line on what
 * will show up here, and a button for the first step. Framed in a quiet drop area, or bare inside a panel.
 * BiVelio: server component; no default glyph and no Hugeicons objects; optional art, eyebrow, heading element and page scale.
 */

export type EmptyStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  /** What's empty, e.g. "No schedules yet" */
  title: ReactNode;
  /** One line on what will show up here, or how to get there */
  text?: ReactNode;
  /** The first step – usually a small secondary Button; several buttons sit in a row */
  action?: ReactNode;
  /** The glyph on the tile: an inline SVG. Without it there is no tile */
  icon?: ReactNode;
  /** An illustration above the title, in place of the tile (BiVelio) */
  art?: ReactNode;
  /** A quiet line above the title (BiVelio) */
  eyebrow?: ReactNode;
  /** The element of the title – a page uses "h1" (BiVelio; upstream is always a <p>) */
  titleAs?: ElementType;
  /** page: the larger scale of a whole page (BiVelio) */
  size?: "md" | "page";
  /** Anything under the action, e.g. a short list of destinations (BiVelio) */
  children?: ReactNode;
  /** Without the frame – for a panel or page where it is the only content */
  bare?: boolean;
  /** Fills its parent's height and centres itself in it – for a list or table area that keeps its size */
  tall?: boolean;
};

export function EmptyState({ title, text, action, icon, art, eyebrow, titleAs: Title = "p", size = "md", bare, tall, className, children, ...rest }: EmptyStateProps) {
  return (
    <>
      <div className={["ui-estc", className].filter(Boolean).join(" ")} data-bare={bare || undefined} data-tall={tall || undefined} data-size={size} {...rest}>
        {/* icon={null}: no tile at all, the title moves up */}
        {icon != null && icon !== false && (
          <span className="ui-estc__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {art != null && art !== false && <div className="ui-estc__art">{art}</div>}
        {eyebrow != null && eyebrow !== false && <p className="ui-estc__eyebrow">{eyebrow}</p>}
        <Title className="ui-estc__title">{title}</Title>
        {text != null && text !== false && <p className="ui-estc__text">{text}</p>}
        {action != null && action !== false && <div className="ui-estc__action">{action}</div>}
        {children}
      </div>
    </>
  );
}
