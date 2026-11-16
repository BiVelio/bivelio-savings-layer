"use client";

/* Derived from affectUI Pro 'toggle-group' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit. */


import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/*
 * Toggle Group (Clean) – a row of toggle buttons, in a single self-contained file.
 * type="multiple" (the default): any number can be on – filters, formatting, visible columns.
 * type="single": at most one is on, and pressing it again turns it off – unlike the Segmented Control, which always
 * keeps one picked. Clean style: "buttons" (the default) are separate quiet chips with a hairline that wrap onto a
 * new line when there are many; "tray" sits them in a compact light-gray track, pressed ones raised in white.
 * A pressed item's fill grows in from its middle. One tab stop for the whole group; arrow keys move between the items,
 * Space or Enter flips one.
 * BiVelio: the styles live in the sibling .css file; the changes against upstream are listed in VENDOR.md.
 */

export type ToggleGroupItem<T extends string = string> = {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  /** Accessible name and tooltip – needed when the item only shows an icon */
  ariaLabel?: string;
  disabled?: boolean;
};

type Shared<T extends string> = {
  items: ToggleGroupItem<T>[];
  /** sm 24 · md 28 · lg 32 high – bigger on touch screens */
  size?: "sm" | "md" | "lg";
  /** "buttons" = separate chips with a hairline that wrap · "tray" = a compact light-gray track, pressed items raised */
  variant?: "buttons" | "tray";
  /** Disables every item */
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
};

export type ToggleGroupProps<T extends string = string> = Shared<T> &
  (
    | {
        /** Any number of items can be on */
        type?: "multiple";
        value?: T[];
        defaultValue?: T[];
        onChange?: (value: T[]) => void;
      }
    | {
        /** At most one item is on; pressing it again turns it off (null) – unless `required` */
        type: "single";
        /** BiVelio: one item always stays on (a reading filter): pressing the one that is on does nothing */
        required?: boolean;
        value?: T | null;
        defaultValue?: T | null;
        onChange?: (value: T | null) => void;
      }
  );

export function ToggleGroup<T extends string = string>(props: ToggleGroupProps<T>) {
  const {
    items: rawItems,
    size: sizeProp = "md",
    variant: variantProp = "buttons",
    disabled = false,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledby,
    className,
  } = props;
  const single = props.type === "single";

  // Gaps and repeated values are dropped – one value, one item
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (Array.isArray(rawItems) ? rawItems : []).filter((it): it is ToggleGroupItem<T> => {
      if (!it || it.value == null || seen.has(String(it.value))) return false;
      seen.add(String(it.value));
      return true;
    });
  }, [rawItems]);
  // Unknown sizes and variants fall back to the defaults
  const size = sizeProp === "sm" || sizeProp === "lg" ? sizeProp : "md";
  const variant = variantProp === "tray" ? "tray" : "buttons";

  const [inner, setInner] = useState<T[]>(() => toList(props.defaultValue));
  const controlled = props.value !== undefined;
  const on = controlled ? toList(props.value) : inner;

  const group = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<T | null>(null);

  const toggle = (v: T) => {
    const item = items.find((it) => it.value === v);
    if (!item || item.disabled || disabled) return;
    const pressed = on.includes(v);
    if (single && pressed && props.type === "single" && props.required) return;
    // Multiple keeps the items' order, whatever order they were pressed in
    const next = single ? (pressed ? [] : [v]) : items.map((it) => it.value).filter((x) => (x === v ? !pressed : on.includes(x)));
    if (!controlled) setInner(next);
    if (props.type === "single") props.onChange?.(next[0] ?? null);
    else props.onChange?.(next);
  };

  const enabled = items.filter((it) => !it.disabled && !disabled);
  // One tab stop: the item last focused, else the first one that's on, else the first one
  const stop =
    enabled.find((it) => it.value === focused)?.value ??
    enabled.find((it) => on.includes(it.value))?.value ??
    enabled[0]?.value;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = Array.from(group.current?.querySelectorAll<HTMLButtonElement>(":scope > .ui-tglc__item:not(:disabled)") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // In right-to-left pages the left arrow goes on to the next item
    const rtl = group.current ? getComputedStyle(group.current).direction === "rtl" : false;
    const fwd = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    let to = -1;
    if (e.key === fwd || e.key === "ArrowDown") to = (at + 1) % buttons.length;
    else if (e.key === back || e.key === "ArrowUp") to = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = buttons.length - 1;
    if (to < 0) return;
    e.preventDefault();
    buttons[to].focus();
  };

  return (
    <div
      ref={group}
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-disabled={disabled || undefined}
      className={["ui-tglc", className].filter(Boolean).join(" ")}
      data-size={size}
      data-variant={variant}
      data-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((it) => {
        const pressed = on.includes(it.value);
        // Without a label or icon the value names the item
        const label = it.label ?? (it.icon ? null : String(it.value));
        const iconOnly = label == null;
        return (
          <button
            key={String(it.value)}
            type="button"
            className="ui-tglc__item"
            aria-pressed={pressed}
            aria-label={it.ariaLabel}
            title={iconOnly ? it.ariaLabel : undefined}
            data-icon-only={iconOnly || undefined}
            disabled={it.disabled || disabled}
            tabIndex={it.value === stop ? 0 : -1}
            onFocus={() => setFocused(it.value)}
            onClick={() => toggle(it.value)}
          >
            {it.icon != null && (
              <span className="ui-tglc__icon" aria-hidden="true">
                {it.icon}
              </span>
            )}
            {label != null && (
              <span className="ui-tglc__label" dir="auto">
                {label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Value or values → a list; null, undefined and gaps drop out */
function toList<T extends string>(v: T | T[] | null | undefined): T[] {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  return v == null ? [] : [v];
}
