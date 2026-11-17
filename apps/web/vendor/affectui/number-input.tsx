/*
 * Derived from affectUI Pro 'Number Input' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";


import { useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";

import { committedValue, handledKeys, readNumber, roundToStep as round, typedValue } from "./number-input-read";

/*
 * Number Input – a single self-contained file, clean style.
 * A field for one number: − and + to step it (hold to keep going), the arrow keys, Page Up / Page Down for big steps,
 * Home / End for the limits (BiVelio: unless jumpKeys is off). A unit sits right after the value ("4,000 tokens", "25 %"), the value is formatted for
 * the locale when you leave the field and kept between min and max. Label, hint and error like the Text Field; focus
 * only firms up the edge – the buttons get the ring. The styles live in the sibling .css file.
 */

export type NumberInputProps = Omit<
  ComponentPropsWithRef<"input">,
  "type" | "size" | "prefix" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step"
> & {
  /** The number; null is an empty field. Pass it with onValueChange to control the field */
  value?: number | null;
  /** The starting number when the field keeps its own value */
  defaultValue?: number | null;
  /**
   * Called with the new number after a step and when typing is done (blur or Enter) – null when emptied.
   * BiVelio: also while typing, as soon as the text reads as a number (as typed, not clamped yet), so whatever sits
   * next to the field never holds a quantity older than the one on screen. Text that is no number emits nothing.
   */
  onValueChange?: (value: number | null) => void;
  /** The lowest value – typing less is raised to it, − stops there */
  min?: number;
  /** The highest value – typing more is lowered to it, + stops there */
  max?: number;
  /** How much − / + and the arrow keys change the value */
  step?: number;
  /** How much Page Up / Page Down change it – 10 steps by default */
  largeStep?: number;
  /** BiVelio: whole numbers only – text with any separator ("1,5", "1 2") is unreadable and goes back to the last value */
  integer?: boolean;
  /** BiVelio: false leaves Home / End / Page Up / Page Down to the browser (caret only), as in <input type=number> */
  jumpKeys?: boolean;
  /** Text after the value – e.g. "tokens" or "%" */
  unit?: ReactNode;
  /** Text or an icon before the value – e.g. "$" */
  prefix?: ReactNode;
  /** The locale the value is shown and read in – the browser's by default */
  locale?: string;
  /** How the value is shown, e.g. { maximumFractionDigits: 2 } or { style: "percent" } */
  formatOptions?: Intl.NumberFormatOptions;
  /** Shown above the field and tied to it */
  label?: ReactNode;
  /** A quiet line under the field – the error takes its place while there is one */
  hint?: ReactNode;
  /** Marks the field invalid and shows this under it, in place of the hint */
  error?: ReactNode;
  /** BiVelio: the already-translated "optional" text next to the label */
  optional?: ReactNode;
  /** BiVelio: accessible names of − and + (required: upstream printed English) */
  stepLabels: { decrease: string; increase: string };
  /** sm 28 · md 32 · lg 36 high */
  size?: "sm" | "md" | "lg";
  /** Extra class on the input itself; className goes on the wrapper */
  inputClassName?: string;
};

export function NumberInput({
  value,
  defaultValue = null,
  onValueChange,
  min,
  max,
  step = 1,
  largeStep,
  integer = false,
  jumpKeys = true,
  unit,
  prefix,
  locale,
  formatOptions,
  label,
  hint,
  error,
  optional,
  stepLabels,
  size = "md",
  className,
  inputClassName,
  id,
  name,
  form,
  disabled,
  readOnly,
  placeholder,
  onKeyDown,
  onBlur,
  ref,
  "aria-describedby": describedBy,
  ...rest
}: NumberInputProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const messageId = `${autoId}-message`;
  const input = useRef<HTMLInputElement | null>(null);

  const [own, setOwn] = useState<number | null>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : own;
  const num = current != null && Number.isFinite(current) ? current : null;
  // What's typed while the field is being edited; null shows the formatted value
  const [draft, setDraft] = useState<string | null>(null);

  const stepSize = step > 0 && Number.isFinite(step) ? step : 1;
  const bigStep = largeStep && largeStep > 0 ? largeStep : stepSize * 10;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;

  const fmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, formatOptions);
    } catch {
      return new Intl.NumberFormat(undefined, formatOptions);
    }
  }, [locale, formatOptions]);
  const percent = formatOptions?.style === "percent";
  const marks = useMemo(() => separators(fmt), [fmt]);

  const shown = draft ?? (num === null ? "" : fmt.format(num));
  const invalid = Boolean(error) || rest["aria-invalid"] === true || rest["aria-invalid"] === "true";
  const message = shows(error) ? error : shows(hint) ? hint : null;
  const scale = SIZES.includes(size) ? size : "md";
  const fallbackName = label == null && !rest["aria-label"] && !rest["aria-labelledby"] && typeof placeholder === "string" ? placeholder : undefined;

  const clamp = (v: number) => Math.min(hi, Math.max(lo, v));
  const set = (next: number | null) => {
    if (!controlled) setOwn(next);
    if (next !== num) onValueChange?.(next);
  };

  /** Reads what's typed – null when empty, NaN when it's no number (the rules live in number-input-read.ts) */
  const read = (text: string): number | null => readNumber(text, marks, { percent, integer });

  /** Takes what's typed: clamped, formatted; something unreadable goes back to the last value */
  const commit = () => {
    if (draft === null) return;
    const settled = committedValue(draft, marks, { percent, integer, min: lo, max: hi, step: stepSize });
    setDraft(null);
    if (settled !== undefined) set(settled);
  };

  /** One step up or down from the current (or typed) value, onto the step grid */
  const nudge = (dir: 1 | -1, by = stepSize) => {
    if (disabled || readOnly) return;
    const typed = draft !== null ? read(draft) : num;
    // BiVelio: unreadable text steps from the last value, not from the minimum; only an empty field starts over
    const base = typed === null ? null : Number.isFinite(typed) ? typed : num;
    // An empty field starts at min (or 0) – the first press doesn't skip a step
    const origin = Number.isFinite(lo) ? lo : 0;
    let next: number;
    if (base === null) next = clamp(Number.isFinite(lo) ? lo : 0);
    else if (by !== stepSize) next = clamp(round(origin + Math.round((base + dir * by - origin) / stepSize) * stepSize, stepSize));
    else {
      const k = (base - origin) / by;
      // Off the grid: the first step lands on it instead of jumping past
      const snapped = dir > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1;
      next = clamp(round(origin + snapped * by, by));
    }
    setDraft(null);
    // Already at the limit: nothing moves
    if (next === base) {
      if (draft !== null) set(next);
      return;
    }
    set(next);
    roll(input.current, dir);
  };

  const atMin = num !== null && num <= lo;
  const atMax = num !== null && num >= hi;

  // Hold − or + to keep stepping: a pause, then faster
  const hold = useRef<{ timer: number; dir: 1 | -1 } | null>(null);
  const stop = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;
  const press = (dir: 1 | -1) => {
    stop();
    nudgeRef.current(dir);
    const tick = (delay: number) => {
      hold.current = {
        dir,
        timer: window.setTimeout(() => {
          nudgeRef.current(dir);
          // After the first pause it repeats quickly and speeds up a little
          tick(delay >= 400 ? 120 : Math.max(40, delay * 0.9));
        }, delay),
      };
    };
    tick(400);
  };
  useEffect(() => stop, []);
  // Stops at the limit, so a held button doesn't keep firing at nothing
  useEffect(() => {
    if (hold.current && ((hold.current.dir > 0 && atMax) || (hold.current.dir < 0 && atMin))) stop();
  }, [atMax, atMin]);

  const unitText = typeof unit === "string" ? unit : "";
  const valueText = num === null ? undefined : `${typeof prefix === "string" ? prefix : ""}${fmt.format(num)}${unitText ? ` ${unitText}` : ""}`;

  const stepper = (dir: 1 | -1) => {
    const blocked = disabled || readOnly || (dir > 0 ? atMax : atMin);
    return (
      <button
        type="button"
        className="ui-nmic__step"
        // One tab stop per field, as in the spinbutton pattern: the arrow keys step, the buttons are for the pointer
        tabIndex={-1}
        aria-label={dir > 0 ? stepLabels.increase : stepLabels.decrease}
        aria-controls={inputId}
        aria-disabled={blocked || undefined}
        disabled={disabled}
        // Keeps the caret in the field while you click, and starts the hold-to-repeat
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (!blocked) press(dir);
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
        // Enter or Space on a focused button (pointer clicks are handled above)
        onClick={(e) => {
          if (e.detail === 0 && !blocked) nudge(dir);
        }}
      >
        {dir > 0 ? <PlusIcon /> : <MinusIcon />}
      </button>
    );
  };

  return (
    <div
      className={["ui-nmic", className].filter(Boolean).join(" ")}
      data-size={scale}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
    >
      {label != null && (
        <div className="ui-nmic__head">
          <label className="ui-nmic__label" htmlFor={inputId}>
            {label}
          </label>
          {optional != null && optional !== false && <span className="ui-nmic__optional">{optional}</span>}
        </div>
      )}
      {/* A click anywhere on the box – the unit, the padding – puts the caret in the input */}
      <div
        className="ui-nmic__box"
        onPointerDown={(e) => {
          if (e.target === input.current || (e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          input.current?.focus();
        }}
      >
        {prefix != null && <span className="ui-nmic__affix" data-side="start">{prefix}</span>}
        <input
          {...rest}
          ref={(el) => {
            input.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          id={inputId}
          className={["ui-nmic__input", inputClassName].filter(Boolean).join(" ")}
          type="text"
          // Phone keypads: digits only, a decimal key when the value has decimals, the full keyboard when it can go below 0
          inputMode={lo < 0 ? "text" : !Number.isInteger(stepSize) || marks.decimals || percent ? "decimal" : "numeric"}
          role="spinbutton"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          form={form}
          aria-label={rest["aria-label"] ?? fallbackName}
          aria-valuenow={num ?? undefined}
          aria-valuemin={Number.isFinite(lo) ? lo : undefined}
          aria-valuemax={Number.isFinite(hi) ? hi : undefined}
          aria-valuetext={valueText}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, message ? messageId : null].filter(Boolean).join(" ") || undefined}
          // The value hugs its text, so the unit sits right after it
          style={{ width: `calc(${Math.max(2, (shown || placeholder || "").length)}ch + 2px)`, ...rest.style }}
          onChange={(e) => {
            const text = e.target.value.replace(ALLOWED, "");
            setDraft(text);
            // BiVelio: readable text counts at once; unreadable text leaves the last value standing
            const typed = typedValue(text, marks, { percent, integer });
            if (typed !== undefined) set(typed);
          }}
          onBlur={(e) => {
            commit();
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented || e.nativeEvent.isComposing) return;
            const keys: Record<string, () => void> = {
              ArrowUp: () => nudge(1),
              ArrowDown: () => nudge(-1),
              PageUp: () => nudge(1, bigStep),
              PageDown: () => nudge(-1, bigStep),
              Enter: () => commit(),
              Escape: () => setDraft(null),
            };
            if (Number.isFinite(lo)) keys.Home = () => (setDraft(null), set(lo), roll(input.current, -1));
            if (Number.isFinite(hi)) keys.End = () => (setDraft(null), set(hi), roll(input.current, 1));
            // BiVelio: only the keys the field takes over; the rest stay the browser's (number-input-read.ts)
            const run = handledKeys({ min: lo, max: hi, jumpKeys }).includes(e.key) ? keys[e.key] : undefined;
            if (!run || readOnly) return;
            // Enter still submits the form; Escape only counts while something was typed
            if (e.key === "Escape" && draft === null) return;
            if (e.key !== "Enter") e.preventDefault();
            run();
          }}
        />
        {unit != null && <span className="ui-nmic__affix" data-side="end">{unit}</span>}
        <span className="ui-nmic__steps">
          {stepper(-1)}
          {stepper(1)}
        </span>
      </div>
      {/* The plain number goes with the form, not the formatted text */}
      {name && <input type="hidden" name={name} form={form} value={num ?? ""} disabled={disabled} />}
      {message && (
        <p className="ui-nmic__message" id={messageId} key={shows(error) ? "error" : "hint"} dir="auto" aria-live={shows(error) ? "polite" : undefined}>
          {message}
        </p>
      )}
    </div>
  );
}

const SIZES = ["sm", "md", "lg"];
/** What can be typed: digits, separators, a minus, a percent sign – letters never show up */
const ALLOWED = /[^\d.,'’\s  \-−%]/g;
/** Text or an element – not true, false, null or an empty string */
const shows = (v: ReactNode) => v != null && typeof v !== "boolean" && v !== "";

/** The locale's group and decimal marks, and whether the format always shows decimals */
function separators(fmt: Intl.NumberFormat) {
  const parts = fmt.formatToParts(-12345.6789);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? "",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    // Shown with decimals on purpose (minimumFractionDigits), so a decimal key is needed
    decimals: (fmt.resolvedOptions().minimumFractionDigits ?? 0) > 0,
  };
}

/** The one motion: the new value rolls in from the direction it moved */
function roll(el: HTMLInputElement | null, dir: 1 | -1) {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { transform: `translateY(${dir * 5}px)`, opacity: 0.35, filter: "blur(1.5px)" },
      { transform: "none", opacity: 1, filter: "none" },
    ],
    { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

/* Icons: Hugeicons Free (MIT), drawn at 16px */
function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M20 12H4" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 4v16M20 12H4" />
    </svg>
  );
}
