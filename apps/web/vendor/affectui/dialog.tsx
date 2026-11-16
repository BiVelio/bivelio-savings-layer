/*
 * Derived from affectUI Pro 'Dialog' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./dialog.css";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

/*
 * Dialog – a single self-contained file, clean style.
 * A modal window on a dimmed backdrop: a title and a quiet line, any content, a footer for the actions and a close ×.
 * It is a native <dialog> opened with showModal(), so it sits in the top layer, the page behind it is inert and the
 * browser keeps the focus inside. Escape and a press on the backdrop close it, the focus goes to the first control
 * (or one you pick) and back to what opened it, and the page under it stops scrolling. Long content scrolls inside
 * while the title and the actions stay put. On phones it becomes a sheet from the bottom.
 * AlertDialog, exported from the same file, asks to confirm one thing: no backdrop close, the focus on the safe
 * action, a red confirm button for things that can't be undone.
 * The styles live in the sibling .css file.
 */

type TriggerProps = {
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void;
  "aria-haspopup"?: "dialog";
  "aria-expanded"?: boolean;
};

type Shared = Omit<ComponentPropsWithoutRef<"dialog">, "title" | "open" | "children" | "onCancel" | "onClose"> & {
  /** Shows it – pass it with onOpenChange to control it, or leave it out and use trigger */
  open?: boolean;
  /** Open from the start when it isn't controlled */
  defaultOpen?: boolean;
  /** Called with false on Escape, a backdrop press, the × or an action – and with true from the trigger */
  onOpenChange?: (open: boolean) => void;
  /** A button that opens it – it gets the click, aria-haspopup and aria-expanded, and the focus back on close */
  trigger?: ReactElement<TriggerProps>;
  /** The heading – it also names the dialog */
  title: ReactNode;
  /** A quiet line under the title – read out with it */
  description?: ReactNode;
  /** sm: 400px · md: 480px · lg: 720px – never wider than the window */
  size?: "sm" | "md" | "lg";
  /** Any width instead of a size, e.g. 560 or "40rem" */
  width?: number | string;
  /** The control that gets the focus on open – by default the first one in the content, then in the footer */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Stays inside its nearest positioned parent (an app frame, a preview) instead of covering the window */
  contained?: boolean;
};

export type DialogProps = Shared & {
  /** The content – it scrolls when it is taller than the window */
  children?: ReactNode;
  /** The actions, aligned to the end – they stay in view while the content scrolls */
  footer?: ReactNode;
  /** A press on the backdrop closes it */
  closeOnBackdrop?: boolean;
  /** Shows the close × in the corner */
  closeButton?: boolean;
  /** The ×'s accessible name and tooltip */
  closeLabel: string;
};

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  size = "md",
  width,
  initialFocus,
  contained,
  children,
  footer,
  closeOnBackdrop = true,
  closeButton = true,
  closeLabel,
  ...rest
}: DialogProps) {
  const [isOpen, setOpen, opener] = useOpenState(open, defaultOpen, onOpenChange);
  return (
    <>
      {withTrigger(trigger, isOpen, setOpen, opener)}
      <Layer
        {...rest}
        open={isOpen}
        onDismiss={() => setOpen(false)}
        title={title}
        description={description}
        size={size}
        width={width}
        initialFocus={initialFocus}
        contained={contained}
        closeOnBackdrop={closeOnBackdrop}
        opener={opener}
        close={closeButton ? { label: closeLabel, onClick: () => setOpen(false) } : undefined}
        footer={footer}
      >
        {children}
      </Layer>
    </>
  );
}

export type AlertDialogProps = Shared & {
  /** More than the description – a list of what goes, a checkbox */
  children?: ReactNode;
  /** The confirm button's label – say what happens, e.g. "Delete agent" */
  confirmLabel: ReactNode;
  /** The safe button's label – it gets the focus */
  cancelLabel: ReactNode;
  /** Confirmed – return a promise to keep it open with a busy button until it settles (it stays open if it fails) */
  onConfirm?: () => void | Promise<unknown>;
  /** Cancelled – by the button, Escape or the trigger again */
  onCancel?: () => void;
  /** A red confirm button – for things that can't be undone */
  danger?: boolean;
};

export function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  size = "sm",
  width,
  initialFocus,
  contained,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger,
  ...rest
}: AlertDialogProps) {
  const [isOpen, setOpen, opener] = useOpenState(open, defaultOpen, onOpenChange);
  const [busy, setBusy] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (busy) return;
    onCancel?.();
    setOpen(false);
  };
  const confirm = async () => {
    if (busy) return;
    const result = onConfirm?.();
    if (!result || typeof (result as Promise<unknown>).then !== "function") return setOpen(false);
    setBusy(true);
    try {
      await result;
      setOpen(false);
    } catch {
      // Stays open, so it can be tried again
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {withTrigger(trigger, isOpen, setOpen, opener)}
      <Layer
        {...rest}
        alert
        open={isOpen}
        onDismiss={cancel}
        title={title}
        description={description}
        size={size}
        width={width}
        initialFocus={initialFocus ?? safe}
        contained={contained}
        closeOnBackdrop={false}
        busy={busy}
        opener={opener}
        footer={
          <>
            <button ref={safe} type="button" className="ui-dlgc__btn" disabled={busy} onClick={cancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className="ui-dlgc__btn"
              data-tone={danger ? "danger" : "primary"}
              data-busy={busy || undefined}
              aria-disabled={busy || undefined}
              onClick={confirm}
            >
              <span className="ui-dlgc__btn-label">{confirmLabel}</span>
              {busy && <span className="ui-dlgc__spin" aria-hidden="true" />}
            </button>
          </>
        }
      >
        {children}
      </Layer>
    </>
  );
}

/* ---------- The layer both build on ---------- */

type LayerProps = Omit<Shared, "defaultOpen" | "onOpenChange" | "trigger"> & {
  open: boolean;
  onDismiss: () => void;
  closeOnBackdrop: boolean;
  opener: RefObject<HTMLElement | null>;
  alert?: boolean;
  busy?: boolean;
  close?: { label: string; onClick: () => void };
  footer?: ReactNode;
  children?: ReactNode;
};

/** How long the way out takes – the backdrop and the card fade, a sheet slides down */
const EXIT_MS = 200;

function Layer({
  open,
  onDismiss,
  title,
  description,
  size = "md",
  width,
  initialFocus,
  contained,
  closeOnBackdrop,
  opener,
  alert,
  busy,
  close,
  footer,
  children,
  className,
  style,
  ...rest
}: LayerProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const layer = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const blocked = useRef(busy);
  blocked.current = busy;
  // Contained and open from the first render (a demo, a restored view) leaves the focus where it is
  const firstOpen = useRef(open);

  // Shown while open and through the way out; a new open during the way out picks it up again
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [was, setWas] = useState(open);
  if (open !== was) {
    setWas(open);
    if (open) {
      setShown(true);
      setLeaving(false);
    } else if (shown) setLeaving(true);
  }
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, reduced() ? 0 : EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  // Open: into the top layer (or in place when contained), the page locked, the focus inside; closed: all undone
  useLayoutEffect(() => {
    const el = layer.current;
    if (!shown || !el) return;
    const back = opener.current ?? (document.activeElement as HTMLElement | null);
    opener.current = null;
    const modal = !contained;
    if (!el.open) {
      if (modal) el.showModal();
      else el.show();
    }
    if (modal) lockScroll();
    if (modal || !firstOpen.current) {
      const target =
        initialFocus?.current ??
        el.querySelector<HTMLElement>("[data-autofocus]") ??
        firstControl(el.querySelector(".ui-dlgc__body")) ??
        firstControl(el.querySelector(".ui-dlgc__foot")) ??
        firstControl(el) ??
        panel.current;
      target?.focus({ preventScroll: true });
    }
    firstOpen.current = false;

    // Escape: the native cancel when modal, a key listener when contained
    const cancel = (e: Event) => {
      e.preventDefault();
      if (!blocked.current) dismiss.current();
    };
    // Closed by the browser itself (a second Escape) – tell the owner; while busy it opens again
    const closed = () => {
      // A close from an earlier run of this effect (React re-runs it, e.g. in Strict Mode) lands while it's open again
      if (el.open) return;
      if (!blocked.current) return dismiss.current();
      if (modal) el.showModal();
      else el.show();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Keeps a page's own Escape (closing a detail view) from firing as well
        e.stopPropagation();
        if (!modal && !e.defaultPrevented) cancel(e);
      }
      if (e.key === "Tab" && !modal) trapTab(e, el);
    };
    el.addEventListener("cancel", cancel);
    el.addEventListener("close", closed);
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("cancel", cancel);
      el.removeEventListener("close", closed);
      el.removeEventListener("keydown", key);
      const inside = el.contains(document.activeElement);
      if (el.open) el.close();
      if (modal) unlockScroll();
      const at = document.activeElement;
      if (back?.isConnected && (inside || !at || at === document.body)) back.focus({ preventScroll: true });
    };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // A press that starts and ends on the backdrop closes it; when it can't, the card gives a small nudge instead
  const downOnBackdrop = useRef(false);
  const onBackdrop = (e: ReactMouseEvent<HTMLDialogElement>) => {
    const hit = downOnBackdrop.current && e.target === e.currentTarget;
    downOnBackdrop.current = false;
    if (!hit || leaving) return;
    if (closeOnBackdrop && !busy) return dismiss.current();
    if (!reduced()) panel.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.012)" }, { transform: "scale(1)" }], { duration: 240, easing: "ease-out" });
  };

  if (!shown) return null;
  const panelStyle = width != null ? ({ "--ui-dlgc-w": typeof width === "number" ? `${width}px` : width } as CSSProperties) : undefined;

  return (
    <dialog
      {...rest}
      ref={layer}
      className={["ui-dlgc", className].filter(Boolean).join(" ")}
      style={style}
      role={alert ? "alertdialog" : rest.role}
      aria-modal={contained ? true : undefined}
      aria-labelledby={titleId}
      aria-describedby={shows(description) ? descId : rest["aria-describedby"]}
      aria-busy={busy || undefined}
      data-contained={contained || undefined}
      data-leaving={leaving || undefined}
      onPointerDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={onBackdrop}
    >
      <div ref={panel} className="ui-dlgc__panel" data-size={size} data-alert={alert || undefined} tabIndex={-1} style={panelStyle}>
        <div className="ui-dlgc__head">
          <div className="ui-dlgc__heading">
            <h2 className="ui-dlgc__title" id={titleId}>
              {title}
            </h2>
            {shows(description) && (
              <p className="ui-dlgc__desc" id={descId}>
                {description}
              </p>
            )}
          </div>
          {close && (
            <button type="button" className="ui-dlgc__close" aria-label={close.label} title={close.label} onClick={close.onClick}>
              {/* Cancel01 – Hugeicons Free (MIT, © Hugeicons, hugeicons.com) */}
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                <path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {shows(children) && <div className="ui-dlgc__body">{children}</div>}
        {shows(footer) && <div className="ui-dlgc__foot">{footer}</div>}
      </div>
    </dialog>
  );
}

/* ---------- Helpers ---------- */

/** Controlled when open is passed, its own state otherwise; the third value remembers the trigger for the way back */
function useOpenState(open: boolean | undefined, defaultOpen: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [own, setOwn] = useState(defaultOpen ?? false);
  const opener = useRef<HTMLElement | null>(null);
  const controlled = open !== undefined;
  const value = controlled ? open : own;
  const set = (next: boolean) => {
    if (next === value) return;
    if (!controlled) setOwn(next);
    onOpenChange?.(next);
  };
  return [value, set, opener] as const;
}

/** The trigger with the click that opens it – it is remembered, so the focus comes back to it even in Safari */
function withTrigger(trigger: ReactElement<TriggerProps> | undefined, open: boolean, setOpen: (open: boolean) => void, opener: RefObject<HTMLElement | null>) {
  if (!isValidElement(trigger)) return null;
  return cloneElement(trigger, {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      trigger.props.onClick?.(e);
      if (e.defaultPrevented) return;
      opener.current = e.currentTarget;
      setOpen(true);
    },
  });
}

/** Text or an element – not true, false, null or an empty string */
const shows = (v: ReactNode) => v != null && typeof v !== "boolean" && v !== "";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const FOCUSABLE = "input, textarea, select, button, [href], [tabindex], [contenteditable='true']";

/** The controls inside that are shown and reachable by Tab */
const controls = (root: Element | null) =>
  root
    ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
      )
    : [];
const firstControl = (root: Element | null) => controls(root)[0] ?? null;

/** Contained: Tab and Shift+Tab go round inside, like the browser does for a modal */
function trapTab(e: KeyboardEvent, root: HTMLElement) {
  const list = controls(root);
  if (!list.length) return e.preventDefault();
  const first = list[0];
  const last = list[list.length - 1];
  const at = document.activeElement;
  const outside = !at || !list.includes(at as HTMLElement);
  if (e.shiftKey && (at === first || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || outside)) {
    e.preventDefault();
    first.focus();
  }
}

/** The page stops scrolling while a dialog is open – counted, so stacked dialogs unlock only once the last closes */
let locks = 0;
let saved: { overflow: string; gutter: string } | null = null;
function lockScroll() {
  if (locks++ > 0) return;
  const html = document.documentElement;
  // The scrollbar's room is kept, so the page doesn't shift sideways
  const bar = window.innerWidth - html.clientWidth;
  saved = { overflow: html.style.overflow, gutter: html.style.scrollbarGutter };
  html.style.overflow = "hidden";
  if (bar > 0) html.style.scrollbarGutter = "stable";
}
function unlockScroll() {
  if (--locks > 0 || !saved) return;
  locks = 0;
  const html = document.documentElement;
  html.style.overflow = saved.overflow;
  html.style.scrollbarGutter = saved.gutter;
  saved = null;
}
