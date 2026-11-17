/*
 * Derived from affectUI Pro 'Breadcrumb' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

/*
 * Breadcrumb – clean style. The trail from the top of a hierarchy to the page you are on: quiet links, a small
 * chevron between them, the current page in ink.
 *
 * BiVelio: REDUCED to the trail itself, as a server component. The public site is two levels deep, so the folding
 * of middle crumbs into a "…" menu, the per-crumb dropdowns and the measuring that drove them are gone. Crumbs WRAP
 * instead of ending in "…" (twelve languages). Links are at least 44px tall on touch screens. `linkAs` takes the
 * locale-aware Link; `label` (the nav's accessible name) always arrives translated.
 */

export type BreadcrumbItem = {
  label: ReactNode;
  /** Without it the crumb is plain text; the last crumb is always the current page */
  href?: string;
  /** An inline SVG in front of the label */
  icon?: ReactNode;
};

export type BreadcrumbProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  items: BreadcrumbItem[];
  /** Accessible name of the nav, e.g. "Breadcrumb" – translated by the caller */
  label: string;
  /** The link element – e.g. the app's locale-aware Link. Receives href, className and children */
  linkAs?: ElementType;
};

export function Breadcrumb({ items, label, linkAs: LinkEl = "a", className, ...rest }: BreadcrumbProps) {
  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav className={["ui-bcrc", className].filter(Boolean).join(" ")} aria-label={label} {...rest}>
      <ol className="ui-bcrc__list">
        {items.map((item, i) => {
          const inner = (
            <>
              {item.icon != null && item.icon !== false ? (
                <span className="ui-bcrc__icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="ui-bcrc__label">{item.label}</span>
            </>
          );
          return (
            <li className="ui-bcrc__item" key={i} data-current={i === last ? "" : undefined}>
              {i > 0 ? (
                <span className="ui-bcrc__sep" aria-hidden="true">
                  <Chevron />
                </span>
              ) : null}
              {i === last ? (
                <span className="ui-bcrc__current" aria-current="page">
                  {inner}
                </span>
              ) : item.href ? (
                <LinkEl className="ui-bcrc__link" href={item.href}>
                  {inner}
                </LinkEl>
              ) : (
                <span className="ui-bcrc__link" data-static="">
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const Chevron = () => (
  <svg viewBox="0 0 12 12" fill="none" focusable="false">
    <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
