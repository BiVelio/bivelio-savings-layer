"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Theme toggle for the app surfaces. Defaults to LIGHT — the OS preference is
 * intentionally ignored — and only changes once the user clicks; the choice is
 * persisted in localStorage. The pre-paint script in the locale layout sets the
 * initial `data-theme` (light unless a stored 'dark' choice exists) so there is
 * no flash before this hydrates.
 */
export function ThemeToggle() {
  const t = useTranslations("app");
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // localStorage is the source of truth (default LIGHT). Re-assert data-theme on
    // the <html> here so the DOM stays correct even if React hydration dropped the
    // attribute the pre-paint script set.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("bv-theme");
    } catch {
      /* storage unavailable */
    }
    const next: Theme = stored === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("bv-theme", next);
    } catch {
      /* storage unavailable — session-only */
    }
    setTheme(next);
  }

  return (
    <button type="button" className="toggle" onClick={toggle} aria-label={t("themeToggle.ariaLabel")} title={t("themeToggle.title")}>
      <span aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
      <span className="toggle-label">{theme === "dark" ? t("themeToggle.dark") : t("themeToggle.light")}</span>
    </button>
  );
}
