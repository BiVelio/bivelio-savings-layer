import { getTranslations } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { SegunRuta } from "@/app/components/SegunRuta";
import { Link } from "@/i18n/navigation";
import { EmptyState } from "@/vendor/affectui/empty-state-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";
import { Separator } from "@/vendor/affectui/separator-clean";
import { TabOverload } from "@/vendor/affectui/tab-overload";

/**
 * LA 404 PROPIA DE LA WEB, en los 12 idiomas y dentro del layout del idioma
 * (cabecera, pie y traducciones heredadas). Llegan aquí las URL que atrapa
 * `[...rest]/page.tsx` y cualquier `notFound()` lanzado bajo `[locale]`.
 *
 * `not-found.tsx` no recibe `params`, así que el idioma sale del contexto de
 * la petición: el layout ya ha llamado a `setRequestLocale` antes de que esto
 * se pinte y `getTranslations` lo resuelve solo.
 *
 * Las URL del panel (`/es/dashboard/lo-que-sea`) también acaban aquí, y a
 * propósito: un `not-found.tsx` dentro de /dashboard no puede dar 404, porque
 * `dashboard/loading.tsx` abre un límite de Suspense y el shell —con su 200—
 * ya se ha enviado cuando la página lanza `notFound()` (Next solo fija el
 * estado cuando el error escapa del shell). Se comprobó con `next start`: el
 * HTML salía con 200 y «Cargando el panel…». Así que el panel no tiene 404
 * propia; esta distingue el caso por la ruta pedida y ofrece la vuelta al
 * resumen. La NavBar pública no se ve bajo /dashboard (SiteNavGate la oculta),
 * de ahí que el botón al panel vaya aquí y no se confíe a la cabecera.
 *
 * SIN `headers()`, DESDE EL 22-09-2026. La distinción por ruta se hacía
 * leyendo la cabecera del middleware, y leer cabeceras en el límite de «no
 * encontrado» hacía DINÁMICO el segmento entero: la portada y las demás
 * páginas públicas perdían el prerender por esta sola llamada (medido con
 * `dynamic = "error"`). Ahora los dos bloques —el del panel y el público— se
 * renderizan aquí con sus textos y `SegunRuta` elige en el navegador cuál se
 * ve, con `usePathname`.
 *
 * LA FORMA (rediseño 2026-11). Corta y de marca: la cifra del error como
 * filigrana, el titular editorial, una frase y la vuelta. La variante pública
 * añade tres destinos reales del menú, con los mismos nombres que en la
 * cabecera (`nav.*`); la del panel, solo la vuelta al resumen y al inicio.
 */
export async function generateMetadata() {
  const t = await getTranslations("notFound");
  return { title: t("metaTitle") };
}

export default async function NotFound() {
  const t = await getTranslations("notFound");
  const tp = await getTranslations("dashboard");
  const tn = await getTranslations("nav");

  return (
    <div className="lp nf-page">
      <main className="wrap nf">
        {/* El Empty State de affectUI a escala de página, con «Tab Overload»
            (tres ventanas, ninguna es la que buscabas) como ilustración, sobre
            la rejilla que deriva despacio. Las dos variantes llevan el mismo
            marco; solo cambian las palabras y las salidas. */}
        <GridBackground className="nf-fondo">
          <SegunRuta
            panel={
              <EmptyState
                className="nf-vacio"
                size="page"
                art={<TabOverload label={t("artAlt")} />}
                eyebrow={t("eyebrow")}
                titleAs="h1"
                title={tp("estado.noExisteTitulo")}
                text={tp("estado.noExisteCuerpo")}
                action={
                  <>
                    <Link href="/dashboard" className="btn btn-primary btn-lg">
                      {tp("estado.volverAlResumen")}
                    </Link>
                    <Link href="/" className="btn btn-ghost btn-lg">
                      {t("home")}
                    </Link>
                  </>
                }
              />
            }
            publico={
              <EmptyState
                className="nf-vacio"
                size="page"
                art={<TabOverload label={t("artAlt")} />}
                eyebrow={t("eyebrow")}
                titleAs="h1"
                title={t("title")}
                text={t("body")}
                action={
                  <Link href="/" className="btn btn-primary btn-lg">
                    {t("home")}
                  </Link>
                }
              >
                <Separator className="nf-regla" />
                <nav className="nf-destinos" aria-label={t("explore")}>
                  <span className="nf-destinos-t">{t("explore")}</span>
                  <Link href="/how-it-works">{tn("howItWorks")}</Link>
                  <Link href="/benchmarks">{tn("results")}</Link>
                  <Link href="/pricing">{tn("pricing")}</Link>
                </nav>
              </EmptyState>
            }
          />
        </GridBackground>
      </main>
      <Footer />
    </div>
  );
}
