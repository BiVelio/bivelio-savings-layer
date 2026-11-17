import { getTranslations } from "next-intl/server";

import { Notice } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { PLANES_EN_VENTA } from "@/lib/billing/planes";
import { puede } from "@/lib/org/permisos";

/** El plan de `?plan=`, solo si es uno de los que se venden; cualquier otra cosa es `null`. */
export function planElegidoDe(pedido: string | string[] | undefined): "pro" | "equipo" | null {
  return typeof pedido === "string" && (PLANES_EN_VENTA as readonly string[]).includes(pedido)
    ? (pedido as "pro" | "equipo")
    : null;
}

/**
 * Los estados de suscripción con los que el checkout se NIEGA a abrir otra
 * compra (`ESTADOS_QUE_BLOQUEAN` en app/api/stripe/checkout/route.ts). Copia a
 * propósito: la ruta es de facturación y no exporta la suya.
 */
const ESTADOS_CON_COMPRA_HECHA: readonly string[] = ["active", "trialing", "past_due", "incomplete"];

/**
 * ¿SOBRA EL AVISO DEL PLAN ELEGIDO? Sobra con un plan ya activo y TAMBIÉN con
 * una suscripción viva o en curso. Un adeudo SEPA deja la suscripción en
 * `incomplete` y la organización en `free` durante días: decir ahí «todavía no
 * se ha comprado nada» es falso y contradice al aviso de pago en proceso.
 */
export function sobraElPlanElegido(ctx: {
  org: { plan: string } | null;
  subscription: { status: string } | null;
}): boolean {
  const yaConPlan = ctx.org?.plan === "pro" || ctx.org?.plan === "enterprise";
  return yaConPlan || (ctx.subscription != null && ESTADOS_CON_COMPRA_HECHA.includes(ctx.subscription.status));
}

/**
 * EL PLAN QUE SE ELIGIÓ EN LA PORTADA, RECOGIDO EN EL RESUMEN.
 *
 * «Elegir Team» lleva a `/signup?next=/<idioma>/dashboard?plan=equipo` (contrato
 * fijado por plan-elegido.test) y el Resumen no tiene selector: quien lee
 * `?plan=` es el de Cuenta. Sin este aviso el plan se perdía por el camino y
 * quien eligió Team acababa ante un selector que arranca en Pro.
 *
 * Solo ENLAZA a `/dashboard/account?plan=…`: no compra nada ni abre el
 * checkout. A quien no puede comprar (lib/org/permisos) se le dice a quién
 * pedírselo. Rol desconocido (`null`): se le deja el enlace — decide el servidor.
 */
export async function PlanElegidoNotice({ plan, role }: { plan: "pro" | "equipo"; role: string | null }) {
  const t = await getTranslations("dashboard");
  const puedeComprar = role == null || puede(role, "comprar");
  return (
    <Notice
      tono="info"
      role="status"
      titulo={t("overview.planChosen.title", {
        plan: plan === "equipo" ? t("accountPlanStrip.planTeam") : t("accountPlanStrip.planPro"),
      })}
      acciones={
        puedeComprar ? (
          <Link className="btn btn-primary btn-sm" href={{ pathname: "/dashboard/account", query: { plan } }}>
            {t("overview.planChosen.cta")}
          </Link>
        ) : undefined
      }
    >
      {puedeComprar ? t("overview.planChosen.body") : t("overview.planChosen.askOwner")}
    </Notice>
  );
}
