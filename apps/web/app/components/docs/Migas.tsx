import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { Breadcrumb } from "@/vendor/affectui/breadcrumb-clean";

/**
 * LAS MIGAS de las páginas de lectura (precios, privacidad, paper, guía de
 * migración): dónde está uno y la vuelta al inicio, con el Breadcrumb de
 * affectUI. Dos niveles reales —el sitio no tiene más profundidad—, así que no
 * se inventa una jerarquía: «Inicio › esta página».
 */
export async function Migas({ actual, lang }: { actual: string; lang?: string }) {
  const t = await getTranslations("nav");
  return (
    <Breadcrumb
      className="doc-migas"
      label={t("breadcrumb")}
      linkAs={Link}
      lang={lang}
      items={[
        {
          label: t("home"),
          href: "/",
          icon: (
            <svg viewBox="0 0 16 16" fill="none" focusable="false">
              <path d="M2.6 7.2 8 2.7l5.4 4.5v5.6a.8.8 0 0 1-.8.8H9.9V9.9H6.1v3.7H3.4a.8.8 0 0 1-.8-.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          ),
        },
        { label: actual },
      ]}
    />
  );
}
