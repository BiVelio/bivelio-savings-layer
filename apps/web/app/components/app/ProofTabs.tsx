import { getTranslations } from "next-intl/server";

import { SectionTabs } from "./SectionTabs";

/**
 * Prueba · Tu banco · Verificar. «Verificar» salió del raíl el 02-09 pero su
 * página sigue existiendo; como pestaña de Prueba vuelve a poder descubrirse sin
 * costar una entrada del menú. «Tu banco» (2026-09-25) es el A/B opcional sobre
 * el tráfico del propio cliente: la prueba publicada corre nuestros escenarios,
 * ésta los suyos.
 */
export async function ProofTabs() {
  const nav = await getTranslations("app.sidebar");
  return (
    <SectionTabs
      tabs={[
        { href: "/dashboard/proof", label: nav("proof") },
        { href: "/dashboard/your-bench", label: nav("yourBench") },
        { href: "/dashboard/verify", label: nav("verify") },
      ]}
    />
  );
}
