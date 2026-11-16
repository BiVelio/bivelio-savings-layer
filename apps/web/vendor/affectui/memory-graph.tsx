/*
 * Derived from affectUI Pro 'Memory Graph' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./memory-graph.css";
import { useId, type CSSProperties } from "react";

/*
 * Memory Graph – what something remembers, in a ring around it. Upstream is an agent with its memories (each a card
 * with the file it came from) and its tools, with details, Forget, Add and switches. BiVelio keeps the drawing and
 * its three gestures, as one small picture with no words in it:
 *   · the one that remembers in the middle, with upstream's pixel mark – it twinkles while it looks something up
 *   · what it remembers on both sides, each a small card; Agent Tree's soft blue connectors with rounded corners
 *     and a ring at each end
 *   · recall – a light runs out to the memory, the card lights up and its line stays lit
 *   · learn – a light runs out to an empty spot, the new card rises there, and a Gradient Floor comes up across it
 *     from the edge the light came in by
 * A memory here is a request seen a moment ago, so a card is only the shape of one: there is no text, no file, no
 * date and no count to invent. Gone with them: tools, the details card, Forget, Add, the switches, "+N more", the
 * measuring layout and every script – this is a server component, and it is still until its classes are animated.
 */

/** A remembered request · the one that is recalled (lights up) · the empty spot where a new one is learned */
export type MemorySpot = "memory" | "recalled" | "learned";

export type MemoryGraphProps = {
  /** Up to three spots on each side, top to bottom */
  left: readonly MemorySpot[];
  right: readonly MemorySpot[];
  /** Seeds the pixel mark, as upstream */
  id?: string;
  className?: string;
};

/* Fixed geometry (the picture scales as a whole): card, the one in the middle, and the ring of spots */
const W = 300;
const H = 104;
const CARD_W = 88;
const CARD_H = 24;
const HUB = 30;
const PAD = 6;
const ROWS = [18, 52, 86];
const BAND = 26;

/** Twinkle order of a pixel mark – a diagonal wave */
const WAVE = [0, 120, 240, 120, 240, 360, 240, 360, 480];
/** The pixel mark: a 3×3 pattern, mirrored left to right, from the id – never fewer than five squares */
const pattern = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let k = 0; k < 64; k++) {
    const bits = (h >> (k % 26)) & 63;
    const cells = [0, 1, 2].flatMap((r) => {
      const a = (bits >> (r * 2)) & 1;
      const b = (bits >> (r * 2 + 1)) & 1;
      return [a, b, a];
    });
    if (cells.filter(Boolean).length >= 5) return cells;
    h = (h * 1103515245 + 12345) >>> 0;
  }
  return [1, 0, 1, 0, 1, 0, 1, 0, 1];
};

/** Out sideways, a rounded turn onto a vertical bar, a rounded turn back and into the card – straight when level */
const elbowX = (x1: number, y1: number, x2: number, y2: number, bar: number, R = 8) => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 2) return `M${x1} ${y1}H${x2}`;
  const s1 = Math.sign(bar - x1) || 1;
  const s2 = Math.sign(x2 - bar) || 1;
  const sy = Math.sign(dy);
  const r = Math.max(0, Math.min(R, Math.abs(dy) / 2, Math.abs(bar - x1), Math.abs(x2 - bar)));
  return `M${x1} ${y1}H${bar - s1 * r}Q${bar} ${y1} ${bar} ${y1 + sy * r}V${y2 - sy * r}Q${bar} ${y2} ${bar + s2 * r} ${y2}H${x2}`;
};

/** The two lines of a card: how long each one is, so no two cards look alike */
const LINES: readonly (readonly [number, number])[] = [
  [38, 24],
  [30, 44],
  [46, 20],
  [34, 36],
  [42, 28],
  [28, 40],
];

export function MemoryGraph({ left, right, id = "memory", className }: MemoryGraphProps) {
  const uid = "mg" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hub = { x: (W - HUB) / 2, y: (H - HUB) / 2 };
  const cells = pattern(id);

  const spots = [
    ...left.slice(0, 3).map((kind, i, all) => ({ kind, side: -1 as const, row: all.length === 1 ? 1 : all.length === 2 ? i * 2 : i })),
    ...right.slice(0, 3).map((kind, i, all) => ({ kind, side: 1 as const, row: all.length === 1 ? 1 : all.length === 2 ? i * 2 : i })),
  ].map((s, n) => {
    const x = s.side < 0 ? PAD : W - PAD - CARD_W;
    const cy = ROWS[s.row]!;
    // Where its connector leaves the middle: spread evenly down that side, as upstream
    const from: [number, number] = [s.side < 0 ? hub.x : hub.x + HUB, hub.y + HUB / 2 + (s.row - 1) * 9];
    const to: [number, number] = [s.side < 0 ? x + CARD_W : x, cy];
    const bar = Math.round((from[0] + to[0]) / 2);
    // The light: a band that sweeps from the middle out to the card
    const run = { "--ui-mg-fx": `${s.side < 0 ? from[0] : from[0] - BAND}px`, "--ui-mg-tx": `${s.side < 0 ? to[0] - BAND : to[0]}px`, "--ui-mg-dir": s.side, "--ui-mg-i": n } as CSSProperties;
    return { ...s, n, x, y: cy - CARD_H / 2, cy, from, to, d: elbowX(from[0], from[1], to[0], to[1], bar), run, lines: LINES[n % LINES.length]! };
  });

  /** What is inside a card: a small tile and two lines */
  const inside = (s: (typeof spots)[number]) => (
    <>
      <rect className="ui-mg__tile" x={s.x + 7} y={s.y + 6.5} width="11" height="11" rx="3" />
      <rect className="ui-mg__text" x={s.x + 24} y={s.y + 7} width={s.lines[0]} height="3.5" rx="1.75" />
      <rect className="ui-mg__sub" x={s.x + 24} y={s.y + 13.5} width={s.lines[1]} height="3.5" rx="1.75" />
    </>
  );

  return (
    <svg className={["ui-mg", className].filter(Boolean).join(" ")} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-g`}>
          <stop offset="0" style={{ stopColor: "var(--ui-mg-light)", stopOpacity: 0 }} />
          <stop offset="0.5" style={{ stopColor: "var(--ui-mg-light)", stopOpacity: 1 }} />
          <stop offset="1" style={{ stopColor: "var(--ui-mg-light)", stopOpacity: 0 }} />
        </linearGradient>
        {/* The Gradient Floor, lying along the edge the light comes in by: one per side and tone, soft on both flanks */}
        {(["l", "r"] as const).flatMap((side) =>
          (["light", "ok"] as const).map((tone) => (
            <linearGradient key={side + tone} id={`${uid}-f${side}-${tone}`} x1={side === "l" ? "1" : "0"} x2={side === "l" ? "0" : "1"}>
              <stop offset="0" style={{ stopColor: `var(--ui-mg-${tone})`, stopOpacity: 0 }} />
              <stop offset="0.28" style={{ stopColor: `var(--ui-mg-${tone})`, stopOpacity: 0.5 }} />
              <stop offset="0.6" style={{ stopColor: `var(--ui-mg-${tone})`, stopOpacity: 0.2 }} />
              <stop offset="1" style={{ stopColor: `var(--ui-mg-${tone})`, stopOpacity: 0 }} />
            </linearGradient>
          )),
        )}
        {spots.map((s) => (
          <mask key={`m${s.n}`} id={`${uid}-m${s.n}`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
            <path d={s.d} fill="none" stroke="#fff" strokeWidth="2" />
          </mask>
        ))}
        {spots
          .filter((s) => s.kind !== "memory")
          .map((s) => (
            <clipPath key={`c${s.n}`} id={`${uid}-c${s.n}`}>
              <rect x={s.x} y={s.y} width={CARD_W} height={CARD_H} rx="7" />
            </clipPath>
          ))}
      </defs>

      {/* Connectors, and the light on each */}
      {spots.map((s) => (
        <g key={`l${s.n}`} className="ui-mg__wire" data-kind={s.kind} style={s.run}>
          <path className="ui-mg__line" d={s.d} />
          {s.kind !== "memory" ? <path className="ui-mg__line ui-mg__line--hot" d={s.d} /> : null}
          <g className="ui-mg__light" mask={`url(#${uid}-m${s.n})`}>
            <rect className="ui-mg__band" x="0" y="0" width={BAND} height={H} fill={`url(#${uid}-g)`} />
          </g>
        </g>
      ))}

      {/* The cards */}
      {spots.map((s) => (
        <g key={`c${s.n}`} className="ui-mg__mem" data-kind={s.kind} style={s.run}>
          {s.kind === "learned" ? (
            <>
              <rect className="ui-mg__spot" x={s.x + 0.5} y={s.y + 0.5} width={CARD_W - 1} height={CARD_H - 1} rx="6.5" />
              <g className="ui-mg__new">
                <rect className="ui-mg__node" x={s.x + 0.5} y={s.y + 0.5} width={CARD_W - 1} height={CARD_H - 1} rx="6.5" />
                <g clipPath={`url(#${uid}-c${s.n})`}>
                  <rect className="ui-mg__floor" x={s.x} y={s.y} width={CARD_W} height={CARD_H} fill={`url(#${uid}-f${s.side < 0 ? "l" : "r"}-light)`} />
                </g>
                {inside(s)}
              </g>
            </>
          ) : (
            <>
              <rect className="ui-mg__node" x={s.x + 0.5} y={s.y + 0.5} width={CARD_W - 1} height={CARD_H - 1} rx="6.5" />
              {s.kind === "recalled" ? (
                <>
                  <rect className="ui-mg__hot" x={s.x + 0.5} y={s.y + 0.5} width={CARD_W - 1} height={CARD_H - 1} rx="6.5" />
                  <g clipPath={`url(#${uid}-c${s.n})`}>
                    <rect className="ui-mg__floor" x={s.x} y={s.y} width={CARD_W} height={CARD_H} fill={`url(#${uid}-f${s.side < 0 ? "l" : "r"}-ok)`} />
                  </g>
                </>
              ) : (
                <rect className="ui-mg__seen" x={s.x + 0.5} y={s.y + 0.5} width={CARD_W - 1} height={CARD_H - 1} rx="6.5" />
              )}
              {inside(s)}
              {s.kind === "recalled" ? (
                <g className="ui-mg__tick">
                  <circle cx={s.x + CARD_W - 12} cy={s.cy} r="6" />
                  <path d={`m${s.x + CARD_W - 14.7} ${s.cy + 0.2} 1.9 1.9 3.5-3.9`} />
                </g>
              ) : null}
            </>
          )}
        </g>
      ))}

      {/* A ring where each connector leaves the middle and where it meets its card */}
      {spots.map((s) => (
        <g key={`d${s.n}`} data-kind={s.kind}>
          <circle className="ui-mg__ring" cx={s.from[0]} cy={s.from[1]} r="2" />
          <circle className="ui-mg__ring" cx={s.to[0]} cy={s.to[1]} r="2.25" />
        </g>
      ))}

      {/* The one that remembers */}
      <g className="ui-mg__agent">
        <rect className="ui-mg__avatar" x={hub.x + 0.5} y={hub.y + 0.5} width={HUB - 1} height={HUB - 1} rx="8.5" />
        {(["still", "busy"] as const).map((state) => (
          <g key={state} className="ui-mg__mark" data-busy={state === "busy" ? "" : undefined}>
            {cells.map((on, i) => (
              <rect key={i} className="ui-mg__px" data-on={on ? "" : undefined} x={W / 2 - 7.25 + (i % 3) * 5.25} y={H / 2 - 7.25 + Math.floor(i / 3) * 5.25} width="4" height="4" rx="1" style={state === "busy" ? { animationDelay: `${WAVE[i]}ms` } : undefined} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}
