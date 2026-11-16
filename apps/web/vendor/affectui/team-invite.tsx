/*
 * Derived from affectUI Pro 'Team Invite' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./team-invite.css";
import { useId, type ReactNode } from "react";

/*
 * Team Invite – a small card illustration, in a single self-contained file.
 * Two connected teammates and an empty dashed slot. A cursor drags a third avatar into the slot:
 * it lands, the dashed line turns solid and the status dot lights up – then the scene starts over.
 * The artwork is laid out on a 600 × 400 grid inside a 3 : 2 frame and scales with its container.
 */

export type TeamInviteProps = {
  /**
   * What sits in the three bubbles: the two that are already connected, then the one being invited.
   * BiVelio: glyphs or marks, never portraits – the scene must not invent people.
   */
  nodes?: [ReactNode, ReactNode, ReactNode];
  className?: string;
  /**
   * Accessible description of the scene – always translated by the caller. Leave it out where the words next to
   * the scene already say it (an empty state): the scene is then decoration and hidden from assistive tech.
   */
  label?: string;
};

export function TeamInvite({ nodes = [<Person key="a" />, <Person key="b" />, <Person key="c" />], className, label }: TeamInviteProps) {
  const id = "ui-ti" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [a, b, c] = nodes;

  return (
    <div
      className={["ui-ti", className].filter(Boolean).join(" ")}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >

      <svg className="ui-ti-lines" viewBox="0 0 600 400" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" className="ui-ti-stop-a" />
            <stop offset="100%" className="ui-ti-stop-b" />
          </linearGradient>
        </defs>
        {/* Already connected */}
        <path className="ui-ti-line" d="M162 159C214 159 222 105 258 105" stroke={`url(#${id}-line)`} />
        {/* The open invite: dashed while waiting, drawn solid once the avatar lands */}
        <path className="ui-ti-line ui-ti-line--dashed" d="M162 159C214 165 214 245 248 245" />
        <path className="ui-ti-line ui-ti-line--joined" d="M162 159C214 165 214 245 248 245" pathLength={1} stroke={`url(#${id}-line)`} />
        {/* Empty slot – same stroke, dash and gap as the dashed line (19 dashes fit the circle exactly) */}
        <g className="ui-ti-slot">
          <circle className="ui-ti-line ui-ti-line--slot" cx="290" cy="245" r="40" />
          <path className="ui-ti-plus" d="M290 234v22M279 245h22" />
        </g>
      </svg>

      <Node className="ui-ti-node--a" online>{a}</Node>
      <Node className="ui-ti-node--b" online>{b}</Node>

      {/* Dragged from the right into the slot, with the cursor holding on */}
      <div className="ui-ti-drag" aria-hidden="true">
        <Node className="ui-ti-node--c" online>{c}</Node>
        {/* Pointer with soft, rounded corners; its tip sits at (0, 0) of the viewBox */}
        <svg className="ui-ti-cursor" viewBox="-2.186 -0.256 18.514 22.277" aria-hidden="true">
          <path
            transform="rotate(21.37)"
            d="M13.92 4.07c1.69.66 3.03 1.18 3.94 1.68.46.25.87.53 1.16.86.31.35.51.79.48 1.29-.03.51-.27.92-.62 1.23-.33.3-.77.53-1.25.74-.96.4-2.36.78-4.12 1.26-.56.15-.98.27-1.26.37-.26.1-.38.18-.47.27-.09.09-.17.21-.27.47-.1.28-.22.7-.37 1.26-.48 1.76-.86 3.16-1.26 4.12-.2.49-.44.93-.74 1.25-.32.35-.72.6-1.23.62-.51.03-.94-.17-1.29-.48-.33-.29-.61-.7-.86-1.16-.5-.91-1.02-2.25-1.68-3.94L1.66 7.76C.96 5.99.41 4.59.16 3.51-.09 2.44-.12 1.39.63.63 1.39-.12 2.44-.09 3.51.16c1.08.25 2.48.8 4.25 1.5l6.16 2.41Z"
          />
        </svg>
      </div>
    </div>
  );
}

function Node({ children, online, className }: { children: ReactNode; online?: boolean; className: string }) {
  return (
    <div className={`ui-ti-node ${className}`} aria-hidden="true">
      <span className="ui-ti-face">
        {children}
      </span>
      {online && <span className="ui-ti-dot" />}
    </div>
  );
}

/** BiVelio: the default bubble – an anonymous glyph, never a portrait */
function Person() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M20 21C19.713 17.269 16.729 14.315 12.995 14.066L12 14C11.645 14.01 11.313 14.023 11.001 14.038C7.3 14.219 4.284 17.306 4 21" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
