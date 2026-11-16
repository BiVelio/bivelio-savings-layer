/*
 * Derived from affectUI Pro 'profile-menu' (https://www.affectui.com). Used under the
 * affectUI Pro license held by BiVelio. NOT covered by this repository's
 * Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./profile-menu.css";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/*
 * Profile Menu – the account card of the top bar. Upstream is the card alone, with buttons that call `onSelect`,
 * demo items and an English "Profile setup" row. Here it is a real menu button: a trigger (the account's initial,
 * its e-mail and a chevron) that opens the card; every row is a LINK to a page that exists, the last one is a
 * <form method="post"> (signing out is never a GET), and the setup row is the product's own measured progress.
 * Nothing in it is a default: every string arrives through props.
 */

export type ProfileMenuLinkProps = {
  href: string;
  className?: string;
  role?: string;
  tabIndex?: number;
  onClick?: () => void;
  children?: ReactNode;
};

export type ProfileMenuItem = {
  id: string;
  label: string;
  href: string;
  icon?: ReactNode;
  /** A reading on the right ("3 / 5"). Never a "New" pill. */
  badge?: string;
};

export type ProfileMenuSetup = {
  title: string;
  /** "2 of 5", already localized */
  countLabel: string;
  done: number;
  total: number;
  /** "Next:" */
  nextHint?: string;
  /** The next open step and where its instruction lives */
  next?: string;
  href?: string;
};

export type ProfileMenuProps = {
  /** Accessible name of the trigger, e.g. "Account: ana@example.com" */
  triggerLabel: string;
  /** Accessible name of the menu */
  menuLabel: string;
  /** Head of the card: the organization (may be empty when it could not be read) */
  name?: string;
  email: string;
  /** Facts under the e-mail (role, plan). `tone: "brand"` for the plan. */
  tags?: { id: string; label: string; tone?: "brand" }[];
  items: ProfileMenuItem[];
  /** The component links are rendered with (a locale-aware Link). Defaults to <a>. */
  linkAs?: ComponentType<ProfileMenuLinkProps>;
  setup?: ProfileMenuSetup;
  /** Told where a row leads when it is chosen (the menu closes by itself) */
  onNavigate?: (href: string) => void;
  /** Sign out: a POST form, the last row */
  signOut: { action: string; label: string; icon?: ReactNode; className?: string };
  className?: string;
};

const initialOf = (s: string) => s.trim().charAt(0).toUpperCase();

export function ProfileMenu({
  triggerLabel,
  menuLabel,
  name,
  email,
  tags = [],
  items,
  linkAs,
  setup,
  onNavigate,
  signOut,
  className,
}: ProfileMenuProps) {
  const A = linkAs ?? ((p: ProfileMenuLinkProps) => <a {...p} />);
  const uid = useId();
  const menuId = `${uid}-menu`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // `first` / `last`: where the focus lands when the keyboard opens it
  const landing = useRef<"first" | "last" | null>(null);
  const go = (href: string) => {
    setOpen(false);
    onNavigate?.(href);
  };

  const rows = () => [...(card.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const all = rows();
    if (landing.current === "last") all[all.length - 1]?.focus();
    else if (landing.current === "first") all[0]?.focus();
    landing.current = null;
    const away = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys move between the rows, like in a native menu; Tab leaves and closes it
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const all = rows();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (i + 1) % all.length
      : e.key === "ArrowUp" ? (i - 1 + all.length) % all.length
      : e.key === "Home" ? 0
      : e.key === "End" ? all.length - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    all[next]?.focus();
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    landing.current = e.key === "ArrowDown" ? "first" : "last";
    setOpen(true);
  };

  const shownName = (name ?? "").trim();
  const total = Math.max(0, setup?.total ?? 0);
  const done = Math.min(total, Math.max(0, setup?.done ?? 0));
  const ratio = total > 0 ? done / total : 0;

  return (
    <div ref={root} className={["ui-pmc", className].filter(Boolean).join(" ")} data-filled={open || undefined}>
      <button
        ref={trigger}
        type="button"
        className="ui-pmc__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span className="ui-pmc__initial" aria-hidden="true">
          {initialOf(email)}
        </span>
        <span className="ui-pmc__trigger-text" aria-hidden="true">
          {email}
        </span>
        <ChevronIcon />
      </button>

      {open && (
        <div ref={card} className="ui-pmc__card">
          <header className="ui-pmc__user">
            <span className="ui-pmc__avatar" aria-hidden="true">
              <span className="ui-pmc__initial">{initialOf(shownName || email)}</span>
            </span>
            <span className="ui-pmc__who">
              {shownName && (
                <span className="ui-pmc__name" dir="auto">
                  {shownName}
                </span>
              )}
              <span className="ui-pmc__email" dir="auto">
                {email}
              </span>
              {tags.length > 0 && (
                <span className="ui-pmc__meta">
                  {tags.map((tag) => (
                    <span key={tag.id} className="ui-pmc__tag" data-tone={tag.tone}>
                      {tag.label}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </header>

          <div id={menuId} className="ui-pmc__items" role="menu" aria-label={menuLabel} onKeyDown={onMenuKey}>
            {items.map((item) => (
              <A key={item.id} href={item.href} role="menuitem" tabIndex={-1} className="ui-pmc__item" onClick={() => go(item.href)}>
                <span className="ui-pmc__icon">{item.icon}</span>
                <span className="ui-pmc__label" dir="auto">
                  {item.label}
                </span>
                {item.badge && <span className="ui-pmc__badge">{item.badge}</span>}
              </A>
            ))}
            <div className="ui-pmc__sep" role="separator" />
            <form action={signOut.action} method="post">
              <button
                type="submit"
                role="menuitem"
                tabIndex={-1}
                className={["ui-pmc__item", signOut.className].filter(Boolean).join(" ")}
                data-tone="quiet"
              >
                <span className="ui-pmc__icon">{signOut.icon}</span>
                <span className="ui-pmc__label">{signOut.label}</span>
              </button>
            </form>
          </div>

          {setup && total > 0 && (
            <div className="ui-pmc__setup">
              <div className="ui-pmc__setup-head">
                <span className="ui-pmc__setup-title">{setup.title}</span>
                <span className="ui-pmc__setup-count">{setup.countLabel}</span>
              </div>
              {/* The count is written next to it; the bar repeats it for the eye only */}
              <span className="ui-pmc__track" aria-hidden="true">
                <span className="ui-pmc__fill" style={{ transform: `scaleX(${ratio})` }} />
              </span>
              {setup.next && setup.href && done < total && (
                <A href={setup.href} className="ui-pmc__next" onClick={() => go(setup.href ?? "")}>
                  <span className="ui-pmc__next-label" dir="auto">
                    {setup.nextHint ? <span className="ui-pmc__next-hint">{setup.nextHint} </span> : null}
                    {setup.next}
                  </span>
                  <ArrowIcon />
                </A>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ChevronIcon = () => (
  <svg className="ui-pmc__chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

const ArrowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
