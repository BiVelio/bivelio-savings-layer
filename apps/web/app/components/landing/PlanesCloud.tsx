import type { ComponentProps, ReactNode } from "react";

import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { MAX_ASIENTOS } from "@/lib/billing/asientos";
import type { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";
import { PricingPlans, type PricingPlan } from "@/vendor/affectui/pricing-plans";

/**
 * LOS CUATRO PLANES DE SAVINGS CLOUD, COMPARABLES DE UN VISTAZO — Measure, Pro,
 * Team y Enterprise sobre el bloque «Pricing Plans» de affectUI (vendorizado y
 * adaptado en vendor/affectui/pricing-plans). Lo usan la portada (#pricing) y
 * la página de precios publicados (/pricing#plans), con las mismas etiquetas
 * (`pricingPage.cards.*`).
 *
 * NI UNA CIFRA ESCRITA AQUÍ:
 *  · los importes llegan ya formateados de `terminosDeLosPlanes(locale, await
 *    tarifasDeLosPlanes())`, que es lo que lee el cobro;
 *  · los límites de Measure, de `LIMITES_MEDIR` (los pasa la página); la
 *    versión mínima del paquete queda en las condiciones de /pricing#medir, y
 *    la tarjeta dice «la última versión», que no caduca;
 *  · el tope del pago en línea, de `MAX_ASIENTOS`.
 * El precio anual se enseña como lo que es —el cargo anual— con su periodo: la
 * fuente no publica un «equivalente mensual», así que no se divide nada.
 *
 * Los destinos de compra son los de siempre y los decide la página (alta →
 * `next=/{locale}/dashboard?plan=…` → selector del panel → Stripe): aquí no hay
 * checkout. Community NO es una de estas tarjetas: es el motor, y se explica
 * fuera.
 */
type Destino = ComponentProps<typeof Link>["href"];

export async function PlanesCloud({
  planes,
  medir,
  nombres,
  destinos,
  enPrecios = false,
  grupo,
}: {
  planes: ReturnType<typeof terminosDeLosPlanes>;
  /** Límites de Measure, ya en el idioma de la página. */
  medir: { seats: number; requests: string };
  nombres: { medir: string; pro: string; team: string; enterprise: string };
  /** Los destinos de alta de Pro y Team (el contrato `signup?next=`), que fija la página. */
  destinos: { pro: Destino; team: Destino };
  /** En /pricing las condiciones de cada plan están en la misma página. */
  enPrecios?: boolean;
  /** `name` del selector de periodo (único por página). */
  grupo: string;
}) {
  const c = await getTranslations("pricingPage.cards");

  const condiciones = (ancla: string, extra?: ReactNode) => (
    <>
      {extra}
      {enPrecios ? (
        <a className="plan-terms" href={`#${ancla}`}>
          {c("terms")}
        </a>
      ) : (
        <Link className="plan-terms" href={`/pricing#${ancla}`}>
          {c("terms")}
        </Link>
      )}
    </>
  );
  const sinComision = { label: c("commission"), value: c("none") };

  const lista: PricingPlan[] = [
    {
      id: "medir",
      name: nombres.medir,
      price: { amount: c("free"), per: c("noCard") },
      unit: c("medir.unit"),
      // Desde qué versión ahorra Measure (las anteriores solo observan), por parámetro.
      summary: c("medir.summary", { saves: VERSION_MEDIR_AHORRA }),
      limits: [
        { label: c("seats"), value: c("upTo", { n: medir.seats }) },
        { label: c("requestsDay"), value: c("upTo", { n: medir.requests }) },
        sinComision,
      ],
      action: (
        <Link className="btn ghost btn-block" href="/signup">
          {c("medir.cta")}
        </Link>
      ),
      footer: condiciones("medir", <span className="plan-nota">{c("medir.version")}</span>),
    },
    {
      id: "pro",
      name: nombres.pro,
      featured: true,
      price: {
        monthly: { amount: planes.pro.mensual, per: c("perSeatMonth"), charge: c("chargeMonthly") },
        yearly: { amount: planes.pro.anual, per: c("perSeatYear"), charge: c("chargeYearly") },
      },
      unit: c("unitSeat"),
      summary: c("pro.summary"),
      limits: [{ label: c("seats"), value: c("seatsChosen") }, sinComision],
      action: (
        <Link className="btn btn-block" href={destinos.pro}>
          {c("pro.cta")}
        </Link>
      ),
      footer: condiciones("pro"),
    },
    {
      id: "team",
      name: nombres.team,
      price: {
        monthly: { amount: planes.equipo.mensual, per: c("perMonth"), charge: c("chargeMonthly") },
        yearly: { amount: planes.equipo.anual, per: c("perYear"), charge: c("chargeYearly") },
      },
      unit: c("team.unit", { included: planes.equipo.incluidos }),
      summary: c("team.summary"),
      limits: [
        { label: c("included"), value: planes.equipo.incluidos },
        {
          label: c("extraSeat"),
          value: {
            monthly: c("amountMonthly", { amount: planes.equipo.extraMensual }),
            yearly: c("amountYearly", { amount: planes.equipo.extraAnual }),
          },
        },
        sinComision,
      ],
      action: (
        <Link className="btn ghost btn-block" href={destinos.team}>
          {c("team.cta")}
        </Link>
      ),
      footer: condiciones("team"),
    },
    {
      id: "enterprise",
      name: nombres.enterprise,
      price: { amount: c("custom"), per: c("byContract") },
      unit: c("enterprise.unit"),
      summary: c("enterprise.summary"),
      limits: [{ label: c("seats"), value: c("moreThan", { n: MAX_ASIENTOS }) }],
      action: (
        <a className="btn ghost btn-block" href="mailto:support@bivelio.com">
          {c("enterprise.cta")}
        </a>
      ),
      footer: condiciones("enterprise"),
    },
  ];

  return (
    <div className="planes-cloud">
      <PricingPlans
        plans={lista}
        name={grupo}
        ariaLabel={c("listLabel")}
        labels={{ period: c("period"), monthly: c("monthly"), yearly: c("yearly") }}
      />
      <p className="planes-nota">{c("provider")}</p>
    </div>
  );
}
