import { getTranslations } from "next-intl/server";

import { AccountTabs } from "@/app/components/app/AccountTabs";
import { PageHead } from "@/app/components/app/PageHead";
import { loadDashboard } from "../load";
import { AccountPlanStrip } from "../components/AccountPlanStrip";
import { BillingStateBanner } from "../components/BillingStateBanner";
import { CheckoutBanner } from "../components/CheckoutBanner";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("account.metaTitle") };
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const t = await getTranslations("dashboard");
  const { user, ctx, asientos } = await loadDashboard();
  // `checkout.session.create` manda a esta página con `?checkout=success` o
  // `?checkout=cancelled` desde el principio, y hasta ahora no lo leía nadie.
  const { checkout } = await searchParams;
  const resultado = checkout === "success" || checkout === "cancelled" ? checkout : null;
  const plan = ctx.org?.plan;
  const activo = plan === "pro" || plan === "enterprise";
  // Ha pagado y el webhook aún no ha aterrizado: NO se le vuelven a ofrecer los
  // botones de compra, que es como se acababa pagando dos veces.
  const activacionPendiente = resultado === "success" && !activo;
  return (
    <>
      <AccountTabs role={ctx.role} />
      <PageHead eyebrow={t("account.eyebrow")} title={t("account.title")} sub={t("account.intro")} />
      {resultado ? <CheckoutBanner resultado={resultado} activo={activo} /> : null}
      {/* El estado real del cobro, ANTES de la tarjeta del plan: si la tarjeta
          no pasa, eso es lo primero que hay que leer, no el precio. */}
      <BillingStateBanner ctx={ctx} />
      <AccountPlanStrip
        email={user?.email ?? "you@bivelio.com"}
        ctx={ctx}
        asientos={asientos}
        ocultarCompra={activacionPendiente}
      />
      {/* El equipo tiene página propia desde el 22-09 (/dashboard/team, en la
          pestaña de arriba y en el raíl): aquí se queda lo que se paga. */}
    </>
  );
}
