/*
 * Derived from affectUI Pro 'Gradient Text' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./gradient-text.css";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Gradient Text – a text effect. The letters are a mask over a liquid gradient: a few soft colour blobs drift
 * over a two-colour base, so the phrase keeps flowing while the glyphs stay crisp. On first view the colour can
 * sweep across from left to right before it settles into the flow. Font, size and weight come from the parent.
 *
 * BiVelio: for ONE short phrase of a headline. Never a price, a percentage or a control. The real text stays in
 * the DOM (selectable, read by screen readers); the coloured copy is aria-hidden.
 */

export type GradientTextProps = {
  children: ReactNode;
  /** Gradient start, end and up to two blob colours: [start, end, blob, blob] */
  colors?: string[];
  /** Seconds per flow cycle */
  speed?: number;
  /** Sweep the colour in from left to right when the text scrolls into view */
  sweep?: boolean;
  /** Element to render */
  as?: "span" | "h1" | "h2" | "p";
  className?: string;
};

export function GradientText({ children, colors, speed = 12, sweep = true, as: Tag = "span", className }: GradientTextProps) {
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

  const style = { "--ui-gt-speed": `${speed}s` } as Record<string, string>;
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
