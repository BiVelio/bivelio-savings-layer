/*
 * Derived from affectUI Pro 'Gradient Text' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Gradient Text – a text effect. The letters are a mask over a liquid gradient: a few soft colour blobs drift
 * over a two-colour base while the glyphs stay crisp. On first view the colour can sweep across from left to
 * right; the blobs then make ONE pass and come to rest. Font, size and weight come from the parent.
 *
 * BiVelio (WCAG 2.2.2, Pause, Stop, Hide): upstream loops the flow for ever. A headline that keeps moving next
 * to the text being read needs a pause control once it runs past five seconds, and this one sat outside the
 * page's animation control. So it does not loop: one pass of at most FLOW_MAX_S seconds, which starts with the
 * sweep, and then the finished gradient stands still. Under prefers-reduced-motion nothing moves at all.
 *
 * BiVelio: for ONE short phrase of a headline. Never a price, a percentage or a control. The real text stays in
 * the DOM (selectable, read by screen readers); the coloured copy is aria-hidden.
 */

export type GradientTextProps = {
  children: ReactNode;
  /** Gradient start, end and up to two blob colours: [start, end, blob, blob] */
  colors?: string[];
  /** Seconds the single flow pass takes; capped at FLOW_MAX_S */
  speed?: number;
  /** Sweep the colour in from left to right when the text scrolls into view */
  sweep?: boolean;
  /** Element to render */
  as?: "span" | "h1" | "h2" | "p";
  className?: string;
};

/** Longest the flow may run. The sweep (900 ms) runs inside it, so all motion ends under five seconds. */
export const FLOW_MAX_S = 4;

export function GradientText({ children, colors, speed = FLOW_MAX_S, sweep = true, as: Tag = "span", className }: GradientTextProps) {
  const ref = useRef<HTMLElement>(null);
  // "idle" – plain text, waiting to be seen; "in" – the colour sweeps (or simply is) in
  const [state, setState] = useState<"idle" | "in">(sweep ? "idle" : "in");

  useEffect(() => {
    if (!sweep) return setState("in");
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setState("in");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("in");
          io.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sweep]);

  const style = { "--ui-gt-speed": `${Math.min(Math.max(speed, 0), FLOW_MAX_S)}s` } as Record<string, string>;
  if (colors?.length) {
    const [a, b = a, c = a, d = b] = colors;
    Object.assign(style, { "--ui-gt-c1": a, "--ui-gt-c2": b, "--ui-gt-c3": c, "--ui-gt-c4": d });
  }

  return (
    <Tag
      ref={ref as never}
      className={["ui-gt", className].filter(Boolean).join(" ")}
      data-state={state}
      data-sweep={sweep ? "" : undefined}
      style={style as CSSProperties}
    >
      {/* The real text: sets the size, carries selection and screen readers, shows until the colour arrives */}
      <span className="ui-gt__base">{children}</span>
      {/* The same text again, filled with the flowing gradient */}
      <span className="ui-gt__fill" aria-hidden="true">
        {children}
      </span>
    </Tag>
  );
}
