/*
 * Derived from affectUI Pro 'Empty Calendar' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";


import { useId } from "react";

/*
 * Empty Calendar – a small card illustration, in a single self-contained file.
 * Three stacked calendar cards with an "Empty" badge and a disabled "Join meeting" button.
 * Hover the front card to lift it, hover a back card to slide it further out.
 * The artwork is drawn on a 320 × 240 viewBox inside a 3 : 2 frame.
 */

export type EmptyCalendarProps = {
  className?: string;
};

export function EmptyCalendar({ className }: EmptyCalendarProps) {
  const id = "ui-ec" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <div className={["ui-ec", className].filter(Boolean).join(" ")} aria-hidden="true">
      <svg className="ui-ec-art" viewBox="0 0 320 240" aria-hidden="true">
        <defs>
          <filter id={`${id}-blur`} x="-30%" y="-100%" width="160%" height="300%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
          <filter id={`${id}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow className="ui-ec-drop" dx="0" dy="3" stdDeviation="4" floodColor="#000000" floodOpacity="0.06" />
          </filter>
          <linearGradient id={`${id}-blob`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FFA0AB" stopOpacity="0.25" />
            <stop offset="33%" stopColor="#FFB89E" stopOpacity="0.25" />
            <stop offset="66%" stopColor="#C8A8E5" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#A8B5FF" stopOpacity="0.25" />
          </linearGradient>
          <linearGradient id={`${id}-stroke`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop className="ui-ec-edge" offset="0%" stopColor="#E4E7EC" />
            <stop offset="18%" stopColor="#FFB5BC" />
            <stop offset="40%" stopColor="#FFC5AB" />
            <stop offset="60%" stopColor="#D5BBEF" />
            <stop offset="82%" stopColor="#B5C0FF" />
            <stop className="ui-ec-edge" offset="100%" stopColor="#E4E7EC" />
          </linearGradient>
        </defs>

        <g transform="translate(30 47) scale(0.814)">
          {/* Back cards – hover to slide them out further */}
          <g className="ui-ec-back ui-ec-back-left">
            <CalendarCard shadow={`url(#${id}-shadow)`} />
          </g>
          <g className="ui-ec-back ui-ec-back-right">
            <CalendarCard shadow={`url(#${id}-shadow)`} />
          </g>

          {/* Front card with a soft colored glow underneath */}
          <g className="ui-ec-front">
            <ellipse
              className="ui-ec-blob"
              cx="160"
              cy="152"
              rx="125"
              ry="35"
              fill={`url(#${id}-blob)`}
              filter={`url(#${id}-blur)`}
            />
            <CalendarCard shadow={`url(#${id}-shadow)`} />
            {/* Colored bottom edge, matching the glow */}
            <path
              d="M40 150 A 10 10 0 0 0 50 160 L270 160 A 10 10 0 0 0 280 150"
              fill="none"
              stroke={`url(#${id}-stroke)`}
              strokeWidth="0.5"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}

/**
 * One card: a title bar, a quiet "nothing yet" pill and placeholder lines. BiVelio: upstream wrote "Calendar",
 * "EMPTY" and a disabled "Join meeting" button into the artwork; those are gone – the card carries no words, so it
 * reads as an empty statement sheet in any language, and the card is shorter for it.
 */
function CalendarCard({ shadow }: { shadow: string }) {
  return (
    <>
      <rect className="ui-ec-card" x="40" y="20" width="240" height="140" rx="10" fill="#FFFFFF" stroke="#E4E7EC" strokeWidth="0.5" filter={shadow} />
      <rect className="ui-ec-bar" x="56" y="38" width="74" height="9" rx="3" fill="#EFF1F4" />
      <g transform="translate(226 33)">
        <rect className="ui-ec-badge" width="38" height="18" rx="5" fill="#FEF8EF" />
        <circle cx="12" cy="9" r="2" fill="#FAB082" />
        <rect x="18" y="7.5" width="12" height="3" rx="1.5" fill="#FAB082" opacity="0.6" />
      </g>
      <rect className="ui-ec-bar" x="56" y="68" width="208" height="7" rx="2" fill="#EFF1F4" />
      <rect className="ui-ec-bar" x="56" y="82" width="208" height="7" rx="2" fill="#EFF1F4" />
      <rect className="ui-ec-bar" x="56" y="96" width="168" height="7" rx="2" fill="#EFF1F4" />
      <rect className="ui-ec-bar" x="56" y="124" width="120" height="7" rx="2" fill="#EFF1F4" />
      <rect className="ui-ec-bar" x="204" y="121" width="60" height="13" rx="3" fill="#EFF1F4" />
    </>
  );
}
