/*
 * Vendored from affectUI 'Empty State (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./empty-state-clean.css";
import { createElement, type ComponentPropsWithRef, type ReactNode } from "react";

/*
 * Empty State – a single self-contained file, clean style.
 * What a list, table or panel shows while there is nothing in it: an icon on a soft tile, a title, one line on what
 * will show up here, and a button for the first step. Framed in a quiet drop area, or bare inside a panel.
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

/** An icon from Hugeicons (e.g. `import { Plug01Icon } from "@hugeicons/core-free-icons"`) – drawn inline */
export type HugeIcon = readonly (readonly [string, { readonly [key: string]: string | number }])[];

export type EmptyStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  /** What's empty, e.g. "No schedules yet" */
  title: ReactNode;
  /** One line on what will show up here, or how to get there */
  text?: ReactNode;
  /** The first step – usually a small secondary Button; several buttons sit in a row */
  action?: ReactNode;
  /** The glyph on the tile: an inline SVG or a Hugeicons icon object. Defaults to a file; null shows no tile */
  icon?: ReactNode | HugeIcon;
  /** Without the frame – for a panel or page where it is the only content */
  bare?: boolean;
  /** Fills its parent's height and centres itself in it – for a list or table area that keeps its size */
  tall?: boolean;
};

export function EmptyState({ title, text, action, icon = FILE, bare, tall, className, ...rest }: EmptyStateProps) {
  return (
    <>
      <div className={["ui-estc", className].filter(Boolean).join(" ")} data-bare={bare || undefined} data-tall={tall || undefined} {...rest}>
        {/* icon={null}: no tile at all, the title moves up */}
        {icon != null && icon !== false && (
          <span className="ui-estc__icon" aria-hidden="true">
            <Glyph icon={icon} />
          </span>
        )}
        <p className="ui-estc__title">{title}</p>
        {text != null && text !== false && <p className="ui-estc__text">{text}</p>}
        {action != null && action !== false && <div className="ui-estc__action">{action}</div>}
      </div>
    </>
  );
}

const isHugeIcon = (icon: unknown): icon is HugeIcon =>
  Array.isArray(icon) && icon.length > 0 && icon.every((part) => Array.isArray(part) && typeof part[0] === "string");

/** Draws a Hugeicons icon object as an inline SVG; anything else is shown as it is */
function Glyph({ icon }: { icon: ReactNode | HugeIcon }) {
  if (!isHugeIcon(icon)) return <>{icon}</>;
  return (
    <svg viewBox="0 0 24 24" fill="none" focusable="false">
      {icon.map(([tag, { key, ...attrs }], i) =>
        createElement(tag, { ...attrs, key: String(key ?? i), ...("strokeWidth" in attrs ? { strokeWidth: STROKE } : null) }),
      )}
    </svg>
  );
}
const STROKE = 1.9;

/** The default glyph: a file – Hugeicons Free (MIT, © Hugeicons, hugeicons.com) */
const line = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" };
const FILE: HugeIcon = [
  ["path", { d: "M8 17H16", ...line }],
  ["path", { d: "M8 13H12", ...line }],
  [
    "path",
    {
      d: "M13 2.5V3C13 5.82843 13 7.24264 13.8787 8.12132C14.7574 9 16.1716 9 19 9H19.5M20 10.6569V14C20 17.7712 20 19.6569 18.8284 20.8284C17.6569 22 15.7712 22 12 22C8.22876 22 6.34315 22 5.17157 20.8284C4 19.6569 4 17.7712 4 14V9.45584C4 6.21082 4 4.58831 4.88607 3.48933C5.06508 3.26731 5.26731 3.06508 5.48933 2.88607C6.58831 2 8.21082 2 11.4558 2C12.1614 2 12.5141 2 12.8372 2.11401C12.9044 2.13772 12.9702 2.165 13.0345 2.19575C13.3436 2.34355 13.593 2.593 14.0919 3.09188L18.8284 7.82843C19.4065 8.40649 19.6955 8.69552 19.8478 9.06306C20 9.4306 20 9.83935 20 10.6569Z",
      ...line,
    },
  ],
];
