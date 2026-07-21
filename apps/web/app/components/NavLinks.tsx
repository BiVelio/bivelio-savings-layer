"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

/**
 * The marketing/navigation links in the top nav. Hidden on the auth surfaces
 * (login / signup) so those pages stay focused on the form — only the brand and
 * the theme toggle remain there.
 */
export function NavLinks({ authed }: { authed: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/signup") return null;

  return (
    <>
      <a className="nav-link" href="/#verify">{t("verifier")}</a>
      <a className="nav-link" href="/#pricing">{t("pricing")}</a>
      {authed ? (
        <Link className="nav-link" href="/dashboard">{t("dashboard")}</Link>
      ) : (
        <Link className="nav-link" href="/login">{t("signIn")}</Link>
      )}
    </>
  );
}
