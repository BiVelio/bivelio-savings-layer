import { getTranslations } from "next-intl/server";
import { loadDashboard } from "../load";
import { AccountPlanStrip } from "../components/AccountPlanStrip";
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
  const { user, ctx } = await loadDashboard();
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
      <div className="app-head">
        <p className="ck-eyebrow">{t("account.eyebrow")}</p>
        <h1>{t("account.title")}</h1>
        <p>{t("account.intro")}</p>
      </div>
      {resultado ? <CheckoutBanner resultado={resultado} activo={activo} /> : null}
      <AccountPlanStrip
        email={user?.email ?? "you@bivelio.com"}
        ctx={ctx}
        ocultarCompra={activacionPendiente}
      />
    </>
  );
}
