"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * ESTADO DE ERROR DEL PANEL. Sin esto, un fallo de render bajo /dashboard/*
 * daba la pantalla de error genérica de Next, en inglés y sin salida
 * (CIERRE.md § 2.1). Aquí se dice qué ha pasado, que los datos no corren
 * peligro, y a quién escribir; el botón reintenta el render del segmento.
 *
 * El error llega ya registrado en el servidor (Next lo vuelca en el log de la
 * función); aquí solo se deja el `digest` para poder casarlo con esa línea.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("dashboard");
  useEffect(() => {
    console.error("[dashboard] error de render", error.digest ?? error.message);
  }, [error]);
  return (
    <div className="app-estado" role="alert">
      <p className="app-estado-titulo">{t("estado.errorTitulo")}</p>
      <p>{t("estado.errorCuerpo")}</p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        {t("estado.reintentar")}
      </button>
    </div>
  );
}
