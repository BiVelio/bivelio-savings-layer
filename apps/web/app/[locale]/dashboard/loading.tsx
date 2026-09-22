import { getTranslations } from "next-intl/server";

/**
 * ESTADO DE CARGA DEL PANEL. Con `dynamic = "force-dynamic"` en el layout,
 * cada navegación esperaba al servidor sin nada en pantalla. Next pinta esto
 * como `fallback` de Suspense mientras llega la página; la cáscara (barra +
 * raíl) sigue montada por el layout y solo se sustituye este interior.
 *
 * Un ESQUELETO con la geometría de la cabecera y de dos tarjetas —el mismo
 * `loading.tsx` del panel de privacy— y no un cartel centrado: lo que se
 * reserva es el sitio del título, para que la página no salte al llegar.
 */
export default async function DashboardLoading() {
  const t = await getTranslations("dashboard");
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">{t("estado.cargando")}</span>
      <div className="app-head">
        <div className="sk" style={{ height: 12, width: 90, marginBottom: 14 }} />
        <div className="sk" style={{ height: 30, width: 260, marginBottom: 12 }} />
        <div className="sk" style={{ height: 14, width: 380, maxWidth: "100%" }} />
      </div>
      <div className="cards">
        <div className="sk" style={{ height: 132 }} />
        <div className="sk" style={{ height: 132 }} />
      </div>
      <div className="app-section">
        <div className="sk" style={{ height: 180 }} />
      </div>
    </div>
  );
}
