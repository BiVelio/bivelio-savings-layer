/*
 * Derived from affectUI Pro 'Scroll Area' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./scroll-area-clean.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref, type UIEventHandler } from "react";

/*
 * Scroll Area – a single self-contained file, clean style.
 * A box that scrolls the browser's own way – wheel, trackpad, touch, keyboard, find-in-page – with a slim scrollbar
 * of its own drawn over the content: it shows while you hover or scroll and fades out after, its thumb can be dragged
 * and a press on the track pages. Soft fades at the edges can hint that there is more. The box is a Tab stop only
 * while it actually scrolls, so the arrow keys and Page Up / Down reach it.
 * BiVelio: unchanged behaviour; light theme only, thumb in ink.
 */

export type ScrollAreaProps = Omit<ComponentPropsWithRef<"div">, "onScroll"> & {
  /** Which way it scrolls – vertical, horizontal or both */
  orientation?: "vertical" | "horizontal" | "both";
  /** When the scrollbar shows: on hover and while scrolling · only while scrolling · always (when there is more) */
  type?: "hover" | "scroll" | "always";
  /** Soft fades at the edges where there is more to scroll */
  fade?: boolean;
  /** The most it grows before it scrolls – or give it a height with className / style */
  maxHeight?: number | string;
  /** The element that scrolls – for scrollTo, scrollTop or an observer */
  viewportRef?: Ref<HTMLDivElement>;
  /** Fires on the element that scrolls */
  onScroll?: UIEventHandler<HTMLDivElement>;
};

type Axis = "y" | "x";

export function ScrollArea({
  orientation = "vertical",
  type = "hover",
  fade = false,
  maxHeight,
  viewportRef,
  onScroll,
  className,
  style,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ref,
  ...rest
}: ScrollAreaProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const view = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const thumbs = useRef<Record<Axis, HTMLDivElement | null>>({ y: null, x: null });
  const idle = useRef(0);
  const drag = useRef<{ axis: Axis; from: number; start: number; per: number } | null>(null);
  // Whether it overflows – the only thing that re-renders: the box becomes a Tab stop only then
  const [scrolls, setScrolls] = useState(false);
  const wantY = orientation !== "horizontal";
  const wantX = orientation !== "vertical";

  /** Sizes and moves the thumbs, sets the fades – straight on the elements, no re-render */
  const update = useCallback(() => {
    const v = view.current;
    const r = root.current;
    if (!v || !r) return;
    const cs = getComputedStyle(r);
    const rtl = cs.direction === "rtl";
    const cap = parseFloat(cs.getPropertyValue("--ui-sac-fade")) || 24;
    const has = { y: wantY && v.scrollHeight - v.clientHeight > 1, x: wantX && v.scrollWidth - v.clientWidth > 1 };
    for (const axis of ["y", "x"] as const) {
      r.toggleAttribute(`data-scroll-${axis}`, has[axis]);
      const t = thumbs.current[axis];
      const bar = t?.parentElement;
      if (!has[axis] || !t || !bar) continue;
      const size = axis === "y" ? v.clientHeight : v.clientWidth;
      const full = axis === "y" ? v.scrollHeight : v.scrollWidth;
      const pos = Math.abs(axis === "y" ? v.scrollTop : v.scrollLeft);
      const track = axis === "y" ? bar.clientHeight : bar.clientWidth;
      const len = Math.max(Math.min(24, track), Math.round((track * size) / full));
      const at = full - size > 0 ? ((track - len) * Math.min(pos, full - size)) / (full - size) : 0;
      if (axis === "y") {
        t.style.height = `${len}px`;
        t.style.transform = `translate3d(0, ${at}px, 0)`;
      } else {
        t.style.width = `${len}px`;
        t.style.transform = `translate3d(${rtl ? -at : at}px, 0, 0)`;
      }
      // How far from each end, capped – the fades shrink as you reach an end
      const end = full - size - pos;
      r.style.setProperty(`--ui-sac-${axis}-start`, `${Math.min(pos, cap)}px`);
      r.style.setProperty(`--ui-sac-${axis}-end`, `${Math.min(Math.max(end, 0), cap)}px`);
    }
    if (!has.y) r.style.setProperty("--ui-sac-y-start", "0px"), r.style.setProperty("--ui-sac-y-end", "0px");
    if (!has.x) r.style.setProperty("--ui-sac-x-start", "0px"), r.style.setProperty("--ui-sac-x-end", "0px");
    setScrolls(has.x || has.y);
  }, [wantX, wantY]);

  // Follows the box and its content as either changes size – new rows, a wider window, fonts loading
  useLayoutEffect(() => {
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => update());
    if (view.current) ro.observe(view.current);
    if (content.current) ro.observe(content.current);
    return () => ro.disconnect();
  }, [update]);

  useEffect(() => () => window.clearTimeout(idle.current), []);

  const scrolled: UIEventHandler<HTMLDivElement> = (e) => {
    update();
    // Shown while it moves, then it fades out a moment after the last scroll
    const r = root.current;
    if (r) {
      r.setAttribute("data-scrolling", "");
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => r.removeAttribute("data-scrolling"), 800);
    }
    onScroll?.(e);
  };

  // Dragging the thumb: the pointer's way along the track, turned into the content's way
  const grab = (axis: Axis) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const v = view.current;
    const t = thumbs.current[axis];
    const bar = t?.parentElement;
    if (e.button !== 0 || !v || !t || !bar) return;
    e.preventDefault();
    e.stopPropagation();
    // A zoomed or scaled card: pointer pixels vs. layout pixels
    const rect = bar.getBoundingClientRect();
    const scale = axis === "y" ? rect.height / (bar.offsetHeight || 1) : rect.width / (bar.offsetWidth || 1);
    const track = axis === "y" ? bar.clientHeight : bar.clientWidth;
    const len = axis === "y" ? t.offsetHeight : t.offsetWidth;
    const room = axis === "y" ? v.scrollHeight - v.clientHeight : v.scrollWidth - v.clientWidth;
    drag.current = { axis, from: axis === "y" ? e.clientY : e.clientX, start: axis === "y" ? v.scrollTop : v.scrollLeft, per: room / Math.max(1, track - len) / (scale || 1) };
    t.setPointerCapture(e.pointerId);
    root.current?.setAttribute("data-dragging", "");
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const v = view.current;
    if (!d || !v) return;
    const by = ((d.axis === "y" ? e.clientY : e.clientX) - d.from) * d.per;
    if (d.axis === "y") v.scrollTop = d.start + by;
    else v.scrollLeft = d.start + by;
  };
  const drop = () => {
    drag.current = null;
    root.current?.removeAttribute("data-dragging");
  };

  // A press on the track pages towards it, like the browser's own bar
  const page = (axis: Axis) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const v = view.current;
    const t = thumbs.current[axis];
    if (e.button !== 0 || !v || !t || e.target === t) return;
    e.preventDefault();
    const tr = t.getBoundingClientRect();
    const before = axis === "y" ? e.clientY < tr.top : getComputedStyle(v).direction === "rtl" ? e.clientX > tr.right : e.clientX < tr.left;
    const step = (axis === "y" ? v.clientHeight : v.clientWidth) * 0.9 * (before ? -1 : 1);
    const rtl = axis === "x" && getComputedStyle(v).direction === "rtl" ? -1 : 1;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    v.scrollBy({ [axis === "y" ? "top" : "left"]: step * rtl, behavior: smooth ? "smooth" : "auto" });
  };

  // Stable, so your ref functions run once per element and not on every render
  const setView = useCallback((el: HTMLDivElement | null) => {
    view.current = el;
    assign(viewportRef, el);
  }, [viewportRef]);
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    root.current = el;
    assign(ref, el);
  }, [ref]);

  const bar = (axis: Axis) => (
    <div className="ui-sac__bar" data-axis={axis} aria-hidden="true" onPointerDown={page(axis)}>
      <div
        className="ui-sac__thumb"
        ref={(el) => {
          thumbs.current[axis] = el;
        }}
        onPointerDown={grab(axis)}
        onPointerMove={move}
        onPointerUp={drop}
        onPointerCancel={drop}
        onLostPointerCapture={drop}
      />
    </div>
  );

  return (
    <div
      ref={setRoot}
      className={["ui-sac", className].filter(Boolean).join(" ")}
      data-orientation={orientation}
      data-type={type}
      data-fade={fade ? "" : undefined}
      style={maxHeight != null ? ({ maxHeight, ...style } as CSSProperties) : style}
      {...rest}
    >
      <div
        ref={setView}
        className="ui-sac__viewport"
        // A Tab stop only while there is something to scroll – the arrow keys and Page Up / Down then move it
        tabIndex={scrolls ? 0 : undefined}
        role={ariaLabel || ariaLabelledby ? "region" : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onScroll={scrolled}
      >
        <div ref={content} className="ui-sac__content">
          {children}
        </div>
      </div>
      {wantY && bar("y")}
      {wantX && bar("x")}
    </div>
  );
}

/* ---------- Helpers ---------- */

/** Hands an element to a ref of yours, a function or an object */
function assign<T>(ref: Ref<T> | undefined, el: T | null) {
  if (typeof ref === "function") ref(el);
  else if (ref) (ref as { current: T | null }).current = el;
}
