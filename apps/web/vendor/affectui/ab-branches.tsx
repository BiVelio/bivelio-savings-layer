/* Derived from affectUI Pro 'outreach-branches' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit. */

import "./ab-branches.css";

import type { CSSProperties } from "react";

/*
 * A/B Branches – a FORK of affectUI's Outreach Branches illustration.
 *
 * Upstream: three lines branch out from one point and lead down to Gmail, Slack and Notion tiles; pastel pulses run
 * down each line and trace the tile. Here the same drawing language (hairline connectors, white tiles with a soft
 * drop, layered dashes as a pulse with a soft head and tail) explains ONE thing: how a paired A/B check works.
 *   one request  →  arm A (sent as it is)  and  arm B (through the layer)  →  the provider's own usage meter.
 * Changes: two branches instead of three, and both rejoin at a fourth tile; the brand logos are gone (the tiles
 * carry the letters A and B, which the product uses in every language); pulses are ink on A and brand blue on B
 * instead of a pastel gradient; no SVG filters or gradients, so there are no ids and it renders on the server
 * with no script. The scene says nothing about the RESULT: both arms are drawn the same size.
 * Decorative by default (`label` gives it a name); the caller writes the legend next to it, in real text.
 */

export type AbBranchesProps = {
  className?: string;
  /** Accessible description of the scene. Without it the drawing is hidden from assistive tech */
  label?: string;
};

/** Request → A, request → B, A → meter, B → meter */
const lines = [
  { d: "M160 46 C 160 74, 84 66, 84 94", arm: "a", step: 0 },
  { d: "M160 46 C 160 74, 236 66, 236 94", arm: "b", step: 0 },
  { d: "M84 150 C 84 178, 160 162, 160 190", arm: "a", step: 1 },
  { d: "M236 150 C 236 178, 160 162, 160 190", arm: "b", step: 1 },
] as const;

/** Stacked dashes of falling length and opacity give the pulse a soft head and tail */
const LAYERS = [
  [36, 0.18],
  [25, 0.38],
  [15, 0.7],
  [7, 1],
] as const;
const LONGEST = LAYERS[0][0];

export function AbBranches({ className, label }: AbBranchesProps) {
  return (
    <div className={["ui-abb", className].filter(Boolean).join(" ")} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg className="ui-abb-art" viewBox="0 0 320 236" aria-hidden="true" focusable="false">
        {/* Gray connector lines */}
        <g className="ui-abb-lines" fill="none" strokeWidth="1.2" strokeLinecap="round">
          {lines.map((l) => (
            <path key={l.d} d={l.d} />
          ))}
        </g>

        {/* The request: a pill with a few lines of text */}
        <rect className="ui-abb-tile" x="108" y="14" width="104" height="32" rx="16" />
        <g className="ui-abb-ink" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M126 25.5h7.5M126 30h13M126 34.5h10" opacity="0.55" />
          <path d="M150 30h38" opacity="0.2" strokeWidth="5" />
        </g>

        {/* Arm A: the request as it is */}
        <rect className="ui-abb-tile" x="56" y="94" width="56" height="56" rx="14" />
        <text className="ui-abb-letter" x="84" y="130" textAnchor="middle">
          A
        </text>

        {/* Arm B: the same request through the layer */}
        <rect className="ui-abb-tile ui-abb-tile--b" x="208" y="94" width="56" height="56" rx="14" />
        <text className="ui-abb-letter ui-abb-letter--b" x="236" y="130" textAnchor="middle">
          B
        </text>

        {/* The provider's usage meter: both arms end here */}
        <rect className="ui-abb-tile" x="116" y="190" width="88" height="34" rx="11" />
        <g className="ui-abb-ink" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M132 212a9 9 0 0 1 18 0" opacity="0.6" />
          <path d="M141 212l4.5-5.5" />
          <path d="M160 203.5h28M160 208h28M160 212.5h28" opacity="0.2" strokeWidth="2.4" />
        </g>

        {/* Pulses: down to both arms at once, then from both arms to the meter */}
        <g className="ui-abb-pulses">
          {lines.map((l) =>
            LAYERS.map(([length, opacity]) => (
              <path
                key={`${l.d}-${length}`}
                className={`ui-abb-flow ui-abb-flow--${l.arm}`}
                pathLength={100}
                d={l.d}
                strokeOpacity={opacity}
                style={
                  {
                    strokeDasharray: `${length} 200`,
                    "--from": `${length / 2 + LONGEST / 2}`,
                    "--to": `${length / 2 - 100 - LONGEST / 2}`,
                    animationDelay: `${l.step * 1.9}s`,
                  } as CSSProperties
                }
              />
            )),
          )}
        </g>
      </svg>
    </div>
  );
}
