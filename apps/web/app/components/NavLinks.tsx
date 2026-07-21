"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

/**
 * The auth CTA in the top nav — only the Sign in link (or Dashboard when the
 * visitor is already signed in). No marketing links: the landing's hero already
 * links to the verifier and pricing sections. Hidden on the auth surfaces
 * (login / signup) so those pages stay focused on the form.
 */
export function NavLinks({ authed }: { authed: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/signup") return null;

  return authed ? (
    <Link className="nav-link" href="/dashboard">{t("dashboard")}</Link>
  ) : (
    <Link className="nav-link" href="/login">{t("signIn")}</Link>
  );
}
