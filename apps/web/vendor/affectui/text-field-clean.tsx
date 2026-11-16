/*
 * Derived from affectUI Pro 'Text Field' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./text-field-clean.css";
import { useId, useState, type ComponentPropsWithRef, type ReactNode } from "react";

import { Tooltip } from "./tooltip-clean";

/*
 * Text Field – clean style. One input for every form: a label, an optional hint, an icon before the value, a reveal
 * button for passwords and an error that takes the hint's place. White with a hairline shadow; focus firms up the edge.
 *
 * BiVelio: 44px high everywhere (a touch target, and 16px text so iOS does not zoom). The reveal button's two names
 * arrive translated (`reveal`), and it carries the library's Tooltip. `invalid` marks the field without printing a
 * message under it – the access forms say the error ONCE, in the form's alert, and point at it with
 * aria-describedby. Gone: sizes, suffix text, clear, copy and the character count (nothing here uses them).
 */

export type TextFieldProps = Omit<ComponentPropsWithRef<"input">, "size" | "prefix"> & {
  /** Shown above the field and tied to it */
  label: ReactNode;
  /** A quiet line under the field – the error takes its place while there is one */
  hint?: ReactNode;
  /** Marks the field invalid and shows this under it, in place of the hint */
  error?: ReactNode;
  /** Marks the field invalid without a message of its own (the form's alert carries it) */
  invalid?: boolean;
  /** An icon inside the field, before the value */
  icon?: ReactNode;
  /** A short note beside the label, e.g. "from your invitation" */
  aside?: ReactNode;
  /** type="password" only: the names of the reveal button, already translated */
  reveal?: { show: string; hide: string };
  /** Extra class on the input itself; className goes on the wrapper */
  inputClassName?: string;
};

export function TextField({
  label,
  hint,
  error,
  invalid = false,
  icon,
  aside,
  reveal,
  className,
  inputClassName,
  id,
  type = "text",
  disabled,
  readOnly,
  "aria-describedby": describedBy,
  ...rest
}: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? `ui-tfc-${auto}`;
  const messageId = `${fieldId}-message`;
  const [revealed, setRevealed] = useState(false);

  const hasError = error != null && error !== false && error !== "";
  const bad = hasError || invalid;
  const message = hasError ? error : hint;
  const hasMessage = message != null && message !== false && message !== "";
  const isPassword = type === "password";
  const described = [describedBy, hasMessage ? messageId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div
      className={["ui-tfc", className].filter(Boolean).join(" ")}
      data-invalid={bad || undefined}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
    >
      <div className="ui-tfc__head">
        <label className="ui-tfc__label" htmlFor={fieldId}>
          {label}
        </label>
        {aside != null && aside !== false ? <span className="ui-tfc__optional">{aside}</span> : null}
      </div>
      <div className="ui-tfc__box">
        {icon != null && icon !== false ? (
          <span className="ui-tfc__affix" data-side="start" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <input
          {...rest}
          id={fieldId}
          className={["ui-tfc__input", inputClassName].filter(Boolean).join(" ")}
          type={isPassword && revealed ? "text" : type}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={bad || undefined}
          aria-describedby={described}
          data-revealed={isPassword && reveal ? (revealed ? "true" : "false") : undefined}
        />
        {isPassword && reveal ? (
          <Tooltip content={revealed ? reveal.hide : reveal.show} align="end">
            <button
              type="button"
              className="ui-tfc__action"
              aria-label={revealed ? reveal.hide : reveal.show}
              aria-pressed={revealed}
              disabled={disabled}
              onClick={() => setRevealed((r) => !r)}
            >
              <span className="ui-tfc__swap" key={revealed ? "hide" : "show"}>
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
              </span>
            </button>
          </Tooltip>
        ) : null}
      </div>
      {hasMessage ? (
        <div className="ui-tfc__foot">
          <p className="ui-tfc__message" id={messageId} key={hasError ? "error" : "hint"}>
            {message}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const EyeIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
    <path {...stroke} d="M2.4 10s2.8-5 7.6-5 7.6 5 7.6 5-2.8 5-7.6 5-7.6-5-7.6-5zM10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z" />
  </svg>
);
const EyeOffIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
    <path
      {...stroke}
      d="M3.2 3.2l13.6 13.6M8.3 5.3A7.6 7.6 0 0 1 10 5c4.8 0 7.6 5 7.6 5a13 13 0 0 1-2.2 2.8M12.9 14.3A7 7 0 0 1 10 15c-4.8 0-7.6-5-7.6-5a13 13 0 0 1 3.1-3.6M8.4 8.4a2.3 2.3 0 0 0 3.2 3.2"
    />
  </svg>
);
