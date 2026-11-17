/*
 * Derived from affectUI Pro 'Button' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type SyntheticEvent,
  type ReactNode,
} from "react";

/*
 * Button – clean style: a dark chip, a white button with a hairline shadow, a quiet ghost. When its label or icon
 * changes, the width glides and the new parts blur in; while loading, a light band sweeps across the dimmed label.
 *
 * BiVelio: one more size, "xl" (44px high – the height of every control in the access forms), and `block` to fill the
 * row. The label WRAPS on a narrow phone instead of ending in "…" (so the hover title is gone), and the
 * destructive variant is out: nothing in the public pages destroys anything.
 */

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  /** primary: a dark chip · secondary: white with a hairline shadow · ghost: text only · destructive: a light red fill, for deleting */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg" | "xl";
  /** Fills the row (BiVelio) */
  block?: boolean;
  /** Shows a shimmer over the label and blocks clicks */
  loading?: boolean;
  /** Icon before the label, e.g. an inline SVG */
  icon?: ReactNode;
  /** Icon after the label */
  iconRight?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  block = false,
  icon,
  iconRight,
  children,
  className,
  disabled,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  // The shimmer copies the label, so it only works on plain text
  const text = typeof children === "string" ? children : undefined;
  // An empty string or false is no label – the icon stays centered
  const hasLabel = children != null && children !== false && children !== "";
  const iconOnly = !hasLabel && Boolean(icon || iconRight);
  // Unknown values fall back to the defaults instead of an unstyled button
  const tone = VARIANTS.includes(variant) ? variant : "primary";
  const scale = SIZES.includes(size) ? size : "md";

  // Morph: when label or icon change, the width glides to its new size and the new content blurs in.
  // Nothing animates on the first render.
  const inner = useRef<HTMLButtonElement | null>(null);
  const lastWidth = useRef(0);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const labelKey = text ?? "label";
  const iconKey = loading && icon ? "spinner" : contentKey(icon);
  const iconRightKey = contentKey(iconRight);

  const content = `${labelKey}|${iconKey}|${iconRightKey}`;
  const lastContent = useRef(content);

  // Runs after every render, so the remembered width is always current
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    const from = lastWidth.current;
    const changed = lastContent.current !== content;
    lastWidth.current = width;
    lastContent.current = content;
    if (!changed || !from || Math.abs(from - width) < 0.5) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ width: `${from}px` }, { width: `${width}px` }], {
      duration: 480,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    });
  });

  return (
    <>
      <button
        type={type}
        className={["ui-buttonc", className].filter(Boolean).join(" ")}
        data-variant={tone}
        data-size={scale}
        data-loading={loading || undefined}
        data-block={block || undefined}
        data-icon-only={iconOnly || undefined}
        data-icon-left={(!iconOnly && Boolean(icon)) || undefined}
        data-icon-right={(!iconOnly && Boolean(iconRight)) || undefined}
        data-ready={ready || undefined}
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        disabled={disabled}
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={(event) => {
          if (loading) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...rest}
      >
        {/* New keys remount the parts that changed, which replays their enter animation */}
        {icon && (
          <span className="ui-buttonc__icon" aria-hidden="true" key={`icon-${iconKey}`} onErrorCapture={hideBroken}>
            {loading ? <Spinner /> : icon}
          </span>
        )}
        {hasLabel && (
          <span className="ui-buttonc__label" data-text={text} dir="auto" key={`label-${labelKey}`}>
            {children}
          </span>
        )}
        {iconRight && (
          <span className="ui-buttonc__icon" aria-hidden="true" key={`icon-right-${iconRightKey}`} onErrorCapture={hideBroken}>
            {iconRight}
          </span>
        )}
      </button>
    </>
  );
}

const VARIANTS = ["primary", "secondary", "ghost"];
const SIZES = ["sm", "md", "lg", "xl"];

/** An icon image that fails to load leaves an empty slot instead of a broken-image glyph */
const hideBroken = (event: SyntheticEvent<HTMLElement>) => {
  if (event.target instanceof HTMLImageElement) event.target.style.visibility = "hidden";
};

/** Shown in place of the left icon while loading */
const Spinner = () => (
  <svg
    className="ui-buttonc__spinner"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="8.5" opacity={0.2} />
    <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
  </svg>
);

/** A stable id per icon component, so swapping e.g. <CopyIcon /> for <CheckIcon /> counts as a change */
const ids = new WeakMap<object, number>();
let nextId = 1;
function contentKey(node: ReactNode) {
  if (!isValidElement(node) || typeof node.type === "string") return 0;
  const type = node.type as object;
  if (!ids.has(type)) ids.set(type, nextId++);
  return ids.get(type)!;
}
