/*
 * Vendored from affectUI 'Number Ticker' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/*
 * Number Ticker – animated numbers like an odometer, in a single self-contained file.
 * Every digit is a small vertical column that rolls to its new value: up when the number grows, down when it
 * shrinks. BiVelio: by default it does NOT count in from zero (that reads as a live measurement); the first value is
 * painted as is and only later changes roll. Pass `countIn` to get the upstream entrance. Formatting comes from Intl.NumberFormat, so currency signs,
 * separators and percent signs stay put while only the digits move. The styles live in the sibling .css file.
 */

export type NumberTickerProps = {
  /** The number to show */
  value: number;
  /** Intl.NumberFormat options, e.g. { style: "currency", currency: "USD" } */
  format?: Intl.NumberFormatOptions;
  /** Locale for formatting, e.g. "en-US" – defaults to the browser's */
  locale?: string;
  /** Length of a roll in ms (BiVelio default 320, upstream 900) */
  duration?: number;
  /** Wait before the first count-in, in ms (only with `countIn`) */
  delay?: number;
  /** BiVelio: count in from zero on first view, like upstream. Off by default */
  countIn?: boolean;
  className?: string;
};

type Part = { key: string; digit: number } | { key: string; char: string };

/** "$48,240" → parts keyed from the right, so the ones column keeps its identity when the number grows */
function split(text: string): Part[] {
  const chars = Array.from(text);
  const parts: Part[] = [];
  let d = 0;
  let s = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i];
    if (c >= "0" && c <= "9") parts.unshift({ key: `d${d++}`, digit: c.charCodeAt(0) - 48 });
    else parts.unshift({ key: `s${s++}`, char: c });
  }
  return parts;
}

const mod10 = (n: number) => ((n % 10) + 10) % 10;
const ease = (t: number) => 1 - Math.pow(1 - t, 4);
/** Position → transform; the stack holds 0–9 plus a trailing 0, so 9 → 0 rolls seamlessly */
const place = (el: HTMLElement, pos: number) => {
  el.style.transform = `translateY(${(-mod10(pos) / 11) * 100}%)`;
};

type Roll = { pos: number; from: number; to: number };

/** The digit a column was first rendered with – constant, so React never rewrites the inline transform */
const initial = (seen: Map<string, number>, key: string, digit: number) => {
  if (!seen.has(key)) seen.set(key, digit);
  return seen.get(key) as number;
};

export function NumberTicker({ value, format, locale, duration = 320, delay = 0, countIn = false, className }: NumberTickerProps) {
  const fmtKey = JSON.stringify(format ?? {});
  const text = useMemo(
    // NaN or ∞ (no data yet, a division by zero) shows a dash instead of the raw word
    () => (Number.isFinite(value) ? new Intl.NumberFormat(locale, format).format(value) : "–"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, locale, fmtKey],
  );
  const parts = useMemo(() => split(text), [text]);

  const root = useRef<HTMLSpanElement>(null);
  const rolls = useRef(new Map<string, Roll>());
  const stacks = useRef(new Map<string, HTMLElement>());
  const prev = useRef(countIn ? 0 : value);
  const up = useRef(true);
  // BiVelio: without `countIn`, every column starts on its own digit – in the server HTML too
  const first = useRef(new Map<string, number>());
  const settled = useRef(false);
  const mounted = useRef(false);
  const entering = useRef(new Set<string>());
  const seen = useRef(new Set<string>());
  const [started, setStarted] = useState(false);

  // Columns that show up after the first render slide in (e.g. 9,999 → 10,000)
  const keysNow = new Set(parts.filter((p) => "digit" in p).map((p) => p.key));
  for (const k of keysNow) if (mounted.current && !seen.current.has(k)) entering.current.add(k);
  for (const k of entering.current) if (!keysNow.has(k)) entering.current.delete(k);
  seen.current = keysNow;

  // Start once the number scrolls into view
  useEffect(() => {
    mounted.current = true;
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setStarted(true);
      return;
    }
    let timer = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        timer = window.setTimeout(() => setStarted(true), delay);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Roll every digit column to its new value
  useEffect(() => {
    if (!started) return;
    // Same value again (e.g. a format change) keeps the last direction
    if (value !== prev.current) up.current = value > prev.current;
    prev.current = value;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const keys = new Set<string>();

    for (const p of parts) {
      if (!("digit" in p)) continue;
      keys.add(p.key);
      const start = !countIn && !settled.current ? p.digit : 0;
      const r = rolls.current.get(p.key) ?? { pos: start, from: start, to: start };
      const delta = up.current ? mod10(p.digit - r.pos) : -mod10(r.pos - p.digit);
      r.from = r.pos;
      r.to = r.pos + delta;
      if (reduce) r.pos = r.from = r.to;
      rolls.current.set(p.key, r);
    }
    for (const k of rolls.current.keys()) if (!keys.has(k)) rolls.current.delete(k);
    settled.current = true;

    const apply = () => {
      for (const [k, r] of rolls.current) {
        const el = stacks.current.get(k);
        if (el) place(el, r.pos);
      }
    };
    if (reduce) return apply();

    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const e = ease(t);
      for (const r of rolls.current.values()) r.pos = r.from + (r.to - r.from) * e;
      apply();
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [parts, started, value, duration]);

  return (
    <>
      <span ref={root} className={["ui-nt", className].filter(Boolean).join(" ")} aria-live="polite">
        <span className="ui-nt__sr">{text}</span>
        <span className="ui-nt__track" aria-hidden="true">
          {parts.map((p) =>
            "digit" in p ? (
              <span key={p.key} className="ui-nt__col" data-enter={entering.current.has(p.key) || undefined}>
                <span
                  className="ui-nt__stack"
                  style={countIn ? undefined : { transform: `translateY(${(-initial(first.current, p.key, p.digit) / 11) * 100}%)` }}
                  ref={(el) => {
                    if (!el) return;
                    stacks.current.set(p.key, el);
                    place(el, rolls.current.get(p.key)?.pos ?? (countIn ? 0 : initial(first.current, p.key, p.digit)));
                    return () => {
                      if (stacks.current.get(p.key) === el) stacks.current.delete(p.key);
                    };
                  }}
                >
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n, i) => (
                    <span key={i} className="ui-nt__cell">
                      {n}
                    </span>
                  ))}
                </span>
              </span>
            ) : (
              <span key={p.key} className="ui-nt__static">
                {p.char}
              </span>
            ),
          )}
        </span>
      </span>
    </>
  );
}
