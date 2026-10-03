import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

/**
 * Lo que dicen los avisos de «actualiza»: desde la 0.5.0 en `latest`,
 * actualizar a la última trae los cambios rompientes de la 0.5 (exports y
 * campos fuera, `finishReason` cerrado, y el CLI que ya no arranca con las
 * variables en español). Antes de mandar a nadie a actualizar, la guía.
 */
export async function AvisoMigrar05() {
  const t = await getTranslations("dashboard.migrar05");
  return (
    <p className="ck-note" style={{ marginTop: 6, marginBottom: 0 }}>
      {t("note")} <Link href="/migrate-to-0.5">{t("link")}</Link>
    </p>
  );
}
