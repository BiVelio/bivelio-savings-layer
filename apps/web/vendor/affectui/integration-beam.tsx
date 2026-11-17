/*
 * Vendored from affectUI 'Integration Beam' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * FORKED for BiVelio Savings (different topology, no client script); changes from upstream are listed in ./VENDOR.md.
 */
import type { ReactNode } from "react";

/*
 * Integration Beam, BiVelio fork – the path of ONE request, as a labelled diagram.
 *
 *   input ─╮
 *          ├─▶ centre ─▶ output          (the active path: blue, with a contained pulse)
 *   input ─╯     ┊
 *                ┊ link label            (drawn apart: grey, dashed, no pulse)
 *              aside
 *
 * Upstream draws three tools on each side of a product and measures their positions in the
 * browser. This fork keeps its material (small white tiles, fine curves, one soft pulse, a dark
 * hub) and changes everything else: the topology is fixed, every node carries a READABLE label
 * instead of a tooltip, and the wires are laid out by CSS grid, so it is a server component with
 * no script at all. The connections counter, the pause/reconnect buttons and the brand logos of
 * the demo are gone: they were decorative states, not a customer's real connections.
 *
 * It turns vertical in a narrow container and stands still under `prefers-reduced-motion`
 * (the arrow heads keep the direction readable). Use it once per page.
 */

export type BeamIcon = "app" | "agent" | "layer" | "provider" | "cloud";

export type BeamNode = {
  title: string;
  /** Second, muted line */
  sub?: string;
  icon?: BeamIcon;
};

export type IntegrationBeamProps = {
  /** Exactly two senders (the wires are drawn for two) */
  inputs: readonly [BeamNode, BeamNode];
  /** The hub: where the product runs */
  center: BeamNode;
  /** Where the active path ends */
  output: BeamNode;
  /** A node that is NOT on the active path, with the label of its dashed link */
  aside: BeamNode & { link: string };
  /** Visible caption under the drawing, e.g. "Illustration of how it works" */
  caption: string;
  /** Full description of the scene for screen readers (the drawing itself is one image) */
  label: string;
  className?: string;
};

const ICONS: Record<BeamIcon, ReactNode> = {
  // A window with a prompt
  app: <path d="M3.5 6.5h17v11h-17zM3.5 9.5h17M7.5 13l2 1.5-2 1.5M12 16h4" />,
  // A terminal cursor inside brackets
  agent: <path d="M8 5 4 12l4 7M16 5l4 7-4 7M10.5 15.5h3" />,
  // Two stacked sheets
  layer: <path d="m12 4 8 4-8 4-8-4 8-4ZM4 12l8 4 8-4M4 16l8 4 8-4" />,
  // A node with three spokes: an API endpoint
  provider: <path d="M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM12 4v5.5M5.5 17.5l4.4-3.6M18.5 17.5l-4.4-3.6" />,
  // A panel with a small chart
  cloud: <path d="M4 5.5h16v13H4zM8 15v-3M12 15V9.5M16 15v-4.5" />,
};

function Icon({ name }: { name: BeamIcon }) {
  return (
    <span className="ui-ibm__icon">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {ICONS[name]}
      </svg>
    </span>
  );
}

function Tile({ node, kind, fallback }: { node: BeamNode; kind?: "hub" | "aside"; fallback: BeamIcon }) {
  return (
    <span className="ui-ibm__tile" data-kind={kind}>
      <Icon name={node.icon ?? fallback} />
      <span className="ui-ibm__text">
        <span className="ui-ibm__title">{node.title}</span>
        {node.sub ? <span className="ui-ibm__sub">{node.sub}</span> : null}
      </span>
    </span>
  );
}

/** One wire: the resting line and, on the active path, the pulse that rides it. */
function Wire({ d, pulse }: { d: string; pulse?: boolean }) {
  return (
    <>
      <path className="ui-ibm__line" d={d} />
      {pulse ? <path className="ui-ibm__pulse" d={d} pathLength={100} /> : null}
    </>
  );
}

const svg = { viewBox: "0 0 100 100", preserveAspectRatio: "none" } as const;

export function IntegrationBeam({ inputs, center, output, aside, caption, label, className }: IntegrationBeamProps) {
  return (
    <figure className={["ui-ibm", className].filter(Boolean).join(" ")}>
      <div className="ui-ibm__scene" role="img" aria-label={label}>
        <div className="ui-ibm__in">
          {inputs.map((node, i) => (
            <span className="ui-ibm__slot" key={i}>
              <Tile node={node} fallback={i === 0 ? "app" : "agent"} />
            </span>
          ))}
        </div>

        {/* Senders → hub. Two drawings: side by side, and stacked for narrow containers */}
        <div className="ui-ibm__wire ui-ibm__wire--in" data-step="1">
          <svg {...svg} className="ui-ibm__h">
            <Wire d="M0 25 C 55 25, 45 50, 100 50" pulse />
            <Wire d="M0 75 C 55 75, 45 50, 100 50" pulse />
          </svg>
          <svg {...svg} className="ui-ibm__v">
            <Wire d="M25 0 C 25 55, 50 45, 50 100" pulse />
            <Wire d="M75 0 C 75 55, 50 45, 50 100" pulse />
          </svg>
        </div>

        <div className="ui-ibm__hub">
          <Tile node={center} kind="hub" fallback="layer" />
        </div>

        {/* Hub → output */}
        <div className="ui-ibm__wire ui-ibm__wire--out" data-step="2">
          <svg {...svg} className="ui-ibm__h">
            <Wire d="M0 50 L 100 50" pulse />
          </svg>
          <svg {...svg} className="ui-ibm__v">
            <Wire d="M100 0 C 100 55, 50 45, 50 100" pulse />
          </svg>
        </div>

        <div className="ui-ibm__out">
          <Tile node={output} fallback="provider" />
        </div>

        {/* Apart from the path: dashed, grey, labelled, and never pulsing */}
        <div className="ui-ibm__wire ui-ibm__wire--aside">
          <svg {...svg} className="ui-ibm__h">
            <path className="ui-ibm__line" d="M50 0 L 50 100" />
          </svg>
          <svg {...svg} className="ui-ibm__v">
            <path className="ui-ibm__line" d="M0 0 C 0 55, 50 45, 50 100" />
          </svg>
          <span className="ui-ibm__link">{aside.link}</span>
        </div>

        <div className="ui-ibm__aside">
          <Tile node={aside} kind="aside" fallback="cloud" />
        </div>
      </div>
      <figcaption className="ui-ibm__caption">{caption}</figcaption>
    </figure>
  );
}
