import { getLocale, getTranslations } from "next-intl/server";

import type { OrgContext } from "../data";
import { BillingButtons } from "./BillingButtons";
import { preciosDelPlan } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export async function AccountPlanStrip({
  email,
  ctx,
  // Acaba de pagar y la activación está en curso: se ocultan los botones de
  // compra. Reofrecérselos en ese momento es la vía directa al doble cobro, y la
  // guardia del servidor no lo frena mientras la suscripción está `incomplete`.
  ocultarCompra = false,
}: {
  email: string;
  ctx: OrgContext;
  ocultarCompra?: boolean;
}) {
  const t = await getTranslations("dashboard");
  // El precio se formatea en SERVIDOR y baja como cadena a los botones, que son de
  // cliente. Formatear en los dos lados reabriría el error de hidratación #418: la
  // ICU de Node y la del navegador no siempre coinciden en detalles invisibles.
  const locale = await getLocale();
  const precios = await preciosDelPlan();
  const precioMensual = formatearPrecio(locale, precios.monthly);
  const precioAnual = formatearPrecio(locale, precios.yearly);
  const plan = ctx.org?.plan;
  const isActive = plan === "pro" || plan === "enterprise";
  const planLabel = isActive ? plan.charAt(0).toUpperCase() + plan.slice(1) : t("accountPlanStrip.noActivePlan");
  return (
    <div className="cards" style={{ gridTemplateColumns: "1.4fr 1fr", marginTop: "6px" }}>
      <div className="card">
        <div className="n">{t("accountPlanStrip.signedInAs")}</div>
        <h3 style={{ wordBreak: "break-all" }}>{email}</h3>
        <p>
          {ctx.org ? (
            <>
              {t.rich("accountPlanStrip.organization", {
                b: (chunks) => <b style={{ color: "var(--ink)" }}>{chunks}</b>,
                name: ctx.org.name,
              })}
              {ctx.role ? ` · ${ctx.role}` : ""}
            </>
          ) : (
            <>{t("accountPlanStrip.personalNote")}</>
          )}
        </p>
      </div>
      <div className="card">
        <div className="n">{t("accountPlanStrip.plan")}</div>
        <h3>{planLabel}</h3>
        <p>
          {isActive && ctx.seats != null ? <>{t("accountPlanStrip.seatsCount", { count: ctx.seats })} </> : null}
          {t("accountPlanStrip.planBody", { monthly: precioMensual, yearly: precioAnual })}
        </p>
        {ocultarCompra ? null : (
          <BillingButtons isActive={isActive} monthly={precioMensual} yearly={precioAnual} />
        )}
      </div>
    </div>
  );
}
