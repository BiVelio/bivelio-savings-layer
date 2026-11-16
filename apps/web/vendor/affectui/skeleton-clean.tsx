/*
 * Vendored from affectUI 'Skeleton (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./skeleton-clean.css";
import type { ComponentPropsWithRef, CSSProperties } from "react";

/*
 * Skeleton – a single self-contained file, clean style.
 * Skeleton: a gray shape that stands in for text, an avatar or a button while the data loads; a soft sheen sweeps
 * across it, every skeleton in step. Give it the size of what it replaces – with `line` it sits in a box one text line
 * tall, so a row keeps its height when the words land. Loading: wraps the skeletons of one area, tells screen readers
 * it is busy and fades them in a beat late, so a fast load never flashes them.
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

type Length = number | string;

export type SkeletonProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** px or any CSS length */
  width?: Length;
  /** The shape's own height – px or any CSS length */
  height?: Length;
  /** Corner radius – px, "50%" for a circle */
  radius?: Length;
  /**
   * Sits the shape in a box as tall as the text line it replaces (true = 1lh, or a length), centered in it –
   * a 10px bar in a 20px line, so the row is exactly as tall as it will be with text
   */
  line?: boolean | Length;
};

export function Skeleton({ width = "100%", height = 12, radius, line, className, style, ...rest }: SkeletonProps) {
  const bar = (
    <span
      {...(line ? {} : rest)}
      className={["ui-sklc", line ? null : className].filter(Boolean).join(" ")}
      style={{ width, height, borderRadius: radius, ...(line ? null : style) }}
      aria-hidden="true"
    />
  );
  return (
    <>
      {line ? (
        <span
          {...rest}
          className={["ui-sklc__line", className].filter(Boolean).join(" ")}
          style={{ height: line === true ? "1lh" : line, ...style } as CSSProperties}
          aria-hidden="true"
        >
          {bar}
        </span>
      ) : (
        bar
      )}
    </>
  );
}

export type LoadingProps = Omit<ComponentPropsWithRef<"div">, "role"> & {
  /** What loads, for screen readers – "Loading runs". BiVelio: required and translated, no English default */
  label: string;
};

/**
 * Wraps the skeletons that stand in for one area: role="status" with aria-busy, and a fade-in after 150ms.
 * Give it the real layout's class, so the grid or list is the same one the data fills.
 */
export function Loading({ label, className, children, ...rest }: LoadingProps) {
  return (
    <div {...rest} className={["ui-sklc-loading", className].filter(Boolean).join(" ")} role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  );
}
