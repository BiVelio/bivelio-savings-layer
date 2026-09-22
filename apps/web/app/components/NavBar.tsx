import { Link } from "@/i18n/navigation";

import { AnnouncementBar } from "./AnnouncementBar";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { BivelioWordmark } from "./BivelioWordmark";
import { MobileMenu, NavCta, NavSections } from "./NavLinks";
import { SavingsLogo } from "./SavingsLogo";

/**
 * Chrome superior de las superficies públicas (landing / login / signup) —
 * mismo montaje que el <SiteNav> de bivelio.com: franja de anuncio negra,
 * cabecera pegajosa de 64px translúcida con blur, el logo oficial de Savings a
 * la izquierda con sus secciones (el logotipo completo en escritorio, solo el
 * isotipo «S» en móvil), y a la derecha el idioma y un único CTA tinta.
 * El dashboard tiene su propio shell (topbar + sidebar).
 *
 * SIN LEER COOKIES, A PROPÓSITO (22-09-2026). Esta barra preguntaba a Supabase
 * por el usuario en cada petición, y `cookies()` hace dinámica la ruta entera:
 * la portada y las demás páginas públicas se renderizaban en una función en
 * cada visita en vez de servirse estáticas desde el borde. Quién está dentro lo
 * decide ahora el navegador (`useHaySesion`, dentro de NavCta y MobileMenu).
 */
export function NavBar() {
  return (
    <>
      <AnnouncementBar />
      <header className="site-nav">
        <div className="site-nav-inner">
          <div className="nav-left">
            <Link href="/" className="nav-brand" aria-label="Savings by BiVelio">
              <SavingsLogo variant="full" height={36} className="nav-logo-full" />
              <SavingsLogo variant="mark" height={32} className="nav-logo-mark" />
            </Link>
            <NavSections />
          </div>
          <div className="nav-actions">
            <LocaleSwitcher />
            {/* Puente al sitio corporativo: el secundario canónico (ghost) junto
                al primario tinta, la misma pareja de botones que usa bivelio.com.
                En <640px vive dentro del menú móvil. */}
            <a className="btn btn-ghost nav-corp" href="https://bivelio.com">
              <BivelioWordmark className="nav-corp-logo" />
            </a>
            <NavCta />
            <MobileMenu />
          </div>
        </div>
      </header>
    </>
  );
}
