/*
 * Derived from affectUI Pro 'Blur Crossfade' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";


import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/*
 * Blur Crossfade – swaps content with a soft blur while the box glides to the new size,
 * in a single self-contained file. Change `id` and the old content blurs out as the new one
 * blurs in; height (and optionally width) morphs from old to new.
 * The styles live in the sibling .css file.
 */

export type BlurCrossfadeProps = {
  /** Change this to swap – the children of the old id fade out, the new ones fade in */
  id: string | number;
  children?: ReactNode;
  /** Length of the swap in ms */
  duration?: number;
  /** Blur in px at the start and end of the fade */
  blur?: number;
  /** Which sides glide to the new size; "both" sizes the box to its content */
  morph?: "height" | "both" | "none";
  /** Root element – use span inside buttons and other inline content */
  as?: "div" | "span";
  className?: string;
  style?: CSSProperties;
};

type Exit = { id: string | number; node: ReactNode; n: number; w: number; h: number };

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function BlurCrossfade({
  id,
  children,
  duration = 240,
  blur = 6,
  morph = "height",
  as: Tag = "div",
  className,
  style,
}: BlurCrossfadeProps) {
  const rootRef = useRef<HTMLElement>(null);
  const curRef = useRef<HTMLElement>(null);
  const [exit, setExit] = useState<Exit | null>(null);
  const lastId = useRef(id);
  // Children and size of what is on screen, kept for the moment it has to leave
  const lastNode = useRef<ReactNode>(children);
  const size = useRef({ w: 0, h: 0 });
  const busy = useRef(false);
  const timer = useRef(0);
  const counter = useRef(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const layer = curRef.current;
    if (id === lastId.current || !root || !layer) {
      lastNode.current = children;
      return;
    }
    lastId.current = id;
    const leaving = lastNode.current;
    lastNode.current = children;
    window.clearTimeout(timer.current);

    const to = { w: layer.offsetWidth, h: layer.offsetHeight };
    if (reduced() || duration <= 0) {
      setExit(null);
      root.style.height = root.style.width = root.style.transition = "";
      root.removeAttribute("data-busy");
      busy.current = false;
      size.current = to;
      return;
    }

    // Mid-swap the box is already animating – start from where it is right now
    const r = root.getBoundingClientRect();
    const from = busy.current ? { w: r.width, h: r.height } : size.current;
    setExit({ id: lastId.current, node: leaving, n: ++counter.current, w: size.current.w, h: size.current.h });
    size.current = to;
    busy.current = true;
    root.setAttribute("data-busy", "");

    if (morph !== "none") {
      root.style.transition = "none";
      root.style.height = `${from.h}px`;
      if (morph === "both") root.style.width = `${from.w}px`;
      void root.offsetHeight;
      const t = `${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      root.style.transition = morph === "both" ? `height ${t}, width ${t}` : `height ${t}`;
      root.style.height = `${to.h}px`;
      if (morph === "both") root.style.width = `${to.w}px`;
    }

    timer.current = window.setTimeout(() => {
      root.style.height = root.style.width = root.style.transition = "";
      root.removeAttribute("data-busy");
      busy.current = false;
      setExit(null);
    }, duration + 30);
  });

  // Keep the resting size current when the content changes on its own
  useEffect(() => {
    const layer = curRef.current;
    if (!layer || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!busy.current) size.current = { w: layer.offsetWidth, h: layer.offsetHeight };
    });
    ro.observe(layer);
    size.current = { w: layer.offsetWidth, h: layer.offsetHeight };
    return () => ro.disconnect();
  }, [id]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const vars = {
    "--ui-bx-duration": `${duration}ms`,
    "--ui-bx-blur": `${blur}px`,
    ...style,
  } as CSSProperties;

  const Layer = Tag;
  return (
    <>
      <Tag
        ref={rootRef as never}
        className={["ui-bx", `ui-bx--${morph}`, className].filter(Boolean).join(" ")}
        style={vars}
      >
        <Layer
          key={`c-${id}`}
          ref={curRef as never}
          className={`ui-bx__layer${exit ? " ui-bx__layer--in" : ""}`}
        >
          {children}
        </Layer>
        {exit && (
          <Layer
            key={`x-${exit.id}-${exit.n}`}
            className="ui-bx__layer ui-bx__layer--out"
            aria-hidden="true"
            inert
            style={{ width: exit.w || undefined }}
          >
            {exit.node}
          </Layer>
        )}
      </Tag>
    </>
  );
}
