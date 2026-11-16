/*
 * Derived from affectUI Pro 'Integration Flow' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./integration-flow.css";
import type { CSSProperties } from "react";

/*
 * Integration Flow – the motion language of the product scene, as three small parts.
 * Upstream is one fixed scene (integration pills rotating along a dashed arc, each beaming its data into a central
 * hub). BiVelio keeps what that scene is made of and drops the scene itself:
 *   · FlowLink   – the link between two cards and the beam that sweeps along it: a crisp core and a blurred glow,
 *                  clipped at both ends, with a second pair for the way back
 *   · FlowCharge – a card "charging up" before it fires or as the beam lands: a gradient that fades in from the side
 *                  the link is on
 *   · FlowBlobs  – the soft colour blobs that drift and breathe behind the scene
 * Nothing here runs by itself: the parts are still until whoever uses them gives them a timeline (CSS animations on
 * the classes passed in). No script, no measuring – everything renders on the server.
 */

type Tone = "accent" | "ok";

export type FlowLinkProps = {
  /** Length of the link in px – the beam travels exactly this far */
  length: number;
  /** Length of the beam in px (default: 60% of the link) */
  beam?: number;
  className?: string;
  /** Classes for the beam that runs forward (start → end) and for the one that runs back */
  forwardClassName?: string;
  backClassName?: string;
};

/** A straight link and its two beams. It lies along the x axis; rotate it to run it top to bottom. */
export function FlowLink({ length, beam, className, forwardClassName, backClassName }: FlowLinkProps) {
  const b = beam ?? Math.round(length * 0.6);
  const cls = (...c: (string | undefined)[]) => c.filter(Boolean).join(" ");
  return (
    <span className={cls("ui-if-link", className)} style={{ "--ui-if-len": `${length}px`, "--ui-if-beam": `${b}px` } as CSSProperties} aria-hidden="true">
      <span className={cls("ui-if-beam ui-if-beam--glow", forwardClassName)} />
      <span className={cls("ui-if-beam ui-if-beam--core", forwardClassName)} />
      <span className={cls("ui-if-beam ui-if-beam--back ui-if-beam--glow", backClassName)} />
      <span className={cls("ui-if-beam ui-if-beam--back ui-if-beam--core", backClassName)} />
    </span>
  );
}

/** The charged state of a card: put it inside a positioned card with rounded corners. `side` is where the link is. */
export function FlowCharge({ side, tone = "accent", className }: { side: "start" | "end" | "top" | "bottom"; tone?: Tone; className?: string }) {
  return <span className={["ui-if-bg ui-if-bg--charge", className].filter(Boolean).join(" ")} data-side={side} data-tone={tone} aria-hidden="true" />;
}

/** The drifting blobs behind a scene. The box clips them and fades them out toward its edge. */
export function FlowBlobs({ className }: { className?: string }) {
  return (
    <span className={["ui-if-blobs", className].filter(Boolean).join(" ")} aria-hidden="true">
      <span className="ui-if-blob ui-if-blob--a" />
      <span className="ui-if-blob ui-if-blob--b" />
      <span className="ui-if-blob ui-if-blob--c" />
      <span className="ui-if-blob ui-if-blob--d" />
    </span>
  );
}
