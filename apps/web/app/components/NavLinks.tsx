"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

import { BivelioWordmark } from "./BivelioWordmark";
import { URL_CORPORATIVA, URL_DEL_CODIGO } from "./sitio";
import { useHaySesion } from "./useHaySesion";

import {
  ArrowRightIcon,
  CloseIcon,
  DashboardIcon,
  GitHubIcon,
  GlobeIcon,
  HowIcon,
  MenuIcon,
  ProofIcon,
  ReceiptIcon,
} from "./icons";

/** ¿Está el visitante en el documento al que lleva este destino? */
function activo(pathname: string, ruta: string): boolean {
  if (ruta === "/") return pathname === "/";
  return pathname === ruta || pathname.startsWith(`${ruta}/`);
}

/** Flecha «sale del sitio», 10px, junto a la etiqueta de un enlace externo. */
function FlechaExterna() {
  return (
    <svg className="nav-ext" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
    </svg>
  );
}

/**
 * El menú principal, IGUAL en todas las páginas públicas (guía §6, fila 1):
 * Producto, Cómo funciona, Resultados, Precios y Código. «Precios» lleva al
 * documento completo (/pricing), no al resumen de la portada. «Código» sale a
 * GitHub. El destino activo se marca con `aria-current` (y un filete azul).
 */
export function NavSections() {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <nav className="nav-menu" aria-label={t("mainAria")}>
      <Link className="nav-link" href="/#offers" aria-current={activo(pathname, "/") ? "page" : undefined}>
        {t("product")}
      </Link>
      <Link className="nav-link" href="/how-it-works" aria-current={activo(pathname, "/how-it-works") ? "page" : undefined}>
        {t("howItWorks")}
      </Link>
      <Link className="nav-link" href="/benchmarks" aria-current={activo(pathname, "/benchmarks") ? "page" : undefined}>
        {t("results")}
      </Link>
      <Link className="nav-link" href="/pricing" aria-current={activo(pathname, "/pricing") ? "page" : undefined}>
        {t("pricing")}
      </Link>
      <a className="nav-link" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
        {t("code")}
        <FlechaExterna />
        <span className="sr-only">{t("newTab")}</span>
      </a>
    </nav>
  );
}

/**
 * El CTA persistente: un solo botón tinta, como el del nav corporativo.
 * "Dashboard" si ya hay sesión, "Sign in" si no. Oculto en las propias
 * pantallas de login / signup, que ya son ese destino. La sesión la mira el
 * NAVEGADOR (`useHaySesion`), no el servidor: es lo que deja la portada
 * estática.
 */
export function NavCta() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const authed = useHaySesion();
  if (pathname === "/login" || pathname === "/signup") return null;

  return (
    <Link className="btn btn-primary nav-cta" href={authed ? "/dashboard" : "/login"}>
      {authed ? t("dashboard") : t("signIn")}
      <ArrowRightIcon />
    </Link>
  );
}

/**
 * Menú móvil: disparador en la cabecera y panel a todo el ancho con TODOS los
 * destinos del menú principal como filas de tesela, el enlace a bivelio.com y
 * el CTA tinta al pie. Presente en todas las páginas públicas por debajo de
 * 1024px. Se cierra con Escape, al elegir destino y al cambiar de ruta.
 */
export function MobileMenu() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const authed = useHaySesion();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Al navegar (también con atrás/adelante) el panel no debe quedarse abierto.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [open]);

  const cerrar = () => setOpen(false);
  const enAcceso = pathname === "/login" || pathname === "/signup";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("menu")}
        aria-expanded={open}
        aria-controls={panelId}
        className="nav-burger"
      >
        {open ? <CloseIcon /> : <MenuIcon />}
      </button>

      {open && (
        <div className="nav-mobile" id={panelId}>
          <nav className="nav-mobile-inner" aria-label={t("mainAria")}>
            <Link href="/#offers" onClick={cerrar} className="nav-mobile-item" aria-current={activo(pathname, "/") ? "page" : undefined}>
              <span className="nav-mobile-tile">
                <DashboardIcon />
              </span>
              {t("product")}
            </Link>
            <Link href="/how-it-works" onClick={cerrar} className="nav-mobile-item" aria-current={activo(pathname, "/how-it-works") ? "page" : undefined}>
              <span className="nav-mobile-tile">
                <HowIcon />
              </span>
              {t("howItWorks")}
            </Link>
            <Link href="/benchmarks" onClick={cerrar} className="nav-mobile-item" aria-current={activo(pathname, "/benchmarks") ? "page" : undefined}>
              <span className="nav-mobile-tile">
                <ProofIcon />
              </span>
              {t("results")}
            </Link>
            <Link href="/pricing" onClick={cerrar} className="nav-mobile-item" aria-current={activo(pathname, "/pricing") ? "page" : undefined}>
              <span className="nav-mobile-tile">
                <ReceiptIcon />
              </span>
              {t("pricing")}
            </Link>
            <a href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer" onClick={cerrar} className="nav-mobile-item">
              <span className="nav-mobile-tile">
                <GitHubIcon />
              </span>
              {t("code")}
              <FlechaExterna />
              <span className="sr-only">{t("newTab")}</span>
            </a>
            <a href={URL_CORPORATIVA} onClick={cerrar} className="nav-mobile-item nav-mobile-corp">
              <span className="nav-mobile-tile">
                <GlobeIcon />
              </span>
              <BivelioWordmark className="nav-corp-logo" />
            </a>
            {!enAcceso && (
              <Link href={authed ? "/dashboard" : "/login"} onClick={cerrar} className="btn btn-primary nav-mobile-cta">
                {authed ? t("dashboard") : t("signIn")}
                <ArrowRightIcon />
              </Link>
            )}
          </nav>
        </div>
      )}
    </>
  );
}
