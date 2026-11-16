import { Link } from "@/i18n/navigation";

import { AnnouncementBar } from "./AnnouncementBar";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { BivelioWordmark } from "./BivelioWordmark";
import { MobileMenu, NavCta, NavSections } from "./NavLinks";
import { NavShell } from "./NavShell";
import { SavingsLogo } from "./SavingsLogo";
import { URL_CORPORATIVA } from "./sitio";

/**
 * Chrome superior de TODAS las superficies públicas (portada, cómo funciona,
 * resultados, precios, privacidad, paper, migración, acceso y 404): la franja
 * de anuncio y una cabecera pegajosa de 56px —la de bivelio.com— con la marca,
 * el MISMO menú completo en cada página (Producto, Cómo funciona, Resultados,
 * Precios, Código), el idioma y un único CTA tinta de acceso contextual. Por
 * debajo de 1024px el menú vive en el panel del hamburguesa, también en todas
 * las páginas. El dashboard tiene su propio shell (topbar + sidebar).
 *
 * SIN LEER COOKIES, A PROPÓSITO (22-09-2026). Esta barra preguntaba a Supabase
 * por el usuario en cada petición, y leer cookies hace dinámica la ruta entera:
 * la portada y las demás páginas públicas se renderizaban en una función en
 * cada visita en vez de servirse estáticas desde el borde. Quién está dentro lo
 * decide ahora el navegador (`useHaySesion`, dentro de NavCta y MobileMenu).
 * `NavShell` solo añade el estado de desplazamiento, que tampoco lee sesión.
 */
export function NavBar() {
  return (
    <>
      <AnnouncementBar />
      <NavShell>
        <div className="site-nav-inner">
          <div className="nav-left">
            <Link href="/" className="nav-brand" aria-label="Savings by BiVelio">
              <SavingsLogo variant="full" height={30} className="nav-logo-full" />
              <SavingsLogo variant="mark" height={28} className="nav-logo-mark" />
            </Link>
            <NavSections />
          </div>
          <div className="nav-actions">
            <LocaleSwitcher />
            {/* Puente al sitio corporativo: el secundario canónico junto al
                primario tinta. Solo en pantallas anchas; por debajo vive
                dentro del menú móvil y en el pie. */}
            <a className="btn btn-ghost nav-corp" href={URL_CORPORATIVA}>
              <BivelioWordmark className="nav-corp-logo" />
            </a>
            <NavCta />
            <MobileMenu />
          </div>
        </div>
      </NavShell>
    </>
  );
}
