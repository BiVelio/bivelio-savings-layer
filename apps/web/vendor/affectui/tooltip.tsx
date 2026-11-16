"use client";

import "./tooltip.css";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  type PointerEvent as ReactPointerEvent,
  type FocusEvent as ReactFocusEvent,
} from "react";

/*
 * Derived from affectUI Pro 'tooltip' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Cambios de BiVelio: ver VENDOR.md (tema claro, CSS en fichero hermano, `kind="definition"` y `tapToggles`).
 */

export type TooltipProps = {
  /** The label – a few words; it wraps at about 240px. Empty or null: only the child is rendered */
  content: ReactNode;
  /** A keyboard shortcut shown after the label, e.g. "⌘K" */
  shortcut?: string;
  /** Exactly one element that takes a ref and focus – a button, a link, an Icon Button */
  children: ReactElement;
  /** Where it shows; it flips to the other side when there is no room */
  side?: "top" | "bottom" | "left" | "right";
  /** Which edges line up: start · center · end (start is the left, or the right in RTL) */
  align?: "start" | "center" | "end";
  /** Gap to the trigger in px */
  offset?: number;
  /** How long the pointer rests on the trigger before it shows, in ms – keyboard focus shows it at once */
  delay?: number;
  /** Never shows it, e.g. when a label is not cut off */
  disabled?: boolean;
  /** Controls it from outside (with onOpenChange); leave it out and it opens on its own */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A class for the label */
  className?: string;
  /** BiVelio: "definition" = the meaning of a term (wider, regular weight) */
  kind?: "label" | "definition";
  /** BiVelio: a tap/click TOGGLES it instead of closing it – for a trigger whose only job is to explain a term,
   *  so the definition is reachable on touch screens too */
  tapToggles?: boolean;
};

/** A neighbour that opens within this many ms of the last one closing shows at once */
const SKIP = 300;
/** The pointer may cross the gap onto the label without it closing (so it can be read under a magnifier) */
const GRACE = 120;

/** Only one label at a time on the page – and the skip-delay window that makes neighbours show at once */
const group: { current: { close: () => void } | null; warmUntil: number } = { current: null, warmUntil: 0 };

export function Tooltip({
  content,
  shortcut,
  children,
  side = "top",
  align = "center",
  offset = 6,
  delay = 500,
  disabled,
  open: openProp,
  onOpenChange,
  className,
  kind = "label",
  tapToggles = false,
}: TooltipProps) {
  const uid = useId();
  const tipId = `${uid}-tip`;
  const keysId = `${uid}-keys`;
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLSpanElement | null>(null);
  const timer = useRef(0);
  // After a click or Escape it stays closed until the pointer leaves or the focus goes
  const blocked = useRef(false);
  const [shown, setShown] = useState(false);
  const [instant, setInstant] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const empty = content == null || typeof content === "boolean" || content === "";
  const open = !disabled && !empty && (openProp ?? shown);

  const change = useRef<(v: boolean) => void>(() => {});
  change.current = (v: boolean) => {
    window.clearTimeout(timer.current);
    if (openProp === undefined) setShown(v);
    if (v !== open) onOpenChange?.(v);
  };
  const me = useRef({ close: () => change.current(false) });

  const show = (now: boolean) => {
    window.clearTimeout(timer.current);
    const el = trigger.current;
    if (disabled || empty || blocked.current || !el || el.getAttribute("aria-expanded") === "true") return;
    // A neighbour is open, or one just closed: no wait and no fade
    const warm = (group.current && group.current !== me.current) || Date.now() < group.warmUntil;
    if (now || warm) {
      setInstant(!!warm);
      change.current(true);
    } else {
      timer.current = window.setTimeout(() => {
        setInstant(false);
        change.current(true);
      }, Math.max(0, delay));
    }
  };
  const hide = (later = false) => {
    window.clearTimeout(timer.current);
    if (later) timer.current = window.setTimeout(() => change.current(false), GRACE);
    else change.current(false);
  };

  // One at a time: opening this one closes the other; closing opens the skip-delay window
  useEffect(() => {
    if (!open) return;
    const self = me.current;
    if (group.current && group.current !== self) group.current.close();
    group.current = self;
    // When the label just repeats the trigger's own name, screen readers only get the shortcut from it
    const el = trigger.current;
    const name = (el?.getAttribute("aria-label") || el?.textContent || "").trim();
    setQuiet(typeof content === "string" && content.trim() === name);
    return () => {
      if (group.current === self) {
        group.current = null;
        group.warmUntil = Date.now() + SKIP;
      }
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Into the top layer next to the trigger before paint; it follows on scroll and resize
  useLayoutEffect(() => {
    const el = tip.current;
    if (!open || !el) return;
    showLayer(el);
    const update = () => {
      const a = trigger.current;
      if (a) place(el, a, side, align, offset);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro?.disconnect();
      hideLayer(el);
    };
  }, [open, side, align, offset]);

  // Escape closes it first – caught early, so a dialog around it stays open
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      blocked.current = true;
      change.current(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);

  // BiVelio (tapToggles): a tap anywhere else closes it – touch has no pointerleave to rely on
  useEffect(() => {
    if (!open || !tapToggles) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (trigger.current?.contains(t) || tip.current?.contains(t))) return;
      change.current(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open, tapToggles]);

  if (!isValidElement(children)) return <>{children}</>;
  const own = children.props as Record<string, unknown> & { ref?: Ref<HTMLElement> };
  const call = (name: string, e: SyntheticEvent) => (own[name] as ((e: SyntheticEvent) => void) | undefined)?.(e);
  // The child's handler runs first; when it calls preventDefault, the tooltip leaves the event alone
  const wrap =
    <E extends SyntheticEvent>(name: string, mine: (e: E) => void) =>
    (e: E) => {
      call(name, e);
      if (!e.defaultPrevented) mine(e);
    };

  const describedBy = [own["aria-describedby"], open && (quiet ? (shortcut ? keysId : null) : tipId)].filter(Boolean).join(" ") || undefined;

  const trig = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (el: HTMLElement | null) => {
      trigger.current = el;
      const r = own.ref;
      if (typeof r === "function") r(el);
      else if (r) (r as { current: HTMLElement | null }).current = el;
    },
    "aria-describedby": describedBy,
    // Touch has no hover: a tap never opens it (the label must not live only in a tooltip)
    onPointerEnter: wrap("onPointerEnter", (e: ReactPointerEvent) => {
      if (e.pointerType !== "touch") show(false);
    }),
    onPointerLeave: wrap("onPointerLeave", (e: ReactPointerEvent) => {
      blocked.current = false;
      if (e.pointerType !== "touch") hide(true);
    }),
    onPointerDown: wrap("onPointerDown", () => {
      if (tapToggles) return;
      blocked.current = true;
      hide();
    }),
    onClick: wrap("onClick", () => {
      if (tapToggles) {
        // The trigger only explains: a tap opens it, the next one (or Escape, or leaving) closes it
        blocked.current = false;
        if (open) hide();
        else show(true);
        return;
      }
      blocked.current = true;
      hide();
    }),
    // Keyboard focus shows it at once; a click's focus does not
    onFocus: wrap("onFocus", (e: ReactFocusEvent) => {
      let visible = true;
      try {
        visible = (e.currentTarget as HTMLElement).matches(":focus-visible");
      } catch {}
      if (visible) show(true);
    }),
    onBlur: wrap("onBlur", () => {
      blocked.current = false;
      hide();
    }),
  });

  return (
    <>
      {trig}
      {open && (
        <span
          ref={tip}
          id={tipId}
          role="tooltip"
          className={["ui-tipc", className].filter(Boolean).join(" ")}
          popover="manual"
          data-side={side}
          data-kind={kind}
          data-instant={instant || undefined}
          // The pointer can rest on the label itself; leaving it closes it
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onPointerLeave={() => hide(true)}
        >
          <span className="ui-tipc__text" dir="auto">
            {content}
          </span>
          {shortcut && (
            <kbd className="ui-tipc__keys" id={keysId}>
              {shortcut}
            </kbd>
          )}
        </span>
      )}
    </>
  );
}

/* ---------- Helpers ---------- */

/** The top layer, so no overflow cuts it and no z-index fights it */
function showLayer(el: HTMLElement) {
  if ("showPopover" in el && !el.matches(":popover-open")) el.showPopover();
}
function hideLayer(el: HTMLElement) {
  if ("hidePopover" in el && el.isConnected && el.matches(":popover-open")) el.hidePopover();
}

/**
 * Puts the fixed label next to the trigger: on the preferred side, or the other one when that has more room (beside it
 * with no room either way: above or under it); the edge it lines up with switches when it would stick out, and it is
 * pushed inside the window as a last resort
 */
function place(el: HTMLElement, trigger: HTMLElement, side: "top" | "bottom" | "left" | "right", align: "start" | "center" | "end", gap: number) {
  const pad = 8;
  const r = trigger.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const room = { bottom: vh - r.bottom - gap - pad, top: r.top - gap - pad, right: vw - r.right - gap - pad, left: r.left - gap - pad };
  const flip = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
  let s: keyof typeof room = side;
  if (room[s] < (s === "top" || s === "bottom" ? h : w) && room[flip[s]] > room[s]) s = flip[s];
  if ((s === "left" || s === "right") && room[s] < w) s = room.top >= h || room.top >= room.bottom ? "top" : "bottom";
  // start and end follow the reading direction above and below
  const rtl = getComputedStyle(trigger).direction === "rtl";
  const a = (s === "top" || s === "bottom") && rtl && align !== "center" ? (align === "start" ? "end" : "start") : align;
  let top: number;
  let left: number;
  if (s === "top" || s === "bottom") {
    top = s === "bottom" ? r.bottom + gap : r.top - gap - h;
    left = a === "start" ? r.left : a === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
    left = Math.min(Math.max(pad, left), vw - pad - w);
  } else {
    left = s === "right" ? r.right + gap : r.left - gap - w;
    top = a === "start" ? r.top : a === "end" ? r.bottom - h : r.top + r.height / 2 - h / 2;
    top = Math.min(Math.max(pad, top), Math.max(pad, vh - pad - h));
  }
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.dataset.side = s;
}

