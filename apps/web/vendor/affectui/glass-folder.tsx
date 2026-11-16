/*
 * Derived from affectUI Pro 'Glass Folder' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import { useId } from "react";

/*
 * Glass Folder – a glassy folder illustration, in a single self-contained file.
 * Three documents sit in a blue folder behind a frosted front pocket.
 * Hover the folder: the pocket tips forward and every document shifts on its own.
 * The artwork scales with its container and keeps a 3 : 2 frame.
 */

export type GlassFolderProps = {
  className?: string;
  /** Accessible description of the scene – always translated by the caller (BiVelio: no English default) */
  label: string;
};

const BACK =
  "M38 0H176Q196 0 204 14L218 30Q224 38 246 38H562Q600 38 600 76V462Q600 500 562 500H38Q0 500 0 462V38Q0 0 38 0Z";
const LINES = [78, 180, 140, 175, 126, 168, 110];

export function GlassFolder({ className, label }: GlassFolderProps) {
  const id = "ui-fd" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <div className={["ui-fd", className].filter(Boolean).join(" ")} role="img" aria-label={label}>
      <div className="ui-fd-icon" aria-hidden="true">
        {/* Back of the folder with its tab */}
        <svg className="ui-fd-layer ui-fd-back" viewBox="0 0 600 500">
          <defs>
            <filter id={`${id}-hl`} x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur" />
              <feOffset in="blur" dy="3" result="offset" />
              <feComposite in="blur" in2="offset" operator="arithmetic" k2="1" k3="-1" result="diff" />
              <feFlood floodColor="#fff" floodOpacity="0.65" />
              <feComposite in2="diff" operator="in" result="light" />
              <feComposite in="light" in2="SourceAlpha" operator="in" />
            </filter>
          </defs>
          <path className="ui-fd-back-fill" d={BACK} fill="#2f86f0" />
          <path d={BACK} fill="#000" filter={`url(#${id}-hl)`} />
        </svg>

        {/* Documents – each one moves on its own */}
        <svg className="ui-fd-layer" viewBox="0 0 600 500">
          <defs>
            <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1">
              <stop className="ui-fd-paper-top" offset="0%" stopColor="#fff" />
              <stop className="ui-fd-paper-bottom" offset="100%" stopColor="#eef3fb" />
            </linearGradient>
            <symbol id={`${id}-doc`} overflow="visible">
              <rect className="ui-fd-paper" x="0.6" y="0.6" width="278.8" height="348.8" rx="19.4" fill={`url(#${id}-paper)`} stroke="rgba(0,0,0,0.12)" strokeWidth="1.2" />
              {LINES.map((w, i) => (
                <rect key={i} className="ui-fd-line" x="30" y={87 + i * 28} width={w} height="9" rx="4.5" fill="rgba(0,0,0,0.12)" />
              ))}
            </symbol>
          </defs>
          <use className="ui-fd-doc ui-fd-doc--left" href={`#${id}-doc`} />
          <use className="ui-fd-doc ui-fd-doc--right" href={`#${id}-doc`} />
          <use className="ui-fd-doc ui-fd-doc--middle" href={`#${id}-doc`} />
        </svg>

        {/* Frosted front pocket */}
        <div className="ui-fd-front" />
      </div>
    </div>
  );
}
