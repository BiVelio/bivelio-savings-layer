/*
 * Derived from affectUI Pro 'Fallback Chain' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./fallback-chain.css";
import { useId, type CSSProperties, type ElementType, type ReactNode } from "react";

/*
 * Fallback Chain – the branch-and-route grammar of the flow diagram, WITHOUT the fallback.
 * Upstream draws one request trying model after model until one answers. BiVelio Savings does not do that: it sends
 * to the provider you configure, and to no other. So what is kept is how the diagram is drawn, not what it says:
 *   · one branch from the request to every model – dotted while it is only an alternative, a solid line for the
 *     route in use
 *   · a soft light that runs along the branch in use, and back along it, green, once the model answers
 *   · one card per model, with its mark, its name and one status line, and the green "answered" ring
 * Gone: the order of the attempts, "failed" (rate limited, timed out, down), "skipped", "up next", the timeout
 * blocks, the timers, the costs and the running totals, the response node, the hover cards and Retry.
 * Fixed geometry, so the branches are drawn without measuring – and everything renders on the server. Which branch
 * is the route in use, and when the lights run, is decided outside: by `--ui-fbk-on` and by CSS animations on the
 * classes below.
 */

export type ChainBranch = {
  /** Where the branch meets its model, in px from the top of the diagram */
  y: number;
  /** A class on the branch – set `--ui-fbk-on: 1` on it to make it the route in use */
  className?: string;
};

export type ChainLinksProps = {
  branches: ChainBranch[];
  /** Where the branches leave the request, in px from the top (wide) – the tree always hangs from the top */
  from?: number;
  /** Width of the diagram in px (default 48, as upstream; the tree is 44) */
  width?: number;
  height: number;
  /** A tree, top to bottom: down one spine and round into each card – for narrow screens */
  tree?: boolean;
  className?: string;
};

/** A soft S-curve from one side to the other */
const curve = (y1: number, y2: number, w: number) => `M0 ${y1}C${w * 0.55} ${y1} ${w * 0.45} ${y2} ${w} ${y2}`;
/** A tree branch: down the spine, then round into the card */
const branch = (y: number, x: number, w: number) => `M${x} 0V${Math.max(0, y - 10)}Q${x} ${y} ${x + 10} ${y}H${w}`;

/**
 * The branches from the request out to every model. Each one is drawn three times on top of each other – dotted
 * (always), solid (the route in use) and green (answered) – plus two lights: one out, one back.
 * The light is upstream's: a gradient that fades in, peaks and fades out, sweeping along the branch. Here it is a
 * band behind a mask in the shape of the branch, moved with a CSS transform instead of SMIL, so it can be paused
 * and follows a timeline.
 */
export function ChainLinks({ branches, from = 0, width, height, tree = false, className }: ChainLinksProps) {
  const uid = "fc" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const w = width ?? (tree ? 44 : 48);
  const spine = 20;
  return (
    <svg
      className={["ui-fbk__links", tree ? "ui-fbk__links--tree" : "ui-fbk__links--wide", className].filter(Boolean).join(" ")}
      width={w}
      height={height}
      viewBox={`0 0 ${w} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {(["a", "k"] as const).map((tone) => (
          <linearGradient key={tone} id={`${uid}-${tone}`} x1="0" y1="0" x2={tree ? "0" : "1"} y2={tree ? "1" : "0"}>
            <stop offset="0" style={{ stopColor: `var(--ui-fbk-${tone === "a" ? "accent" : "ok"})`, stopOpacity: 0 }} />
            <stop offset="0.5" style={{ stopColor: `var(--ui-fbk-${tone === "a" ? "accent" : "ok"})`, stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: `var(--ui-fbk-${tone === "a" ? "accent" : "ok"})`, stopOpacity: 0 }} />
          </linearGradient>
        ))}
      </defs>
      {branches.map((b, i) => {
        const d = tree ? branch(b.y, spine, w) : curve(from, b.y, w);
        // The band: as long as upstream's (70% of the way, 120 at most), travelling from just before to just past
        const size = tree ? b.y : w;
        const band = Math.min(size * 0.7, 120);
        const run = (tree
          ? { "--ui-fbk-fx": "0px", "--ui-fbk-fy": `${-band}px`, "--ui-fbk-tx": "0px", "--ui-fbk-ty": `${b.y + 6}px` }
          : { "--ui-fbk-fx": `${-band}px`, "--ui-fbk-fy": "0px", "--ui-fbk-tx": `${w}px`, "--ui-fbk-ty": "0px" }) as CSSProperties;
        const rect = tree ? { x: 0, y: 0, width: w, height: band } : { x: 0, y: -8, width: band, height: height + 16 };
        return (
          <g key={i} className={["ui-fbk__branch", b.className].filter(Boolean).join(" ")} style={run}>
            <mask id={`${uid}-m${i}`} maskUnits="userSpaceOnUse" x={-8} y={-8} width={w + 16} height={height + 16}>
              <path d={d} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
            </mask>
            <path className="ui-fbk__link" data-status="idle" d={d} pathLength={1} />
            <path className="ui-fbk__link ui-fbk__link--on" data-status="trying" d={d} />
            <path className="ui-fbk__link ui-fbk__link--ok" data-status="answered" d={d} />
            <g className="ui-fbk__light ui-fbk__light--out" mask={`url(#${uid}-m${i})`}>
              <rect className="ui-fbk__band" {...rect} fill={`url(#${uid}-a)`} />
            </g>
            <g className="ui-fbk__light ui-fbk__light--back" mask={`url(#${uid}-m${i})`}>
              <rect className="ui-fbk__band" {...rect} fill={`url(#${uid}-k)`} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export type ChainModelProps = {
  /** The element of the card – a `label` when it wraps a radio */
  as?: ElementType;
  /** Its mark, on a small white tile */
  logo?: ReactNode;
  name: ReactNode;
  /** One line under the name */
  status?: ReactNode;
  /** Rendered first inside the card – a visually hidden input, when the card is a choice */
  control?: ReactNode;
  /** Rendered last, on the right – e.g. the dot of a radio */
  end?: ReactNode;
  /** More under the name */
  children?: ReactNode;
  className?: string;
};

/** A model: one card with its mark, its name and one status line. The rings and the tick are still until animated. */
export function ChainModel({ as: Tag = "div", logo, name, status, control, end, children, className }: ChainModelProps) {
  return (
    <Tag className={["ui-fbk__model", className].filter(Boolean).join(" ")}>
      {control}
      <span className="ui-fbk__ring ui-fbk__ring--trying" aria-hidden="true" />
      <span className="ui-fbk__ring ui-fbk__ring--answered" aria-hidden="true" />
      {logo ? (
        <span className="ui-fbk__logo" aria-hidden="true">
          <span className="ui-fbk__mark" data-logo="">
            {logo}
          </span>
        </span>
      ) : null}
      <span className="ui-fbk__who">
        <span className="ui-fbk__name">{name}</span>
        {status ? <span className="ui-fbk__status">{status}</span> : null}
        {children}
      </span>
      {end}
      {/* Upstream's corner badge held the place in the fallback order; here it is only the tick of an answer */}
      <span className="ui-fbk__n" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <path d="m2.5 6.4 2.3 2.3 4.7-5.2" />
        </svg>
      </span>
    </Tag>
  );
}
