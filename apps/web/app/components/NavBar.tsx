import { Link } from "@/i18n/navigation";

// Server Component: cliente de SOLO LECTURA. No puede persistir un token
// rotado, asi que tampoco debe provocar la rotacion — ver server.ts.
import { createReadOnlyClient } from "@/lib/supabase/server";
import { AnnouncementBar } from "./AnnouncementBar";
import { BrandMark } from "./BrandMark";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { NavCta, NavSections } from "./NavLinks";

/**
 * Chrome superior de las superficies públicas (landing / login / signup) —
 * mismo montaje que el <SiteNav> de bivelio.com: franja de anuncio negra,
 * cabecera pegajosa de 64px translúcida con blur, marca a la izquierda con sus
 * secciones, y a la derecha el idioma y un único CTA tinta.
 * El dashboard tiene su propio shell (topbar + sidebar).
 */
export async function NavBar() {
  let authed = false;
  try {
    const supabase = await createReadOnlyClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authed = !!user;
  } catch {
    // Auth no resoluble (p. ej. faltan variables) — se pinta el nav de invitado.
  }

  return (
    <>
      <AnnouncementBar />
      <header className="site-nav">
        <div className="site-nav-inner">
          <div className="nav-left">
            <Link href="/" className="nav-brand" aria-label="BiVelio Savings Layer">
              <BrandMark size={28} />
              <span className="tag">Savings Layer</span>
            </Link>
            <NavSections />
          </div>
          <div className="nav-actions">
            <LocaleSwitcher />
            <NavCta authed={authed} />
          </div>
        </div>
      </header>
    </>
  );
}
