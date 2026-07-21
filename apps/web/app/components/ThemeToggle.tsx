"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Theme toggle for the app surfaces. Defaults to the OS preference
 * (`prefers-color-scheme`) and only overrides it once the user clicks — the choice
 * is persisted in localStorage. While no explicit choice exists, it keeps following
 * the OS live. The pre-paint script in the root layout sets the initial `data-theme`
 * so there is no flash before this hydrates.
 */
export function ThemeToggle() {
  const t = useTranslations("app");
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    setTheme(current);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onOsChange = (e: MediaQueryListEvent) => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem("bv-theme");
      } catch {
        /* storage unavailable */
      }
      if (!stored) {
        const next: Theme = e.matches ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        setTheme(next);
      }
    };
    mq.addEventListener("change", onOsChange);
    return () => mq.removeEventListener("change", onOsChange);
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
