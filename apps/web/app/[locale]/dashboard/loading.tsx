import { getTranslations } from "next-intl/server";

/**
 * ESTADO DE CARGA DEL PANEL. Con `dynamic = "force-dynamic"` en el layout,
 * cada navegación esperaba al servidor sin nada en pantalla. Next pinta esto
 * como `fallback` de Suspense mientras llega la página; la cáscara (barra +
 * raíl) sigue montada por el layout y solo se sustituye este interior.
 *
 * Un ESQUELETO con la geometría de lo que llega —cabecera, el titular con su
 * recibo, la fila de cifras con el siguiente paso, el gráfico diario junto al
 * desglose por proveedor y una tarjeta— y no un cartel centrado: lo que se
 * reserva es el sitio de cada bloque, para que la página no salte al llegar.
 */
export default async function DashboardLoading() {
  const t = await getTranslations("dashboard");
  return (
    <div aria-busy="true" role="status" className="app-loading">
      <span className="sr-only">{t("estado.cargando")}</span>
      <div className="app-head">
        <div className="sk" style={{ height: 12, width: 90, marginBottom: 14 }} />
        <div className="sk" style={{ height: 30, width: 260, maxWidth: "70%", marginBottom: 12 }} />
        <div className="sk" style={{ height: 14, width: 380, maxWidth: "100%" }} />
      </div>
      <div className="sk app-loading-hero" />
      <div className="app-loading-row">
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
      </div>
      <div className="app-loading-pulse">
        <div className="sk" />
        <div className="sk" />
      </div>
      <div className="sk app-loading-card" />
    </div>
  );
}
