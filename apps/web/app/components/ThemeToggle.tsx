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
    // Sync React state from the data-theme the pre-paint script already applied.
    const current = (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    setTheme(current);
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
