"use client";

import { useTranslations } from "next-intl";

/**
 * ESTADO DE CARGA DEL PANEL. Con `dynamic = "force-dynamic"` en el layout,
 * cada navegación esperaba al servidor sin nada en pantalla (CIERRE.md § 2.1).
 * Next pinta esto como `fallback` de Suspense mientras llega la página; es un
 * componente de cliente a propósito: el fallback tiene que renderizar al
 * instante, sin esperar a nada.
 */
export default function DashboardLoading() {
  const t = useTranslations("dashboard");
  return (
    <div className="app-estado" role="status" aria-live="polite" aria-busy="true">
      <p>{t("estado.cargando")}</p>
    </div>
  );
}
