/*
 * Derived from affectUI Pro 'Tab Overload' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import { useId } from "react";

/*
 * Tab Overload – a small card illustration, in a single self-contained file.
 * Three overlapping browser windows; the front one is active with colored dots, an outline and a glow.
 * Hover a window behind it and the highlight moves over to that one.
 * The artwork is drawn on a 360 × 240 viewBox and fades out towards the right and bottom edge.
 */

export type TabOverloadProps = {
  className?: string;
  /** Accessible description of the scene – always translated by the caller (BiVelio: no English default) */
  label: string;
};

/** Offsets of the three windows (top-left corner of each frame) */
const windows = [
  { n: 1, x: 30, y: 68 },
  { n: 2, x: 125, y: 56 },
  { n: 3, x: 220, y: 44 },
] as const;

export function TabOverload({ className, label }: TabOverloadProps) {
  const id = "ui-to" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <div className={["ui-to", className].filter(Boolean).join(" ")} role="img" aria-label={label}>
      <svg className="ui-to-art" viewBox="0 0 360 240" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-blob-h`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7CC4FF" stopOpacity="0.3" />
            <stop offset="50%" stopColor="#5B9BFF" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#0066E6" stopOpacity="0.3" />
          </linearGradient>
          <linearGradient id={`${id}-blob-v`} x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#0066E6" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#7CC4FF" stopOpacity="0.3" />
          </linearGradient>
          <filter id={`${id}-blur`} x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
          <linearGradient id={`${id}-stroke`} x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#0066E6" />
            <stop offset="45%" stopColor="#5B9BFF" />
            <stop offset="100%" stopColor="#9AD0FF" />
          </linearGradient>
        </defs>

        {/* Each window: glow → frame → content; the next window covers any overflow */}
        {windows.map(({ n, x, y }) => (
          <g key={n}>
            <g className={`ui-to-blobs ui-to-blobs-${n}`}>
              <ellipse
                cx={x + 70}
                cy={y + 8}
                rx="90"
                ry="14"
                fill={`url(#${id}-blob-h)`}
                filter={`url(#${id}-blur)`}
              />
              <ellipse
                cx={x + 8}
                cy={y + 96}
                rx="14"
                ry="90"
                fill={`url(#${id}-blob-v)`}
                filter={`url(#${id}-blur)`}
              />
            </g>
            <g className={`ui-to-tab ui-to-tab-${n}`} transform={`translate(${x} ${y})`}>
              {/* Outer gray frame, reaching well past the edges */}
              <rect className="ui-to-frame" width="380" height="300" rx="6" fill="#F2F1EC" stroke="#E6E4DE" strokeWidth="0.7" />
              <circle className="ui-to-dot" cx="14" cy="14" r="3" fill="#D4D2CA" />
              <circle className="ui-to-dot" cx="24" cy="14" r="3" fill="#D4D2CA" />
              <circle className="ui-to-dot" cx="34" cy="14" r="3" fill="#D4D2CA" />
              <rect className="ui-to-page" x="4" y="24" width="372" height="272" rx="5" fill="#FFFFFF" stroke="#E6E4DE" strokeWidth="0.7" />
            </g>
            <g className={`ui-to-content ui-to-content-${n}`} transform={`translate(${x} ${y})`}>
              <rect className="ui-to-bar" x="12" y="36" width="30" height="30" rx="4" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="52" y="38" width="100" height="6" rx="2" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="52" y="46" width="100" height="6" rx="2" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="52" y="54" width="35" height="6" rx="2" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="12" y="72" width="140" height="6" rx="2" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="12" y="80" width="140" height="6" rx="2" fill="#EFEEE8" />
              <rect className="ui-to-bar" x="12" y="88" width="55" height="6" rx="2" fill="#EFEEE8" />
            </g>
          </g>
        ))}

        {/* Active-window decoration (colored dots + outline), shown on one window at a time */}
        {windows.map(({ n, x, y }) => (
          <g key={n} className={`ui-to-front ui-to-front-${n}`}>
            <circle cx={x + 14} cy={y + 14} r="3" fill="#0066E6" />
            <circle cx={x + 24} cy={y + 14} r="3" fill="#5B9BFF" />
            <circle cx={x + 34} cy={y + 14} r="3" fill="#9AD0FF" />
            <path
              d={`M ${x} 240 L ${x} ${y + 6} A 6 6 0 0 1 ${x + 6} ${y} L ${n === 3 ? 360 : x + 95} ${y}`}
              fill="none"
              stroke={`url(#${id}-stroke)`}
              strokeWidth="0.8"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
