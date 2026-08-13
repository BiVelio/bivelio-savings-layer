import type { Serializer } from "./types.js";

/**
 * Compact JSON: the lossless baseline every other format is measured against.
 * No indentation, no incidental whitespace. This is frequently the *winner* for
 * deeply nested or non-uniform data, which is exactly why it is the baseline and
 * The compact encoder is only ever a challenger.
 */
export const jsonCompactSerializer: Serializer = {
  format: "json-compact",
  supports() {
    return true;
  },
  encode(value: unknown): string {
    return JSON.stringify(value);
  },
  /** No format explanation is needed; every model reads JSON natively. */
  instruction() {
    return "";
  },
};
