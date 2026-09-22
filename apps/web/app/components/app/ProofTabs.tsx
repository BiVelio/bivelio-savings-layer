import { getTranslations } from "next-intl/server";

import { SectionTabs } from "./SectionTabs";

/**
 * Prueba · Verificar. «Verificar» salió del raíl el 02-09 pero su página
 * sigue existiendo; como pestaña de Prueba vuelve a poder descubrirse sin
 * costar una entrada del menú.
 */
export async function ProofTabs() {
  const nav = await getTranslations("app.sidebar");
  return (
    <SectionTabs
      tabs={[
        { href: "/dashboard/proof", label: nav("proof") },
        { href: "/dashboard/verify", label: nav("verify") },
      ]}
    />
  );
}
