import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { CABECERA_DESTINO } from "@/lib/auth/destino";

/**
 * LA 404 PROPIA DE LA WEB, en los 12 idiomas y dentro del layout del idioma
 * (cabecera, pie y traducciones heredadas). Llegan aquí las URL que atrapa
 * `[...rest]/page.tsx` y cualquier `notFound()` lanzado bajo `[locale]`.
 *
 * `not-found.tsx` no recibe `params`, así que el idioma sale del contexto de
 * la petición: el layout ya ha llamado a `setRequestLocale` antes de que esto
 * se pinte y `getTranslations` lo resuelve solo. Se reutilizan las clases del
 * hero de «Cómo funciona» (`.lp`) para no inventar estilo.
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
 */
export async function generateMetadata() {
  const t = await getTranslations("notFound");
  return { title: t("metaTitle") };
}

/**
 * ¿Se pidió una ruta del panel? Se lee la cabecera con la URL pedida que pone
 * el middleware (lib/auth/destino.ts), no `safeNextPath`: aquí no se redirige
 * a ella, solo se decide un texto. Sin cabecera (rutas con extensión, que el
 * middleware no toca) se asume que no.
 */
async function bajoElPanel(): Promise<boolean> {
  const destino = (await headers()).get(CABECERA_DESTINO) ?? "";
  return /^\/[a-z]{2}\/dashboard(?:\/|$)/.test(destino);
}

export default async function NotFound() {
  const t = await getTranslations("notFound");
  const tp = await getTranslations("dashboard");
  const panel = await bajoElPanel();

  return (
    <div className="lp hiw-page">
      <main className="wrap">
        <section className="hiw-hero">
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1>{panel ? tp("estado.noExisteTitulo") : t("title")}</h1>
          <p className="lede">{panel ? tp("estado.noExisteCuerpo") : t("body")}</p>
          {panel ? (
            <div className="hero-cta">
              <Link href="/dashboard" className="btn">
                {tp("estado.volverAlResumen")}
              </Link>
              <Link href="/" className="btn ghost">
                {t("home")}
              </Link>
            </div>
          ) : (
            <div className="hero-cta">
              <Link href="/" className="btn">
                {t("home")}
              </Link>
            </div>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}
