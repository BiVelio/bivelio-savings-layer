/*
 * Derived from affectUI Pro 'Setup Guide' (https://www.affectui.com). Used under the affectUI Pro license held by BiVelio. NOT covered by this repository's Apache-2.0 licence; do not redistribute as a component kit.
 *
 * Changes from upstream are listed in ./VENDOR.md.
 */

import { createElement, type ComponentType, type ReactNode } from "react";

/*
 * Setup Guide – BiVelio: a READ-ONLY guide rail. One white card with a hairline shadow, a title, a thin progress
 * line with its count and flat groups of tasks, each with its mark: a blue check when done, an open ring on the
 * current one, a dashed ring while it waits.
 * Upstream lets you tick tasks off and unlocks the next one. Here nobody ticks anything: every status comes from
 * what the product measured, a task is a LINK to its instruction (or plain text), and pressing it marks nothing.
 * So: no state, no script (server component), no Edit / minimize / close, no strike-through on click, no
 * "locked" buttons. A group may have no tasks at all – then it is just the link to its section – and the
 * progress line is drawn only when the caller could read the progress (`progress` omitted = no bar, no count).
 */

export type SetupTaskStatus = "done" | "current" | "pending" | "unavailable";

export type SetupTask = {
  id: string;
  label: ReactNode;
  status: SetupTaskStatus;
  /** The status in words, for screen readers and the title – the mark alone is not enough */
  statusLabel: string;
  href?: string;
};

export type SetupGroup = {
  id: string;
  /** Leave out for a group that is only its tasks */
  title?: ReactNode;
  /** A tiny caption above the group, e.g. "On this page" */
  caption?: ReactNode;
  /** Where the group's instructions are – usually an anchor on the same page */
  href?: string;
  icon?: ReactNode;
  tasks?: SetupTask[];
};

type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

export type SetupGuideProps = {
  title: ReactNode;
  headingAs?: "h2" | "h3";
  groups: SetupGroup[];
  /** Omit when the progress could not be read: no bar and no count are drawn */
  progress?: { done: number; total: number; label: string; countLabel: ReactNode };
  footer?: ReactNode;
  /** Router link for hrefs that are routes; anchors (#…) always use a plain <a> */
  linkAs?: LinkLike;
  className?: string;
  "aria-label"?: string;
};

export function SetupGuide({ title, headingAs = "h2", groups, progress, footer, linkAs, className, "aria-label": ariaLabel }: SetupGuideProps) {
  const ratio = progress && progress.total > 0 ? Math.max(0, Math.min(1, progress.done / progress.total)) : 0;
  const link = (href: string, cls: string, children: ReactNode, key?: string) =>
    href.startsWith("#") || !linkAs ? (
      <a key={key} href={href} className={cls}>
        {children}
      </a>
    ) : (
      createElement(linkAs, { key, href, className: cls }, children)
    );
  return (
    <nav className={["ui-sgdc", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      <header className="ui-sgdc__head">{createElement(headingAs, { className: "ui-sgdc__title" }, title)}</header>

      {progress ? (
        <div className="ui-sgdc__progress">
          <span className="ui-sgdc__track" role="img" aria-label={progress.label}>
            <span className="ui-sgdc__fill" style={{ transform: `scaleX(${ratio})` }} />
          </span>
          <span className="ui-sgdc__count" aria-hidden="true">
            {progress.countLabel}
          </span>
        </div>
      ) : null}

      <div className="ui-sgdc__groups">
        {groups.map((g) => {
          const head = (
            <>
              {g.icon != null ? (
                <span className="ui-sgdc__group-icon" aria-hidden="true">
                  {g.icon}
                </span>
              ) : null}
              <span className="ui-sgdc__group-title">{g.title}</span>
            </>
          );
          return (
            <div key={g.id} className="ui-sgdc__group">
              {g.caption != null && g.caption !== false ? <p className="ui-sgdc__caption">{g.caption}</p> : null}
              {g.title == null ? null : g.href ? link(g.href, "ui-sgdc__group-head", head) : <div className="ui-sgdc__group-head">{head}</div>}
              {g.tasks && g.tasks.length > 0 ? (
                <ul className="ui-sgdc__tasks">
                  {g.tasks.map((t) => {
                    const body = (
                      <>
                        <span className="ui-sgdc__mark" aria-hidden="true">
                          {t.status === "done" ? <CheckIcon /> : t.status === "current" ? null : <WaitIcon />}
                        </span>
                        <span className="ui-sgdc__task-label">{t.label}</span>
                        <span className="ui-sgdc__task-status">{t.statusLabel}</span>
                      </>
                    );
                    return (
                      <li key={t.id}>
                        {t.href ? (
                          <span className="ui-sgdc__task-wrap" data-state={t.status}>
                            {link(t.href, "ui-sgdc__task", body)}
                          </span>
                        ) : (
                          <span className="ui-sgdc__task-wrap" data-state={t.status}>
                            <span className="ui-sgdc__task">{body}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
      {footer != null && footer !== false ? <p className="ui-sgdc__foot">{footer}</p> : null}
    </nav>
  );
}

/* ---------- Icons (16px, thin lines) ---------- */

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="m5.2 8.2 1.9 1.9 3.7-3.9" fill="none" stroke="var(--ui-sgdc-on-accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const WaitIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.5" strokeDasharray="2 2" />
  </svg>
);
