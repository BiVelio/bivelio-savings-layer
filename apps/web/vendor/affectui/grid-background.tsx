/*
 * Derived from affectUI Pro 'Grid Background' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Grid Background – a fine line grid behind your content, in a single self-contained file.
 * The grid drifts slowly by one cell per loop and fades out towards the edges through a radial mask.
 * On first view it can be uncovered by a circle that grows from the center.
 * Reduced motion: the grid stays still and appears without the reveal.
 */

export type GridDirection = "up" | "down" | "left" | "right" | "diagonal";

export type GridBackgroundProps = {
  /** Content rendered above the grid */
  children?: ReactNode;
  /** Cell size in px */
  size?: number;
  /** Line color – defaults to a faint black, or a faint white in dark mode */
  color?: string;
  /** Seconds per cell; 0 keeps the grid still */
  speed?: number;
  /** Drift direction; "diagonal" runs from top right to bottom left */
  direction?: GridDirection;
  /** Uncover the grid with a growing circle when it first comes into view */
  reveal?: boolean;
  /** Radius of the edge fade, in % of the distance to the corners */
  fade?: number;
  className?: string;
};

const offsets: Record<GridDirection, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  diagonal: [-1, 1],
};

export function GridBackground({
  children,
  size = 56,
  color,
  speed = 14,
  direction = "diagonal",
  reveal = true,
  fade = 78,
  className,
}: GridBackgroundProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(!reveal);

  // Reveal once the grid scrolls into view (right away with reduced motion or without IntersectionObserver)
  useEffect(() => {
    if (!reveal) return setShown(true);
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reveal]);

  const [dx, dy] = offsets[direction] ?? offsets.diagonal;
  const style = {
    "--ui-gb-size": `${size}px`,
    "--ui-gb-dx": `${dx * size}px`,
    "--ui-gb-dy": `${dy * size}px`,
    "--ui-gb-speed": `${Math.max(speed, 0)}s`,
    "--ui-gb-fade": `${fade}%`,
    ...(color ? { "--ui-gb-line": color } : {}),
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={["ui-gb", className].filter(Boolean).join(" ")}
      style={style}
      data-reveal={reveal ? "" : undefined}
      data-shown={shown ? "" : undefined}
      data-static={speed > 0 ? undefined : ""}
    >
      <div className="ui-gb-grid" aria-hidden="true">
        <div className="ui-gb-reveal">
          <div className="ui-gb-lines" />
        </div>
      </div>
      <div className="ui-gb-content">{children}</div>
    </div>
  );
}
