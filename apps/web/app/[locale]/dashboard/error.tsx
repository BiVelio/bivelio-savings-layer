"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Link } from "@/i18n/navigation";

/**
 * LA FRONTERA DE ERROR DEL PANEL. Sin esto, un fallo de render bajo
 * /dashboard/* daba la pantalla de error genérica de Next, en inglés y sin
 * salida. Vive DENTRO del layout, así que la cáscara —barra con la cuenta,
 * raíl, idioma, cerrar sesión— sigue ahí: quien lo ve sabe dónde está y puede
 * irse a otra sección. Misma cabecera (`.app-head`, `h1.t-page`) que el resto
 * de pantallas, para que el error no parezca de otro producto.
 *
 * LO QUE NO DICE: el mensaje de la excepción (texto del servidor, puede llevar
 * rutas o nombres de tabla). Sí dice la referencia (`digest`) que Next imprime
 * en su log, que es lo único que soporte puede buscar.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("dashboard");
  useEffect(() => {
    console.error("[dashboard] error de render", error.digest ?? error.message);
  }, [error]);
  return (
    <div className="app-head" role="alert">
      <h1 className="t-page">{t("estado.errorTitulo")}</h1>
      <p className="sub-page">{t("estado.errorCuerpo")}</p>
      {error.digest ? (
        <p className="note">
          <code>{t("estado.referencia", { ref: error.digest })}</code>
        </p>
      ) : null}
      <p className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          {t("estado.reintentar")}
        </button>
        <Link className="btn btn-ghost" href="/dashboard">
          {t("estado.volverAlResumen")}
        </Link>
      </p>
    </div>
  );
}
