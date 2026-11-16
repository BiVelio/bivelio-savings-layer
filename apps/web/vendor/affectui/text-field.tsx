/*
 * Derived from affectUI Pro 'Text Field' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./text-field.css";

import { useEffect, useId, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";

/*
 * Text Field – a single self-contained file, clean style.
 * One input for every form: a label, an optional hint, prefix and suffix text or icons, a clear, reveal or copy
 * button, a character count and an error that takes the hint's place. White with a hairline shadow; focus only
 * firms up the edge – no ring. The styles live in the sibling .css file.
 */

export type TextFieldProps = Omit<ComponentPropsWithRef<"input">, "size" | "prefix"> & {
  /** Shown above the field and tied to it */
  label?: ReactNode;
  /** A quiet line under the field – the error takes its place while there is one */
  hint?: ReactNode;
  /** Marks the field invalid and shows this under it, in place of the hint */
  error?: ReactNode;
  /** Text or an icon inside the field, before the value – e.g. "https://" or a search icon */
  prefix?: ReactNode;
  /** Text or an icon inside the field, after the value – e.g. ".acme.app" or "USD" */
  suffix?: ReactNode;
  /** sm 28 · md 32 · lg 36 high */
  size?: "sm" | "md" | "lg";
  /** BiVelio: the already-translated "optional" text next to the label (upstream: a boolean that printed English) */
  optional?: ReactNode;
  /** BiVelio: accessible names of the built-in buttons. A button without its label is not rendered */
  labels?: { clear?: string; showPassword?: string; hidePassword?: string; copy?: string; copied?: string };
  /** A small × that empties the field while it has a value */
  clearable?: boolean;
  /** A copy button – for API keys, links and IDs, usually with readOnly */
  copyable?: boolean;
  /** Shows "12/40" under the field; needs maxLength */
  counter?: boolean;
  /** Called after the × emptied the field (onChange fires too) */
  onClear?: () => void;
  /** Extra class on the input itself; className goes on the wrapper */
  inputClassName?: string;
};

export function TextField({
  label,
  hint,
  error,
  prefix,
  suffix,
  size = "md",
  optional,
  labels = {},
  clearable = false,
  copyable = false,
  counter = false,
  onClear,
  onKeyDown,
  className,
  inputClassName,
  id,
  type = "text",
  value,
  defaultValue,
  onChange,
  disabled,
  readOnly,
  maxLength,
  ref,
  "aria-describedby": describedBy,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const messageId = `${autoId}-message`;
  const counterId = `${autoId}-count`;
  const input = useRef<HTMLInputElement | null>(null);

  // The current text, for the count and the × – follows value when controlled, the input itself otherwise
  const [own, setOwn] = useState(String(defaultValue ?? ""));
  const text = value !== undefined && value !== null ? String(value) : own;

  const isPassword = type === "password";
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const invalid = Boolean(error) || rest["aria-invalid"] === true || rest["aria-invalid"] === "true";
  // Only text or elements count – error={true} marks the field invalid without leaving an empty line
  const message = shows(error) ? error : shows(hint) ? hint : null;
  const showCount = counter && typeof maxLength === "number";
  // Without a label, the placeholder names the field for screen readers
  const fallbackName =
    label == null && !rest["aria-label"] && !rest["aria-labelledby"] && typeof rest.placeholder === "string" ? rest.placeholder : undefined;

  // An uncontrolled field follows form.reset(), so the count and the × don't show the old text
  useEffect(() => {
    const form = input.current?.form;
    if (!form || value !== undefined) return;
    const onReset = () => window.setTimeout(() => setOwn(input.current?.value ?? ""));
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [value]);
  const showClear = clearable && !!labels.clear && !disabled && !readOnly && text.length > 0;
  const scale = SIZES.includes(size) ? size : "md";

  const clear = () => {
    const el = input.current;
    if (!el) return;
    // Sets the value the way typing would, so React's onChange runs for controlled fields too
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    onClear?.();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard (an insecure page or a denied permission): select the text, so ⌘C works
      input.current?.select();
      return;
    }
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={["ui-tfc", className].filter(Boolean).join(" ")}
      data-size={scale}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
    >
      {label != null && (
        <div className="ui-tfc__head">
          <label className="ui-tfc__label" htmlFor={inputId}>
            {label}
          </label>
          {shows(optional) && <span className="ui-tfc__optional">{optional}</span>}
        </div>
      )}
      {/* A click anywhere on the box – the prefix, the padding – puts the caret in the input */}
      <div
        className="ui-tfc__box"
        onPointerDown={(e) => {
          if (e.target === input.current || (e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          input.current?.focus();
        }}
      >
        {prefix != null && (
          <span className="ui-tfc__affix" data-side="start">
            {/* Long text is cut at its start – the part next to the value is the one that matters */}
            {typeof prefix === "string" ? <span className="ui-tfc__affix-text">{prefix}</span> : prefix}
          </span>
        )}
        <input
          {...rest}
          ref={(el) => {
            input.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          id={inputId}
          className={["ui-tfc__input", inputClassName].filter(Boolean).join(" ")}
          type={isPassword && revealed ? "text" : type}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          readOnly={readOnly}
          maxLength={maxLength}
          aria-label={rest["aria-label"] ?? fallbackName}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, message ? messageId : null, showCount ? counterId : null].filter(Boolean).join(" ") || undefined}
          dir={rest.dir ?? "auto"}
          data-revealed={isPassword ? (revealed ? "true" : "false") : undefined}
          onKeyDown={(e) => {
            // Esc empties a clearable field, like a search field on macOS and iOS
            if (e.key === "Escape" && showClear) {
              e.preventDefault();
              clear();
            }
            onKeyDown?.(e);
          }}
          onChange={(e) => {
            if (value === undefined) setOwn(e.target.value);
            onChange?.(e);
          }}
        />
        {suffix != null && <span className="ui-tfc__affix" data-side="end">{suffix}</span>}
        {showClear && (
          <button type="button" className="ui-tfc__action" aria-label={labels.clear} tabIndex={-1} onClick={clear}>
            <ClearIcon />
          </button>
        )}
        {isPassword && !disabled && labels.showPassword && labels.hidePassword && (
          <button
            type="button"
            className="ui-tfc__action"
            aria-label={revealed ? labels.hidePassword : labels.showPassword}
            aria-pressed={revealed}
            onClick={() => setRevealed((r) => !r)}
          >
            <span className="ui-tfc__swap" key={revealed ? "hide" : "show"}>
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </span>
          </button>
        )}
        {copyable && labels.copy && labels.copied && (
          <button
            type="button"
            className="ui-tfc__action"
            data-copied={copied || undefined}
            aria-label={copied ? labels.copied : labels.copy}
            onClick={copy}
            disabled={disabled || !text}
          >
            <span className="ui-tfc__swap" key={copied ? "done" : "copy"}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
          </button>
        )}
        {copyable && labels.copy && labels.copied && (
          <span className="ui-tfc__sr" role="status">
            {copied ? labels.copied : ""}
          </span>
        )}
      </div>
      {(message || showCount) && (
        <div className="ui-tfc__foot">
          {/* The error swaps in where the hint was, so the form below doesn't move */}
          <p className="ui-tfc__message" id={messageId} key={shows(error) ? "error" : "hint"} dir="auto" aria-live={shows(error) ? "polite" : undefined}>
            {message}
          </p>
          {showCount && (
            <span
              className="ui-tfc__count"
              id={counterId}
              data-full={text.length === maxLength || undefined}
              data-over={text.length > maxLength || undefined}
            >
              {text.length}/{maxLength}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const SIZES = ["sm", "md", "lg"];
/** Text or an element – not true, false, null or an empty string */
const shows = (v: ReactNode) => v != null && typeof v !== "boolean" && v !== "";

/* Icons: Hugeicons Free (MIT), drawn at 16px */
function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm3.53 12.22a.75.75 0 1 1-1.06 1.06L12 13.06l-2.47 2.47a.75.75 0 0 1-1.06-1.06L10.94 12 8.47 9.53a.75.75 0 0 1 1.06-1.06L12 10.94l2.47-2.47a.75.75 0 1 1 1.06 1.06L13.06 12l2.47 2.47Z" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.544 11.045C21.848 11.471 22 11.685 22 12c0 .316-.152.529-.456.955C20.178 14.871 16.689 19 12 19c-4.69 0-8.178-4.13-9.544-6.045C2.152 12.529 2 12.315 2 12c0-.316.152-.529.456-.955C3.822 9.129 7.311 5 12 5c4.69 0 8.178 4.13 9.544 6.045Z" />
      <path d="M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.439 15.439c.996-.91 1.719-1.82 2.105-2.36.304-.426.456-.64.456-.955 0-.316-.152-.529-.456-.955C20.178 9.253 16.689 5.124 12 5.124c-.908 0-1.77.155-2.582.418M6.74 6.869c-2.09 1.267-3.6 3.083-4.284 4.04-.304.426-.456.64-.456.955 0 .316.152.529.456.955C3.822 14.735 7.311 18.864 12 18.864c2.008 0 3.786-.757 5.26-1.746" />
      <path d="M9.858 10a2.98 2.98 0 0 0-.858 2.124 3 3 0 0 0 5.124 2.12M3 3l18 18" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 15c0-2.828 0-4.243.879-5.121C10.757 9 12.172 9 15 9h1c2.828 0 4.243 0 5.121.879C22 10.757 22 12.172 22 15v1c0 2.828 0 4.243-.879 5.121C20.243 22 18.828 22 16 22h-1c-2.828 0-4.243 0-5.121-.879C9 20.243 9 18.828 9 16v-1Z" />
      <path d="M17 9c-.003-2.957-.047-4.489-.908-5.538a4 4 0 0 0-.554-.554C14.43 2 12.788 2 9.5 2c-3.287 0-4.931 0-6.038.908a4 4 0 0 0-.554.554C2 4.57 2 6.212 2 9.5c0 3.287 0 4.931.908 6.038a4 4 0 0 0 .554.554c1.05.86 2.58.906 5.538.908" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="ui-tfc__check" d="M5 12.5 9.5 17 19 7" pathLength={1} />
    </svg>
  );
}
