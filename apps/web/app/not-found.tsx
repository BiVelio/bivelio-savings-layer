import "./globals.css";

/**
 * 404 RAÍZ, fuera de cualquier idioma. Casi nadie la ve: el middleware manda
 * toda URL sin idioma a `/<idioma>/…`, y allí la atrapa `[locale]/[...rest]`.
 * Queda para lo que el middleware no toca —rutas con extensión (`/foo.png`) y
 * prefijos reservados (`/api/…`, `/auth/…`) que no existen— y, sobre todo,
 * para SUSTITUIR la página por defecto de Next: sin este fichero, Next mete su
 * componente («404: This page could not be found», `<h1 class="next-error-h1">`)
 * como fallback del segmento raíz en el payload de TODAS las páginas.
 *
 * Sin idioma negociado no hay traducciones: español (el idioma por defecto
 * del sitio) con una línea en inglés. Pinta su propio <html>/<body> porque el
 * layout raíz es un paso a través: el <html> vive en el layout del idioma,
 * que aquí no se monta. `<a>` a secas y no el Link de next-intl: no hay
 * idioma que conservar; el middleware lo negocia al llegar a `/`.
 */
export const metadata = { title: "Página no encontrada · BiVelio Savings Layer" };

export default function RootNotFound() {
  return (
    <html lang="es">
      <body>
        <div className="lp hiw-page">
          <main className="wrap">
            <section className="hiw-hero">
              <span className="eyebrow">Error 404</span>
              <h1>Página no encontrada</h1>
              <p className="lede">Esta página no existe o se ha movido. · This page doesn&apos;t exist or has moved.</p>
              <div className="hero-cta">
                <a className="btn" href="/">
                  ← Volver al inicio · Back to home
                </a>
              </div>
            </section>
          </main>
        </div>
      </body>
    </html>
  );
}
