import { useLocale } from "next-intl";

import { Link } from "@/i18n/navigation";

import { AnnouncementBar } from "./AnnouncementBar";
import { elegirVariante, fechaDelLanzamiento, guionPrevio } from "./franja-lanzamiento";
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
  const locale = useLocale();
  // La variante con el reloj del servidor (en páginas estáticas, el del build)
  // y la fecha ya formateada aquí: el cliente hidrata con lo mismo y después
  // se corrige solo con su propio reloj.
  const inicial = elegirVariante(Date.now());
  const guion = guionPrevio(inicial);
  return (
    <>
      {/* Antes de la franja y del primer pintado: si el build es de una ventana
          que ya pasó (páginas sin ISR), corrige lo que se ve con una hoja de
          estilo, sin tocar el DOM. Después de la campaña no se emite. */}
      {guion && <script dangerouslySetInnerHTML={{ __html: guion }} />}
      <AnnouncementBar inicial={inicial} fecha={fechaDelLanzamiento(locale)} />
      <NavShell>
        <div className="site-nav-inner">
          <div className="nav-left">
            <Link href="/" className="nav-brand" aria-label="Savings by BiVelio">
              {/* Cada variante se descarga solo donde se ve: las consultas son
                  las de .nav-logo-full/.nav-logo-mark en globals.css. */}
              <SavingsLogo variant="full" height={30} className="nav-logo-full" ocultoEn="(max-width: 639px)" />
              <SavingsLogo variant="mark" height={28} className="nav-logo-mark" ocultoEn="(min-width: 640px)" />
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
