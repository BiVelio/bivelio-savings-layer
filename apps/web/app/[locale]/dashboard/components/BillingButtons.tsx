"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { MAX_ASIENTOS, normalizarAsientos } from "@/lib/billing/asientos";
import { NumberInput } from "@/vendor/affectui/number-input";
import { Spinner } from "@/vendor/affectui/spinner-clean";

/**
 * Los 409 del checkout traen un `code`; el texto en inglés que los acompaña es
 * el respaldo para quien llame a la ruta a mano. Aquí se traduce: es la
 * pantalla exacta que ve quien intenta pagar dos veces, en doce idiomas.
 */
const ERRORES_DEL_CHECKOUT: Record<string, string> = {
  codigo_invalido: "accountPlanStrip.errCodigoInvalido",
  ya_suscrito: "accountPlanStrip.errYaSuscrito",
  pago_en_curso: "accountPlanStrip.errPagoEnCurso",
  suscripcion_en_stripe: "accountPlanStrip.errSuscripcionEnStripe",
  plan_cerrado: "accountPlanStrip.errPlanCerrado",
};

/** Enteros sin separador de millares: el mismo texto en Node y en el navegador (hidratación). */
const FORMATO_ASIENTOS: Intl.NumberFormatOptions = { useGrouping: false, maximumFractionDigits: 0 };

/** Lo que el panel VENDE (2026-09-29): Pro y Equipo. La modalidad con comisión está cerrada a clientes nuevos. */
type PlanEnVenta = "pro" | "equipo";

/** Las cifras de los dos planes, ya formateadas en el servidor. */
export interface PreciosDelPanel {
  pro: { monthly: string; yearly: string };
  equipo: { monthly: string; yearly: string; incluidos: number; extraMonthly: string };
}

/**
 * Billing CTAs on the Account card. Users without a plan pick Pro or Team and
 * get monthly/yearly Checkout buttons for it; active subscribers (including
 * those who keep the commission plan) get a Manage-plan button that opens the
 * Stripe Billing Portal. Each posts to the server route and redirects to the
 * hosted Stripe URL it returns.
 */
export function BillingButtons({
  isActive,
  // Ya formateados en el servidor. Este componente NO llama al formateador: la ICU
  // de Node y la del navegador pueden diferir en detalles invisibles, y esa
  // diferencia de texto es la que rompe la hidratación (error #418).
  precios,
  codigo = null,
}: {
  isActive: boolean;
  precios: PreciosDelPanel;
  /** Código de promoción pre-aplicado al pagar (enlace de los probadores). */
  codigo?: string | null;
}) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const [loading, setLoading] = useState<string | null>(null);
  const [err, setErr] = useState("");
  /**
   * ASIENTOS. No existía: los dos botones mandaban solo el periodo, así que
   * TODO checkout arrancaba en 1 aunque la ruta lleva desde el principio
   * aceptando `seats`. El comprador de una empresa se llevaba una licencia de un
   * asiento creyendo que había cubierto a su equipo, y solo podía corregirlo si
   * se acordaba de subir la cantidad en la pantalla alojada de Stripe.
   *
   * Se guarda como TEXTO, no como número: con `number` en el estado, borrar el
   * campo para teclear "12" lo convierte en 0 o NaN a mitad de la edición y el
   * botón parpadea deshabilitado. Se normaliza al enviar.
   */
  const [seats, setSeats] = useState("1");
  const [plan, setPlan] = useState<PlanEnVenta>("pro");
  /**
   * EL PLAN QUE SE ELIGIÓ EN LA PORTADA. «Elegir Equipo» lleva a
   * `/signup?next=/<idioma>/dashboard?plan=equipo`, y ese `next` sobrevive al
   * registro. Sin esto el selector arrancaba siempre en Pro y quien había
   * pulsado Equipo tenía que volver a elegirlo. Se lee en un efecto y no con
   * `useSearchParams()` por lo mismo que en AuthForm: el hook exige un
   * `<Suspense>`. Solo preselecciona: no compra nada ni abre el checkout.
   */
  useEffect(() => {
    const pedido = new URLSearchParams(window.location.search).get("plan");
    if (pedido === "equipo") {
      setPlan("equipo");
      setSeats((s) => String(Math.max(precios.equipo.incluidos, normalizarAsientos(s))));
    }
  }, [precios.equipo.incluidos]);
  // Equipo no baja de los asientos incluidos (el checkout tampoco lo deja): se
  // enseña el número que de verdad se va a comprar.
  const minimo = plan === "equipo" ? precios.equipo.incluidos : 1;
  const asientos = Math.max(minimo, normalizarAsientos(seats));

  async function go(endpoint: string, body: Record<string, unknown>, key: string) {
    setLoading(key);
    setErr("");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, locale, ...(codigo ? { codigo } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string };
      if (!res.ok || !json.url) {
        const clave = json.code ? ERRORES_DEL_CHECKOUT[json.code] : undefined;
        setErr(clave ? t(clave) : json.error || t("accountPlanStrip.checkoutError"));
        setLoading(null);
        return;
      }
      window.location.href = json.url;
    } catch {
      setErr(t("accountPlanStrip.checkoutError"));
      setLoading(null);
    }
  }

  return (
    <div className="billing-cta">
      {isActive ? (
        <div className="acct-manage">
          <p className="acct-manage-t">{t("accountPlanStrip.manageBody")}</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading !== null}
            aria-busy={loading === "portal" || undefined}
            onClick={() => go("/api/stripe/portal", {}, "portal")}
          >
            {loading === "portal" ? <Spinner size={15} /> : null}
            {t("accountPlanStrip.managePlan")}
          </button>
        </div>
      ) : (
        <>
          <h3 className="acct-h">{t("accountPlanStrip.pickTitle")}</h3>
          <div className="acct-pick" role="radiogroup" aria-label={t("accountPlanStrip.planPickLabel")}>
            {(["pro", "equipo"] as const).map((p) => (
              <label key={p} className="acct-opt">
                <input
                  type="radio"
                  name="bv-plan"
                  value={p}
                  checked={plan === p}
                  onChange={() => {
                    setPlan(p);
                    if (p === "equipo") setSeats(String(Math.max(precios.equipo.incluidos, normalizarAsientos(seats))));
                  }}
                />
                <span className="acct-opt-body">
                  <span className="acct-opt-name">
                    {p === "pro" ? t("accountPlanStrip.planPro") : t("accountPlanStrip.planTeam")}
                  </span>
                  <span className="acct-opt-price">
                    {p === "pro"
                      ? t("accountPlanStrip.planProPrice", { monthly: precios.pro.monthly, yearly: precios.pro.yearly })
                      : t("accountPlanStrip.planTeamPrice", {
                          monthly: precios.equipo.monthly,
                          yearly: precios.equipo.yearly,
                          included: precios.equipo.incluidos,
                        })}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {plan === "equipo" ? (
            <p className="ck-note acct-line">
              {t("accountPlanStrip.teamHint", { included: precios.equipo.incluidos, extra: precios.equipo.extraMonthly })}
            </p>
          ) : null}
          {/* LA UNIDAD, JUNTO AL SELECTOR: lo que se compra son máquinas o
              identidades de servicio, no personas. */}
          <div className="acct-qty">
            <label htmlFor="bv-seats" className="acct-qty-label">
              <span className="acct-qty-name">{t("accountPlanStrip.seatsLabel")}</span>
              <span className="acct-unit">{t("accountPlanStrip.seatUnit")}</span>
            </label>
            {/* Number Input de affectUI: − y +, flechas y tecleo libre. Devuelve el
                número ya acotado a [minimo, MAX_ASIENTOS] al salir o al pulsar un
                paso, y aquí se guarda como texto en el mismo estado de siempre. */}
            <NumberInput
              id="bv-seats"
              className="acct-qty-input"
              size="lg"
              locale={locale}
              formatOptions={FORMATO_ASIENTOS}
              min={minimo}
              max={MAX_ASIENTOS}
              step={1}
              value={asientos}
              onValueChange={(v) => setSeats(String(v ?? minimo))}
              stepLabels={{ decrease: t("accountPlanStrip.seatsLess"), increase: t("accountPlanStrip.seatsMore") }}
              aria-describedby="bv-seats-hint"
            />
          </div>
          {/* El aviso, EN EL PUNTO DE COMPRA. Estaba solo en el README, que es
              donde no lo lee quien está decidiendo cuántos asientos paga. */}
          <p id="bv-seats-hint" className="ck-note acct-line">
            {t("accountPlanStrip.seatsHint")}
          </p>
          {codigo ? (
            <p className="ck-note acct-line">
              {t("accountPlanStrip.codigoAplicado", { codigo })}
            </p>
          ) : null}
          {/* EL RESUMEN no multiplica nada: el importe lo calcula y lo enseña
              Stripe antes de pagar. Aquí solo se repite QUÉ se va a comprar. */}
          <div className="acct-summary" role="status">
            <span className="acct-k">{t("accountPlanStrip.summaryLabel")}</span>
            <span className="acct-summary-v">
              {t("accountPlanStrip.summary", {
                plan: plan === "pro" ? t("accountPlanStrip.planPro") : t("accountPlanStrip.planTeam"),
                seats: asientos,
              })}
            </span>
            <span className="acct-summary-n">{t("accountPlanStrip.summaryNote")}</span>
          </div>
          <div className="acct-buy">
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading !== null}
              onClick={() => go("/api/stripe/checkout", { plan, period: "monthly", seats: asientos }, "m")}
            >
              {loading === "m" ? <Spinner size={15} /> : null}
              {plan === "equipo"
                  ? t("accountPlanStrip.checkoutTeamMonthly", { monthly: precios.equipo.monthly, included: precios.equipo.incluidos })
                  : t("accountPlanStrip.checkoutMonthly", { monthly: precios.pro.monthly })}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading !== null}
              onClick={() => go("/api/stripe/checkout", { plan, period: "yearly", seats: asientos }, "y")}
            >
              {loading === "y" ? <Spinner size={15} /> : null}
              {plan === "equipo"
                  ? t("accountPlanStrip.checkoutTeamYearly", { yearly: precios.equipo.yearly, included: precios.equipo.incluidos })
                  : t("accountPlanStrip.checkoutYearly", { yearly: precios.pro.yearly })}
            </button>
          </div>
        </>
      )}
      {err ? (
        <p className="billing-err" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
