import { getLocale, getTranslations } from "next-intl/server";

import type { OrgContext } from "../data";
import { BillingButtons } from "./BillingButtons";
import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { avisoDeAsientos } from "@/lib/billing/asientos";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export async function AccountPlanStrip({
  email,
  ctx,
  /**
   * Asientos USADOS este mes. `null` = no se ha podido medir (que no es cero).
   * Antes solo se pintaban los PAGADOS, así que ni el cliente podía ver que se
   * estaba pasando ni nosotros enseñárselo — y el dato lo calcula
   * `billable_seats` desde el primer día.
   */
  asientos = { usados: null, rotacionEsteMes: false },
  // Acaba de pagar y la activación está en curso: se ocultan los botones de
  // compra. Reofrecérselos en ese momento es la vía directa al doble cobro, y la
  // guardia del servidor no lo frena mientras la suscripción está `incomplete`.
  ocultarCompra = false,
  codigo = null,
}: {
  email: string;
  ctx: OrgContext;
  asientos?: { usados: number | null; rotacionEsteMes: boolean };
  ocultarCompra?: boolean;
  /** Código de promoción que se pre-aplica al pagar (enlace de los probadores). */
  codigo?: string | null;
}) {
  const t = await getTranslations("dashboard");
  // El precio se formatea en SERVIDOR y baja como cadena a los botones, que son de
  // cliente. Formatear en los dos lados reabriría el error de hidratación #418: la
  // ICU de Node y la del navegador no siempre coinciden en detalles invisibles.
  const locale = await getLocale();
  // Lo que se VENDE es Pro y Equipo (2026-09-29); la modalidad con comisión está
  // cerrada a clientes nuevos. Las cifras, de sus Prices (o del respaldo).
  const tarifas = await tarifasDeLosPlanes();
  const planes = terminosDeLosPlanes(locale, tarifas);
  const incluidos = tarifas.equipo.monthly.asientosIncluidos;
  const plan = ctx.org?.plan;
  const isActive = plan === "pro" || plan === "enterprise";
  const seatsUsados = asientos.usados;
  const aviso = avisoDeAsientos({
    planActivo: isActive,
    usados: seatsUsados,
    pagados: ctx.seats,
    rotacionEsteMes: asientos.rotacionEsteMes,
  });
  const planLabel = isActive
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : ctx.medir === "solo-medir"
      ? t("measurePlan.planLabel")
      : t("accountPlanStrip.noActivePlan");
  return (
    <div className="cards plan" style={{ marginTop: "6px" }}>
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
          {t("accountPlanStrip.planBody", {
            monthly: planes.pro.mensual,
            yearly: planes.pro.anual,
            teamMonthly: planes.equipo.mensual,
            included: incluidos,
          })}
        </p>
        {/* EL IMPUESTO VA APARTE, Y HAY QUE DECIRLO. Los precios son `exclusive`:
            el cliente paga 4 € + IVA. Anunciar "4 €" a secas sin esta línea es
            enseñar un importe que no es el que se cobra. */}
        <p className="ck-note">
          {t("accountPlanStrip.taxNote")}
        </p>
        {/* USADOS vs PAGADOS. Solo si hay plan y hay medida: enseñar "0 en uso" a
            quien acaba de comprar y todavía no ha desplegado nada sería alarmar
            por nada. Y `null` (no se pudo medir) no se pinta como cero. */}
        {/* `seatsUsados != null` se repite aunque `avisoDeAsientos` ya lo
            garantice: el compilador no puede seguir esa garantía a través de la
            variable, y prefiero un booleano de más que un `!` que le dice a TS
            que se calle. */}
        {aviso === "exceso" && seatsUsados != null && ctx.seats != null ? (
          <p className="ck-note" style={{ marginTop: 6, color: "var(--danger)" }}>
            {t("accountPlanStrip.seatsOver", { used: seatsUsados, paid: ctx.seats })}
          </p>
        ) : aviso === "rotado" && seatsUsados != null ? (
          /* Rotó la clave este mes: el recuento está inflado porque el seat_id
             sale de un HMAC con esa clave. Se explica en vez de pedirle dinero. */
          <p className="ck-note" style={{ marginTop: 6 }}>
            {t("accountPlanStrip.seatsRotated", { used: seatsUsados })}
          </p>
        ) : aviso === "en-uso" && seatsUsados != null ? (
          <p className="ck-note" style={{ marginTop: 6 }}>
            {t("accountPlanStrip.seatsInUse", { used: seatsUsados })}
          </p>
        ) : null}
        {ocultarCompra ? null : (
          <BillingButtons
            codigo={codigo}
            isActive={isActive}
            precios={{
              pro: { monthly: planes.pro.mensual, yearly: planes.pro.anual },
              equipo: {
                monthly: planes.equipo.mensual,
                yearly: planes.equipo.anual,
                incluidos,
                extraMonthly: planes.equipo.extraMensual,
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
