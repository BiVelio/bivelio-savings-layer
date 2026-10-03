import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { PageHead } from "@/app/components/app/PageHead";
import { UsageExplorer } from "@/app/[locale]/dashboard/components/UsageExplorer";
import { VerdictHero } from "@/app/[locale]/dashboard/components/VerdictHero";
import {
  ahorroPorModeloDelBanco,
  capturaDisponible,
  filasDiariasDelBanco,
  filasPorModeloDelBanco,
  huellaDelPanel,
  pieDelTitular,
  PANEL_DEL_BANCO,
} from "@/lib/portada/panel-del-banco";

/**
 * LA RUTA DE LA CAPTURA DEL HÉROE — SOLO EN DESARROLLO.
 *
 * Pinta el Resumen del panel con sus componentes de verdad (la cáscara, la
 * cabecera, el titular y el explorador en su vista por modelo), alimentados
 * con las filas
 * de `lib/portada/panel-del-banco.ts`: el flujo GSM8K del banco público, nada
 * más. `scripts/captura-panel.ts` la abre con un navegador y guarda la imagen
 * que la portada enseña.
 *
 * LOS RÓTULOS DICEN LO QUE ES: un día del banco en una organización de
 * demostración. Donde el panel de un cliente dice «tu factura», «últimos 30
 * días», «live · tu organización» o enseña el selector de rango, aquí van los
 * `rotulos` de `PANEL_DEL_BANCO` (props que el panel de los clientes nunca
 * pasa). Y en vez de dólares de un banco que gastó céntimos, porcentajes y
 * peticiones: el titular con sus recuentos y el ahorro de cada modelo.
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
  const R = PANEL_DEL_BANCO.rotulos;

  return (
    <div className="app" data-huella={huellaDelPanel()}>
      <AppTopbar email="" plan={null} orgName={PANEL_DEL_BANCO.organizacion} />
      <div className="app-body">
        <AppSidebar role="owner" />
        <main className="app-main">
          <div className="app-inner">
            <PageHead eyebrow={R.antetituloPagina} title={R.tituloPagina} />
            <section className="app-section">
              <div className="panel-stack">
                <VerdictHero
                  usage={usage}
                  visibilidad="con_datos"
                  rango={30}
                  rotulos={{ antetitulo: R.antetitulo, pastilla: R.pastilla, pie: pieDelTitular() }}
                />
                <div className="card card-pad">
                  <div className="n card-title">{t("usageExplorer.title")}</div>
                  <UsageExplorer
                    usage={usage}
                    porModelo={porModelo}
                    periodoInicial={30}
                    presentacion={{
                      vista: "modelo",
                      metrica: "peticiones",
                      sinControles: true,
                      ahorroPorModelo: { titulo: R.columnaAhorro, tituloValor: R.columnaValor, valores: ahorroPorModeloDelBanco() },
                    }}
                  />
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
