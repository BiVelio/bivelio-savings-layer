"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

import { ArrowRightIcon } from "./icons";

/**
 * Enlaces de sección junto a la marca, al modo de los menús de bivelio.com.
 * Solo en la landing: apuntan a anclas (#verify, #pricing) que únicamente
 * existen ahí, así que en cualquier otra ruta no se pintan.
 */
export function NavSections() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  if (pathname !== "/") return null;

  return (
    <div className="nav-menu">
      <a className="nav-link" href="#verify">
        {t("verifier")}
      </a>
      <a className="nav-link" href="#pricing">
        {t("pricing")}
      </a>
    </div>
  );
}

/**
 * El CTA persistente: un solo botón tinta, como el del nav corporativo.
 * "Dashboard" si ya hay sesión, "Sign in" si no. Oculto en las propias
 * pantallas de login / signup, que ya son ese destino.
 */
export function NavCta({ authed }: { authed: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/signup") return null;

  return (
    <Link className="btn btn-primary nav-cta" href={authed ? "/dashboard" : "/login"}>
      {authed ? t("dashboard") : t("signIn")}
      <ArrowRightIcon />
    </Link>
  );
}
