import { getTranslations } from "next-intl/server";
import { loadDashboard } from "../load";
import { AccountPlanStrip } from "../components/AccountPlanStrip";
import { BillingStateBanner } from "../components/BillingStateBanner";
import { CheckoutBanner } from "../components/CheckoutBanner";
import { EquipoPanel } from "../components/EquipoPanel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("account.metaTitle") };
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; codigo?: string }>;
}) {
  const t = await getTranslations("dashboard");
  const { user, ctx, asientos } = await loadDashboard();
  // `checkout.session.create` manda a esta página con `?checkout=success` o
  // `?checkout=cancelled` desde el principio, y hasta ahora no lo leía nadie.
  const { checkout, codigo: codigoPedido } = await searchParams;
  const resultado = checkout === "success" || checkout === "cancelled" ? checkout : null;
  // El enlace de los probadores: `?codigo=PROBADORES-SEPT`. Se valida aquí solo
  // por forma; el servidor del checkout lo resuelve contra Stripe.
  const codigo = typeof codigoPedido === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(codigoPedido) ? codigoPedido.toUpperCase() : null;
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
      {/* El estado real del cobro, ANTES de la tarjeta del plan: si la tarjeta
          no pasa, eso es lo primero que hay que leer, no el precio. */}
      <BillingStateBanner ctx={ctx} />
      <AccountPlanStrip
        email={user?.email ?? "you@bivelio.com"}
        ctx={ctx}
        asientos={asientos}
        ocultarCompra={activacionPendiente}
        codigo={codigo}
      />
      {/* El equipo va DESPUÉS del plan: quien entra aquí viene casi siempre a
          mirar lo que paga. Y se pinta solo si el servidor deja verlo — a un
          `member` le devuelve 403 y el panel entero desaparece. */}
      <EquipoPanel />
    </>
  );
}
