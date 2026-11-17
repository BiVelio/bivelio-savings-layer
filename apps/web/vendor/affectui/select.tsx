/*
 * Derived from affectUI Pro 'Select' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";


import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

/*
 * Select – a single self-contained file, clean style.
 * Pick one option from a list: a field in the Text Field's look that opens a list under it (or above, when there is
 * no room), options with an icon and a quiet second line, a check on the chosen one and a soft highlight that glides
 * to where the pointer or the arrow keys are. Typing a letter jumps to the option. The list sits in the top layer,
 * so a card's overflow never cuts it. The styles live in the sibling .css file.
 */

export type SelectOption = {
  value: string;
  label: string;
  /** A quiet second line under the label */
  description?: string;
  /** A 16px icon before the label, e.g. an inline SVG */
  icon?: ReactNode;
  disabled?: boolean;
};

export type SelectProps = {
  options: SelectOption[];
  /** The chosen value – makes it controlled */
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string, option: SelectOption) => void;
  /** Shown while nothing is chosen */
  placeholder?: string;
  /** Shown above the field and tied to it */
  label?: ReactNode;
  /** A quiet line under the field – the error takes its place while there is one */
  hint?: ReactNode;
  /** Marks the field invalid and shows this under it, in place of the hint */
  error?: ReactNode;
  /** BiVelio: the already-translated "optional" text next to the label */
  optional?: ReactNode;
  /** sm 28 · md 32 · lg 36 high */
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  /** BiVelio: the list is at least this wide (px), never wider than the window – room for option descriptions. Upstream: 180 */
  menuMinWidth?: number;
  /** Sends the value with a form, through a hidden input */
  name?: string;
  required?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function Select({
  options,
  value: valueProp,
  defaultValue = null,
  onChange,
  placeholder = "",
  label,
  hint,
  error,
  optional,
  size = "md",
  disabled = false,
  menuMinWidth = 180,
  name,
  required,
  id,
  className,
  "aria-label": ariaLabel,
  ref,
}: SelectProps) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const listId = `${autoId}-list`;
  const labelId = `${autoId}-label`;
  const messageId = `${autoId}-message`;
  const optionId = (i: number) => `${autoId}-option-${i}`;

  const [own, setOwn] = useState<string | null>(defaultValue);
  const value = valueProp !== undefined ? valueProp : own;
  const chosen = options.find((o) => o.value === value) ?? null;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const [glow, setGlow] = useState<{ top: number; height: number } | null>(null);

  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const invalid = Boolean(error);
  const message = shows(error) ? error : shows(hint) ? hint : null;
  const scale = SIZES.includes(size) ? size : "md";
  const enabled = (i: number) => i >= 0 && i < options.length && !options[i].disabled;

  const first = () => options.findIndex((o) => !o.disabled);
  const last = () => {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return -1;
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
    return from;
  };

  const show = (at?: number) => {
    if (disabled || !options.length) return;
    const chosenAt = options.findIndex((o) => o.value === value);
    setActive(at ?? (enabled(chosenAt) ? chosenAt : first()));
    setOpen(true);
  };
  const hide = (focusBack = true) => {
    setOpen(false);
    setGlow(null);
    setPlace(null);
    if (focusBack) trigger.current?.focus({ preventScroll: true });
  };
  const pick = (i: number) => {
    if (!enabled(i)) return;
    const o = options[i];
    if (valueProp === undefined) setOwn(o.value);
    if (o.value !== value) onChange?.(o.value, o);
    hide();
  };

  // Where the list goes: under the field, or above it when there is more room there; as wide as the field
  const measure = () => {
    const t = trigger.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const below = window.innerHeight - r.bottom - gap - edge;
    const above = r.top - gap - edge;
    const want = Math.min(list.current?.scrollHeight ?? 280, 288);
    const up = below < Math.min(want, 160) && above > below;
    const width = Math.min(Math.max(r.width, menuMinWidth), window.innerWidth - edge * 2);
    const left = Math.min(Math.max(edge, r.left), window.innerWidth - width - edge);
    setPlace({ top: up ? r.top - gap : r.bottom + gap, left, width, maxHeight: Math.max(120, Math.min(288, up ? above : below)), up });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    // The top layer, so no overflow cuts it and no z-index fights it
    if (el && "showPopover" in el && !el.matches(":popover-open")) el.showPopover();
    measure();
    const update = () => measure();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (el && "hidePopover" in el && el.matches(":popover-open")) el.hidePopover();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A press anywhere else closes it, without taking the focus back
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (trigger.current?.contains(target) || list.current?.contains(target)) return;
      hide(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The highlight glides to the active option, and the list scrolls it into view
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!row) return;
    setGlow({ top: row.offsetTop, height: row.offsetHeight });
    row.scrollIntoView({ block: "nearest" });
  }, [active, open, place]);

  // Typing letters jumps to the next option that starts with them, like a native select
  const typeahead = (key: string) => {
    const now = Date.now();
    typed.current.text = now - typed.current.at > 700 ? key : typed.current.text + key;
    typed.current.at = now;
    const q = typed.current.text.toLowerCase();
    const start = open ? active : options.findIndex((o) => o.value === value);
    const order = [...options.keys()].map((k) => (k + start + (q.length === 1 ? 1 : 0) + options.length) % options.length);
    const hit = order.find((i) => enabled(i) && options[i].label.toLowerCase().startsWith(q));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else pick(hit);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(e.key);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => step(a, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => step(a, -1));
        break;
      case "Home":
      case "PageUp":
        e.preventDefault();
        setActive(first());
        break;
      case "End":
      case "PageDown":
        e.preventDefault();
        setActive(last());
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (e.key === " " && Date.now() - typed.current.at < 700) typeahead(" ");
        else pick(active);
        break;
      case "Escape":
        e.preventDefault();
        hide();
        break;
      case "Tab":
        hide(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(e.key);
    }
  };

  return (
    <div
      className={["ui-selc", className].filter(Boolean).join(" ")}
      data-size={scale}
      data-open={open || undefined}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
    >
      {label != null && (
        <div className="ui-selc__head">
          <label className="ui-selc__label" id={labelId} htmlFor={triggerId}>
            {label}
          </label>
          {optional != null && optional !== false && <span className="ui-selc__optional">{optional}</span>}
        </div>
      )}
      <button
        ref={(el) => {
          trigger.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        id={triggerId}
        type="button"
        className="ui-selc__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : label != null ? `${labelId} ${triggerId}` : undefined}
        aria-describedby={message ? messageId : undefined}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        {chosen?.icon && (
          <span className="ui-selc__icon" aria-hidden="true">
            {chosen.icon}
          </span>
        )}
        <span className="ui-selc__value" data-empty={chosen ? undefined : ""} title={chosen?.label}>
          {chosen ? chosen.label : placeholder}
        </span>
        <span className="ui-selc__chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {name && <input type="hidden" name={name} value={value ?? ""} />}
      {open && (
        <div
          ref={list}
          id={listId}
          className="ui-selc__list"
          role="listbox"
          aria-labelledby={label != null ? labelId : undefined}
          aria-label={label == null ? ariaLabel ?? placeholder : undefined}
          popover="manual"
          data-up={place?.up || undefined}
          style={place ? { top: place.up ? undefined : place.top, bottom: place.up ? window.innerHeight - place.top : undefined, left: place.left, width: place.width, maxHeight: place.maxHeight } : undefined}
          onPointerLeave={() => setActive(-1)}
        >
          {glow && <span className="ui-selc__glow" aria-hidden="true" style={{ transform: `translateY(${glow.top}px)`, height: glow.height }} />}
          {options.map((o, i) => (
            <div
              key={o.value}
              id={optionId(i)}
              className="ui-selc__option"
              role="option"
              data-index={i}
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-active={i === active || undefined}
              onPointerMove={() => o.disabled || i === active || setActive(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              {o.icon && (
                <span className="ui-selc__icon" aria-hidden="true">
                  {o.icon}
                </span>
              )}
              <span className="ui-selc__text">
                <span className="ui-selc__option-label">{o.label}</span>
                {o.description && <span className="ui-selc__option-hint">{o.description}</span>}
              </span>
              <span className="ui-selc__check" aria-hidden="true">
                {o.value === value && <CheckIcon />}
              </span>
            </div>
          ))}
        </div>
      )}
      {message && (
        <p className="ui-selc__message" id={messageId} key={shows(error) ? "error" : "hint"} aria-live={shows(error) ? "polite" : undefined}>
          {message}
        </p>
      )}
    </div>
  );
}

const SIZES = ["sm", "md", "lg"];
/** Text or an element – not true, false, null or an empty string */
const shows = (v: ReactNode) => v != null && typeof v !== "boolean" && v !== "";

/* Icons: Hugeicons Free (MIT) */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="ui-selc__tick" d="M5 12.5 9.5 17 19 7" pathLength={1} />
    </svg>
  );
}
