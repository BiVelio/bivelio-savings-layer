"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

import { BivelioWordmark } from "./BivelioWordmark";

import { ArrowRightIcon, CloseIcon, GlobeIcon, HowIcon, MenuIcon, ReceiptIcon, VerifyIcon } from "./icons";

/**
 * Enlaces de sección junto a la marca, al modo de los menús de bivelio.com.
 * Solo en la landing: apuntan a anclas (#measured, #pricing) que únicamente
 * existen ahí, así que en cualquier otra ruta no se pintan.
 */
export function NavSections() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  // También en /how-it-works: la página explicativa comparte el nav de marketing.
  if (pathname !== "/" && pathname !== "/how-it-works") return null;

  return (
    <div className="nav-menu">
      <Link className="nav-link" href="/how-it-works">
        {t("howItWorks")}
      </Link>
      {/* Apuntaba a `/#verify`, y ese ancla NO EXISTE en la landing: las únicas
          son #measured, #anthropic-cache y #pricing (ver [locale]/page.tsx), así
          que el enlace no llevaba a ninguna parte — se quedaba donde estabas.
          El destino correcto es la sección de la medición, que es lo que este
          enlace promete. */}
      <Link className="nav-link" href="/#measured">
        {t("verifier")}
      </Link>
      <Link className="nav-link" href="/#pricing">
        {t("pricing")}
      </Link>
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

/**
 * Menú móvil, clon del hamburguesa del <SiteNav> de bivelio.com: disparador en
 * la cabecera y panel a todo el ancho con cada destino como fila de tesela
 * (icono en caja de 32px con hairline) y el CTA tinta al pie. Mismas rutas que
 * las secciones de escritorio, así que también solo en landing / how-it-works.
 */
export function MobileMenu({ authed }: { authed: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  if (pathname !== "/" && pathname !== "/how-it-works") return null;

  const cerrar = () => setOpen(false);
  const items = [
    { href: "/how-it-works", label: t("howItWorks"), icon: <HowIcon /> },
    { href: "/#measured", label: t("verifier"), icon: <VerifyIcon /> },
    { href: "/#pricing", label: t("pricing"), icon: <ReceiptIcon /> },
  ] as const;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("menu")}
        aria-expanded={open}
        className="nav-burger"
      >
        {open ? <CloseIcon /> : <MenuIcon />}
      </button>

      {open && (
        <div className="nav-mobile">
          <div className="nav-mobile-inner">
            {items.map((it) => (
              <Link key={it.href} href={it.href} onClick={cerrar} className="nav-mobile-item">
                <span className="nav-mobile-tile">{it.icon}</span>
                {it.label}
              </Link>
            ))}
            <a href="https://bivelio.com" onClick={cerrar} className="nav-mobile-item">
              <span className="nav-mobile-tile">
                <GlobeIcon />
              </span>
              <BivelioWordmark className="nav-corp-logo" />
            </a>
            <Link
              href={authed ? "/dashboard" : "/login"}
              onClick={cerrar}
              className="btn btn-primary nav-mobile-cta"
            >
              {authed ? t("dashboard") : t("signIn")}
              <ArrowRightIcon />
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
