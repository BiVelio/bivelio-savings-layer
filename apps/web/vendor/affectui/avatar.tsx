/*
 * Derived from affectUI Pro 'Avatar' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
import "./avatar.css";

import type { ComponentPropsWithRef } from "react";

/*
 * Avatar – a single self-contained file, clean style.
 * BiVelio: reduced to what the panel has – a person's INITIALS on a soft color of their own (always the same for
 * the same name or id). No pictures, no agent marks, no status dots, no groups: none of that data exists here.
 * No state, so it renders on the server. The styles live in the sibling .css file.
 */

export type AvatarSize = 20 | 24 | 32 | 40;

export type AvatarProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** Who it is – the initials and the color come from it */
  name?: string;
  /** 20, 24, 32 or 40 pixels */
  size?: AvatarSize;
  /** circle: people · square: a rounded square for organizations */
  shape?: "circle" | "square";
  /** What the color is made from, e.g. a user id – the name when left out */
  seed?: string;
};

/** Decorative by default (the name is always printed next to it); pass aria-label to make it an image. */
export function Avatar({ name, size = 32, shape = "circle", seed, className, ...rest }: AvatarProps) {
  const scale = SIZES.includes(size) ? size : 32;
  const key = (seed ?? name ?? "").trim();
  const label = rest["aria-label"];
  return (
    <span
      className={["ui-avtc", className].filter(Boolean).join(" ")}
      data-size={scale}
      data-shape={shape === "square" ? "square" : "circle"}
      data-kind="person"
      data-hue={key ? hueOf(key) : undefined}
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      <span className="ui-avtc__face">
        <Initials name={name ?? ""} />
      </span>
    </span>
  );
}

const SIZES: number[] = [20, 24, 32, 40];

/** One of eight soft colors, always the same for the same name or id */
const hueOf = (key: string) => {
  let h = 7;
  for (const c of key) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return String(h % 8);
};

/* ---------- Initials ---------- */

type Segmenter = { segment: (text: string) => Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;
/** Whole characters – "é", "👩🏽‍💻" and flags stay one – with Intl.Segmenter where it exists */
const graphemes = (text: string): string[] => {
  if (segmenter === undefined) {
    const S = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
    segmenter = S ? new S(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
};
const LETTER = /[\p{L}\p{N}]/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** "III", "Jr." and the like close a name but don't make an initial – "Christopher Montgomery III" is CM */
const SUFFIX = /^(jr|sr|ii|iii|iv|vi|phd|md|esq)\.?$/i;

/** Initials from the first and last word: "Mara Lindqvist" → ML, "Cher" → C, "🦊 Fox Team" → 🦊, "(Ana) Ruiz" → AR */
function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const lead = graphemes(words[0])[0];
  if (lead && EMOJI.test(lead) && !LETTER.test(lead)) return lead;
  // Each word's first letter or digit, skipping quotes, brackets and other marks in front of it
  const firsts = words
    .filter((w, i, all) => !(i > 0 && i === all.length - 1 && SUFFIX.test(w)))
    .map((w) => graphemes(w).find((g) => LETTER.test(g)))
    .filter((g): g is string => !!g);
  if (!firsts.length) return lead ?? "";
  const pair = firsts.length > 1 ? firsts[0] + firsts[firsts.length - 1] : firsts[0];
  return pair.toLocaleUpperCase();
}

function Initials({ name }: { name: string }) {
  const text = initialsOf(name);
  return (
    <span className="ui-avtc__initials" dir="auto" aria-hidden="true">
      {text || (
        // No name: a person outline – Hugeicons Free (MIT, © Hugeicons, hugeicons.com)
        <svg className="ui-avtc__anon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21C19.713 17.269 16.729 14.315 12.995 14.066L12 14C11.645 14.01 11.313 14.023 11.001 14.038C7.3 14.219 4.284 17.306 4 21" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )}
    </span>
  );
}
