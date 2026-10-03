import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { PageHead } from "@/app/components/app/PageHead";
import { UsageExplorer } from "@/app/[locale]/dashboard/components/UsageExplorer";
import { VerdictHero } from "@/app/[locale]/dashboard/components/VerdictHero";
import { capturaDisponible, filasDiariasDelBanco, filasPorModeloDelBanco, huellaDelPanel, PANEL_DEL_BANCO } from "@/lib/portada/panel-del-banco";

/**
 * LA RUTA DE LA CAPTURA DEL HÉROE — SOLO EN DESARROLLO.
 *
 * Pinta el Resumen del panel con sus componentes de verdad (la cáscara, la
 * cabecera de «Tu ahorro», el titular y el explorador en su vista por
 * modelo), alimentados con las filas
 * de `lib/portada/panel-del-banco.ts`: el flujo GSM8K del banco público, nada
 * más. `scripts/captura-panel.ts` la abre con un navegador y guarda la imagen
 * que la portada enseña.
 *
 * En producción no existe: `notFound()` antes de leer nada. Un build de Vercel
 * la compila, pero cualquier petición a ella devuelve la 404 propia.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function CapturaDelPanel({ params }: { params: Promise<{ locale: string }> }) {
  if (!capturaDisponible()) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");

  const usage = filasDiariasDelBanco();
  const porModelo = filasPorModeloDelBanco();

  return (
    <div className="app" data-huella={huellaDelPanel()}>
      <AppTopbar email="" plan={null} orgName={PANEL_DEL_BANCO.organizacion} />
      <div className="app-body">
        <AppSidebar role="owner" />
        <main className="app-main">
          <div className="app-inner">
            <PageHead eyebrow={t("overview.savingsEyebrow")} title={t("overview.savingsTitle")} />
            <section className="app-section">
              <div className="panel-stack">
                <VerdictHero usage={usage} visibilidad="con_datos" rango={30} />
                <div className="card card-pad">
                  <div className="n card-title">{t("usageExplorer.title")}</div>
                  <UsageExplorer usage={usage} porModelo={porModelo} periodoInicial={30} />
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
