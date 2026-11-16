/*
 * Derived from affectUI Pro 'Number Input' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */

/*
 * BiVelio: the part of the Number Input that DECIDES A NUMBER, pulled out of the component so it can be tested without
 * a browser. The seat field of the checkout runs on it, and a number it gets wrong is a quantity sent to Stripe:
 * what is typed is read here, what typing and leaving the field emit is decided here, and which keys the field takes
 * over is listed here. number-input.tsx only wires these to the DOM.
 */

export type NumberMarks = { group: string; decimal: string };

export type ReadOptions = {
  /** The format is a percent: "25" reads as 0.25 */
  percent?: boolean;
  /** Whole numbers only: anything but digits (and a leading minus) is unreadable – a separator is never guessed away */
  integer?: boolean;
};

/**
 * Reads what's typed – null when empty, NaN when it's no number.
 *
 * By default it takes the locale's separators, a minus and a percent. With `integer` it takes digits only: "1,5",
 * "2.5", "1 2" and "1,000" are unreadable, where stripping the separators would have made them 15, 25, 12 and 1000.
 */
export function readNumber(text: string, marks: NumberMarks, { percent = false, integer = false }: ReadOptions = {}): number | null {
  if (integer) {
    const whole = text.trim();
    if (whole === "") return null;
    return /^[-−]?\d+$/.test(whole) ? Number(whole.replace("−", "-")) : NaN;
  }
  let t = text.replace(/[\s  ]/g, "");
  if (t === "") return null;
  if (marks.group) t = t.split(marks.group).join("");
  if (marks.decimal !== ".") t = t.split(marks.decimal).join(".");
  const negative = /^[-−]|[-−]$|^\(.*\)$/.test(t);
  t = t.replace(/[^\d.]/g, "");
  if (t === "" || t === "." || (t.match(/\./g)?.length ?? 0) > 1) return NaN;
  const n = Number(t) * (negative ? -1 : 1);
  return percent ? n / 100 : n;
}

/**
 * What typing emits straight away, before the field is left: the number as typed (not clamped yet), null for an
 * emptied field, and `undefined` – nothing, the last value stands – while the text is no number.
 */
export function typedValue(text: string, marks: NumberMarks, options?: ReadOptions): number | null | undefined {
  const parsed = readNumber(text, marks, options);
  if (parsed === null) return null;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * What leaving the field (or Enter) settles on: the typed number clamped to [min, max], null for an emptied field,
 * and `undefined` – go back to the last value – when the text is no number.
 */
export function committedValue(
  text: string,
  marks: NumberMarks,
  { min = -Infinity, max = Infinity, step = 1, ...options }: ReadOptions & { min?: number; max?: number; step?: number } = {},
): number | null | undefined {
  const parsed = readNumber(text, marks, options);
  if (parsed === null) return null;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, roundToStep(parsed, step)));
}

/** The keys that jump: Home / End to the limits, Page Up / Page Down by a big step */
export const JUMP_KEYS = ["Home", "End", "PageUp", "PageDown"] as const;

/**
 * The keys the field takes over; any other key keeps what the browser does with it in a text field.
 * With `jumpKeys` off, Home and End only move the caret and Page Up / Page Down do nothing – as in <input type=number>.
 */
export function handledKeys({ min = -Infinity, max = Infinity, jumpKeys = true }: { min?: number; max?: number; jumpKeys?: boolean } = {}): string[] {
  const keys = ["ArrowUp", "ArrowDown", "Enter", "Escape"];
  if (!jumpKeys) return keys;
  keys.push("PageUp", "PageDown");
  if (Number.isFinite(min)) keys.push("Home");
  if (Number.isFinite(max)) keys.push("End");
  return keys;
}

/** Rounds away float noise (0.1 + 0.2) to the step's own decimals, at least 10 */
export function roundToStep(v: number, step: number) {
  const places = Math.max(10, (String(step).split(".")[1] ?? "").length);
  return Number(v.toFixed(Math.min(places, 15)));
}
