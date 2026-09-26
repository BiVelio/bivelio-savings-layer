import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { RANGOS, RANGO_POR_DEFECTO, type Rango } from "../rango";

/**
 * Selector del rango del panel. Son ENLACES, no botones: el rango es parte de
 * la dirección (`/dashboard?range=30`), así que se comparte, se recarga y lo
 * aplica el servidor antes de derivar el veredicto. Componente de servidor:
 * conoce el activo por props y no necesita `useSearchParams` (que obligaría a
 * un límite de Suspense en toda la página).
 *
 * `base` es la página a la que apuntan los enlaces (por defecto el Resumen):
 * «Tu banco» usa el mismo selector sobre `/dashboard/your-bench`.
 */
export async function RangeSwitch({ activo, base = "/dashboard" }: { activo: Rango; base?: string }) {
  const t = await getTranslations("dashboard");
  return (
    <nav className="seg live" aria-label={t("verdictHero.rangeLabel")}>
      {RANGOS.map((r) => (
        <Link
          key={r}
          href={r === RANGO_POR_DEFECTO ? base : `${base}?range=${r}`}
          scroll={false}
          aria-current={r === activo ? "true" : undefined}
        >
          {t("verdictHero.rangeOption", { n: r })}
        </Link>
      ))}
    </nav>
  );
}
