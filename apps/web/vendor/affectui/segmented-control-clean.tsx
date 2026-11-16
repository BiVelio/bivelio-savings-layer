/*
 * Vendored from affectUI 'Segmented Control (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./segmented-control-clean.css";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/*
 * Segmented Control (Clean) – switch between two to six options, in a single self-contained file.
 * Clean style: "buttons" (the default): separate quiet chips with a hairline, the active one filled light gray;
 * "tray": a compact light-gray track with a white raised pill; "underline": text tabs with a sliding line.
 * The indicator slides to the picked option, short and crisp – its leading edge runs a touch ahead.
 * Labels keep one weight, so nothing shifts; when a label or count changes the control morphs to its new size.
 * Arrow keys, Home and End move and select; press the pill and drag it across the options to pick as you go.
 * If it doesn't fit (phones), it scrolls sideways with soft edges and keeps the active option in view.
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

export type SegmentOption<T extends string = string> = {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  /** A small gray number after the label, e.g. unread items */
  count?: number | string;
  /** A small tinted tag after the label, e.g. "Save 20%" */
  badge?: ReactNode;
  disabled?: boolean;
  /** Accessible name – needed when the option only shows an icon */
  ariaLabel?: string;
  /** With kind="tabs": the id of the panel this tab shows */
  controls?: string;
};

export type SegmentedControlProps<T extends string = string> = {
  options: SegmentOption<T>[];
  /** Controlled value */
  value?: T;
  /** Starting value when uncontrolled – defaults to the first enabled option */
  defaultValue?: T;
  onChange?: (value: T) => void;
  size?: "sm" | "md" | "lg";
  /** "buttons" = separate chips, the active one filled; "tray" = light track with a raised pill; "underline" = text tabs with a sliding line */
  variant?: "buttons" | "tray" | "underline";
  /** Fill the container with equal segments */
  fullWidth?: boolean;
  /** "radio" (a radiogroup, the default) or "tabs" (a tablist that switches panels) */
  kind?: "radio" | "tabs";
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
};

export function SegmentedControl<T extends string = string>({
  options: rawOptions,
  value,
  defaultValue,
  onChange,
  size: sizeProp = "md",
  variant: variantProp = "buttons",
  fullWidth = false,
  kind = "radio",
  disabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  className,
}: SegmentedControlProps<T>) {
  // Gaps and repeated values are dropped – one value, one option
  const options = useMemo(() => {
    const seen = new Set<string>();
    return (Array.isArray(rawOptions) ? rawOptions : []).filter((o): o is SegmentOption<T> => {
      if (!o || o.value == null || seen.has(String(o.value))) return false;
      seen.add(String(o.value));
      return true;
    });
  }, [rawOptions]);
  // Unknown sizes and variants fall back to the defaults
  const size = sizeProp === "sm" || sizeProp === "lg" ? sizeProp : "md";
  const variant = variantProp === "tray" || variantProp === "underline" ? variantProp : "buttons";
  const [inner, setInner] = useState<T | undefined>(() => defaultValue ?? options.find((o) => !o.disabled)?.value);
  const current = value !== undefined ? value : inner;

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  // Latest value without waiting for a render – dragging picks several options in one frame
  const latest = useRef(current);
  latest.current = current;
  const gliding = useRef(false);
  const glideTimer = useRef(0);
  const placed = useRef<T | undefined>(undefined);
  const press = useRef<{ id: number; touch: boolean; drag: boolean; x: number; moved: boolean } | null>(null);

  const buttons = () => Array.from(track.current?.querySelectorAll<HTMLElement>(":scope > .ui-segc__opt") ?? []);
  const activeIndex = options.findIndex((o) => o.value === current);
  const tabbable = activeIndex >= 0 ? activeIndex : options.findIndex((o) => !o.disabled);

  const select = (v: T) => {
    const opt = options.find((o) => o.value === v);
    if (!opt || opt.disabled || disabled || v === latest.current) return;
    latest.current = v;
    if (value === undefined) setInner(v);
    onChange?.(v);
  };

  /** Buttons get the width of their content, so a changed label or count makes them – and the control – glide to the new size */
  const measure = () => {
    const els = buttons();
    if (!els.length || !track.current) return;
    const cs = getComputedStyle(els[0]);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const widths = els.map((b) => (b.firstElementChild as HTMLElement).offsetWidth + pad);
    if (fullWidth) {
      track.current.style.setProperty("--ui-segc-min", `${Math.max(...widths)}px`);
      els.forEach((b) => (b.style.width = ""));
    } else els.forEach((b, i) => (b.style.width = `${widths[i]}px`));
  };

  /** Moves the pill (or line) under the active option. Without `animate` it follows at once – unless a glide is still running */
  const place = (animate: boolean) => {
    const t = track.current;
    const p = pill.current;
    if (!t || !p) return;
    const btn = t.querySelector<HTMLElement>(":scope > .ui-segc__opt[data-active]");
    if (!btn || !btn.offsetWidth) {
      p.style.opacity = "0";
      return;
    }
    let x = btn.offsetLeft;
    let w = btn.offsetWidth;
    // The line sits under the text only, not under the whole button
    if (variant === "underline") {
      const content = btn.firstElementChild as HTMLElement;
      x += content.offsetLeft;
      w = content.offsetWidth;
    }
    const instant = !p.dataset.ready || (!animate && !gliding.current);
    const prev = parseFloat(p.style.left) || 0;
    // The edge facing the target leads, the other one trails – the stretch
    if (!instant && x !== prev) p.dataset.dir = x > prev ? "right" : "left";
    if (instant) p.style.transition = "none";
    p.style.opacity = "1";
    p.style.left = `${x}px`;
    p.style.right = `${t.clientWidth - x - w}px`;
    if (instant) {
      p.dataset.ready = "1";
      void p.offsetWidth;
      p.style.transition = "";
    }
  };

  /** Soft edges only on the sides that can scroll */
  const fades = () => {
    const s = scroller.current;
    if (!s) return;
    const max = s.scrollWidth - s.clientWidth;
    root.current?.toggleAttribute("data-overflow", max > 1);
    s.style.setProperty("--ui-segc-fade-l", s.scrollLeft > 1 ? "24px" : "0px");
    s.style.setProperty("--ui-segc-fade-r", s.scrollLeft < max - 1 ? "24px" : "0px");
  };

  /** Keeps the active option in view when the control scrolls */
  const reveal = (smooth: boolean) => {
    const s = scroller.current;
    const t = track.current;
    const btn = t?.querySelector<HTMLElement>(":scope > .ui-segc__opt[data-active]");
    if (!s || !t || !btn || s.scrollWidth <= s.clientWidth + 1) return;
    const left = t.offsetLeft + btn.offsetLeft - (s.clientWidth - btn.offsetWidth) / 2;
    s.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
  };

  // Sizes: measured on mount and whenever a label, the container or the font changes
  useLayoutEffect(() => {
    const t = track.current;
    const s = scroller.current;
    if (!t || !s) return;
    const sync = () => {
      measure();
      place(false);
      fades();
    };
    sync();
    // Width transitions only after the first measure, so nothing grows in on load
    const ready = requestAnimationFrame(() => root.current?.setAttribute("data-ready", ""));
    // One frame later, so setting widths inside the observer never loops
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    });
    ro.observe(s);
    ro.observe(t);
    t.querySelectorAll(".ui-segc__opt, .ui-segc__content").forEach((el) => ro.observe(el));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(ready);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length, fullWidth, variant, size]);

  // A new value: the pill glides there, focus follows if it was inside, and a scrolling control brings it into view
  useLayoutEffect(() => {
    if (placed.current === current) return;
    const first = placed.current === undefined;
    placed.current = current;
    if (!first) {
      gliding.current = true;
      clearTimeout(glideTimer.current);
      glideTimer.current = window.setTimeout(() => (gliding.current = false), 240);
    }
    place(!first);
    reveal(!first);
    const t = track.current;
    if (!first && t && t.contains(document.activeElement)) buttons()[activeIndex]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => () => clearTimeout(glideTimer.current), []);

  /* ---------- Keyboard ---------- */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = options.filter((o) => !o.disabled);
    if (!enabled.length || disabled) return;
    const prevKeys = kind === "radio" ? ["ArrowLeft", "ArrowUp"] : ["ArrowLeft"];
    const nextKeys = kind === "radio" ? ["ArrowRight", "ArrowDown"] : ["ArrowRight"];
    const at = enabled.findIndex((o) => o.value === latest.current);
    let target: SegmentOption<T> | undefined;
    if (prevKeys.includes(e.key)) target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (nextKeys.includes(e.key)) target = enabled[(at + 1) % enabled.length];
    else if (e.key === "Home") target = enabled[0];
    else if (e.key === "End") target = enabled[enabled.length - 1];
    if (!target) return;
    e.preventDefault();
    select(target.value);
    buttons()[options.indexOf(target)]?.focus();
  };

  /* ---------- Pointer: press feedback and dragging across options ---------- */

  /** The option under (or nearest to) a horizontal pointer position */
  const optionAt = (clientX: number) => {
    let best = -1;
    let dist = Infinity;
    buttons().forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return options[best];
  };

  const endPress = () => {
    press.current = null;
    root.current?.removeAttribute("data-pressed");
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const opt = optionAt(e.clientX);
    if (!opt || opt.disabled) return;
    const touch = e.pointerType === "touch";
    // Touch: picks on lift (so swiping to scroll doesn't pick), but the pill itself can be dragged right away
    const drag = !touch || opt.value === latest.current;
    press.current = { id: e.pointerId, touch, drag, x: e.clientX, moved: false };
    if (drag) root.current?.setAttribute("data-pressed", "");
    if (!touch) {
      select(opt.value);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.abs(e.clientX - p.x) < (p.touch ? 8 : 3)) return;
    p.moved = true;
    if (!p.drag) return;
    const opt = optionAt(e.clientX);
    if (opt && !opt.disabled) select(opt.value);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.touch && !p.moved) {
      const opt = optionAt(e.clientX);
      if (opt) select(opt.value);
    }
    endPress();
  };

  const isTabs = kind === "tabs";

  return (
    <div
      ref={root}
      className={["ui-segc", className].filter(Boolean).join(" ")}
      data-size={size}
      data-variant={variant}
      data-full={fullWidth || undefined}
      data-disabled={disabled || undefined}
    >

      <div ref={scroller} className="ui-segc__scroller" onScroll={fades}>
        <div
          ref={track}
          className="ui-segc__track"
          role={isTabs ? "tablist" : "radiogroup"}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-disabled={disabled || undefined}
          aria-orientation={isTabs ? "horizontal" : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endPress}
          onLostPointerCapture={endPress}
        >
          <span ref={pill} className="ui-segc__pill" aria-hidden="true" />
          {options.map((o, i) => {
            const active = i === activeIndex;
            // Without a label or icon the value names the option; NaN counts show nothing
            const label = o.label ?? (o.icon ? null : String(o.value));
            const count = countText(o.count);
            return (
              <button
                key={String(o.value)}
                type="button"
                className="ui-segc__opt"
                role={isTabs ? "tab" : "radio"}
                aria-checked={isTabs ? undefined : active}
                aria-selected={isTabs ? active : undefined}
                aria-controls={isTabs ? o.controls : undefined}
                aria-label={o.ariaLabel}
                data-active={active || undefined}
                disabled={o.disabled || disabled}
                tabIndex={i === tabbable ? 0 : -1}
                // Keyboard (Enter / Space) and screen readers – pointers are handled on the track
                onClick={() => select(o.value)}
              >
                <span className="ui-segc__content">
                  {o.icon && (
                    <span className="ui-segc__icon" onErrorCapture={(e) => ((e.target as HTMLElement).style.visibility = "hidden")}>
                      {o.icon}
                    </span>
                  )}
                  {/* One weight for both states – only the color changes, so nothing shifts */}
                  {label != null && (
                    <span className="ui-segc__label" dir="auto">
                      {label}
                    </span>
                  )}
                  {count != null && count !== "" && (
                    <span key={String(count)} className="ui-segc__count">
                      {count}
                    </span>
                  )}
                  {o.badge != null && <span className="ui-segc__badge">{o.badge}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}


/** 1284 → "1,284"; NaN and Infinity show nothing */
const countText = (c: number | string | undefined) => (typeof c === "number" ? (Number.isFinite(c) ? c.toLocaleString("en-US") : null) : c);
