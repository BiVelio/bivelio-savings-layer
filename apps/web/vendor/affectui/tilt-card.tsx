/*
 * Derived from affectUI Pro 'Tilt Card' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./tilt-card.css";
import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";

/*
 * Tilt Card – a card that tilts in 3D towards the pointer, in a single self-contained file.
 * A soft glare follows the pointer and the card lifts a little; on leave it springs back smoothly.
 * Pointer moves are batched with requestAnimationFrame and written to CSS variables (--rx, --ry, --gx, --gy).
 * Touch pointers don't tilt. Keyboard focus inside the card gives a slight lift.
 * Reduced motion: no tilt, only the shadow changes.
 */

export type TiltCardProps = {
  /** The card's content – it fills the tilting surface */
  children?: ReactNode;
  /** Maximum tilt in degrees */
  maxTilt?: number;
  /** Show a soft glare that follows the pointer */
  glare?: boolean;
  /** Scale while the pointer is over the card */
  scale?: number;
  /** Perspective distance in px – smaller is more dramatic */
  perspective?: number;
  className?: string;
};

export function TiltCard({ children, maxTilt = 5, glare = true, scale = 1.01, perspective = 1100, className }: TiltCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const point = useRef<{ x: number; y: number } | null>(null);
  const still = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => (still.current = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => {
      mq.removeEventListener("change", sync);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  // Read the pointer relative to the untransformed wrapper, so the tilt itself never feeds back
  const apply = () => {
    frame.current = 0;
    const r = root.current, c = card.current, p = point.current;
    if (!r || !c || !p) return;
    const box = r.getBoundingClientRect();
    const x = Math.min(Math.max((p.x - box.left) / box.width, 0), 1);
    const y = Math.min(Math.max((p.y - box.top) / box.height, 0), 1);
    c.style.setProperty("--rx", `${((0.5 - y) * 2 * maxTilt).toFixed(2)}deg`);
    c.style.setProperty("--ry", `${((x - 0.5) * 2 * maxTilt).toFixed(2)}deg`);
    c.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
    c.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    const c = card.current;
    if (c && !c.hasAttribute("data-active")) c.setAttribute("data-active", "");
    if (still.current) return;
    point.current = { x: e.clientX, y: e.clientY };
    if (!frame.current) frame.current = requestAnimationFrame(apply);
  };

  const onLeave = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    point.current = null;
    const c = card.current;
    if (!c) return;
    c.removeAttribute("data-active");
    c.style.setProperty("--rx", "0deg");
    c.style.setProperty("--ry", "0deg");
  };

  const style = {
    "--ui-tc-perspective": `${perspective}px`,
    "--ui-tc-scale": scale,
  } as CSSProperties;

  return (
    <div
      ref={root}
      className={["ui-tc", className].filter(Boolean).join(" ")}
      style={style}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerCancel={onLeave}
    >
      <div ref={card} className="ui-tc-card">
        {children}
        {glare && <span className="ui-tc-glare" aria-hidden="true" />}
      </div>
    </div>
  );
}
