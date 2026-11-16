/*
 * Derived from affectUI Pro 'toaster' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./toaster.css";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/*
 * Toaster – calm toasts with an imperative API: put <Toaster /> once, then call toast("Saved").
 * BiVelio fork, REDUCED: one corner, a plain column (no fan of cards peeking behind each other), no swipe, no
 * promise / loading morph, no rich colors. What stays: the white card with its hairline, the 16px status icon, ONE
 * action (the place for "Undo"), a close button and a timer that pauses while the pointer or the focus is on the
 * toast. The list is a polite live region, so a toast is announced without stealing the focus.
 * No default strings: the labels of the region and of the close button are props of <Toaster />.
 */

export type ToastType = "default" | "success" | "info";
export type ToastOptions = {
  description?: ReactNode;
  type?: ToastType;
  /** ms before it leaves on its own (default 6000). `Infinity` keeps it until closed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** A toast with the same id replaces the one on screen instead of piling up */
  id?: string;
};
type Toast = ToastOptions & { key: string; title: ReactNode; n: number };

const MAX = 3;
let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const EMPTY: Toast[] = [];

export function toast(title: ReactNode, options: ToastOptions = {}): string {
  const key = options.id ?? `t${++seq}`;
  const next: Toast = { ...options, key, title, n: ++seq };
  toasts = [...toasts.filter((t) => t.key !== key), next].slice(-MAX);
  emit();
  return key;
}
toast.dismiss = (key?: string) => {
  toasts = key ? toasts.filter((t) => t.key !== key) : [];
  emit();
};

export function Toaster({ label, closeLabel }: { /** Accessible name of the region */ label: string; closeLabel: string }) {
  const list = useSyncExternalStore(subscribe, () => toasts, () => EMPTY);
  // Leaving the page that owns the toaster takes its toasts with it
  useEffect(() => () => toast.dismiss(), []);
  return (
    <section className="ui-tsc" aria-label={label}>
      <ol className="ui-tsc__list" role="status" aria-live="polite" aria-relevant="additions text">
        {list.map((t) => (
          <ToastCard key={`${t.key}-${t.n}`} toast={t} closeLabel={closeLabel} />
        ))}
      </ol>
    </section>
  );
}

function ToastCard({ toast: t, closeLabel }: { toast: Toast; closeLabel: string }) {
  const el = useRef<HTMLLIElement>(null);
  const ms = t.duration ?? 6000;
  // The timer is the CSS animation of the hairline: it pauses on hover and focus by itself, and when it ends the
  // toast leaves. With reduced motion the hairline is not drawn, so a plain timeout does the same job.
  useEffect(() => {
    if (!Number.isFinite(ms)) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) return;
    const id = window.setTimeout(() => toast.dismiss(t.key), ms);
    return () => window.clearTimeout(id);
  }, [ms, t.key]);
  const type = t.type ?? "default";
  return (
    <li ref={el} className="ui-tsc__toast">
      <div className="ui-tsc__card">
        <div className="ui-tsc__content">
          {type !== "default" && (
            <span className="ui-tsc__icon" data-type={type} aria-hidden="true">
              <svg className="ui-tsc__status" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6.5" strokeOpacity="0.28" />
                {type === "success" ? <path d="m5.2 8.2 1.9 1.9 3.7-4" /> : <path d="M8 7.4v3.4M8 5.1v.1" />}
              </svg>
            </span>
          )}
          <div className="ui-tsc__text">
            <div className="ui-tsc__title">{t.title}</div>
            {t.description ? <div className="ui-tsc__desc">{t.description}</div> : null}
          </div>
          {t.action ? (
            <button
              type="button"
              className="ui-tsc__action"
              onClick={() => {
                t.action?.onClick();
                toast.dismiss(t.key);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="ui-tsc__close" aria-label={closeLabel} onClick={() => toast.dismiss(t.key)}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        {Number.isFinite(ms) ? (
          <span
            className="ui-tsc__timer"
            style={{ ["--ui-tsc-ms" as string]: `${ms}ms` }}
            onAnimationEnd={(e) => {
              if (e.animationName === "ui-tsc-timer") toast.dismiss(t.key);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
