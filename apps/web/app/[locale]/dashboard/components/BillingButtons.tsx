"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { MAX_ASIENTOS, normalizarAsientos } from "@/lib/billing/asientos";

/**
 * Los 409 del checkout traen un `code`; el texto en inglés que los acompaña es
 * el respaldo para quien llame a la ruta a mano. Aquí se traduce: es la
 * pantalla exacta que ve quien intenta pagar dos veces, en doce idiomas.
 */
const ERRORES_DEL_CHECKOUT: Record<string, string> = {
  ya_suscrito: "accountPlanStrip.errYaSuscrito",
  pago_en_curso: "accountPlanStrip.errPagoEnCurso",
  suscripcion_en_stripe: "accountPlanStrip.errSuscripcionEnStripe",
};

/**
 * Billing CTAs on the Account card. Signed-out-of-plan users get monthly/yearly
 * Checkout buttons; active subscribers get a Manage-plan button that opens the
 * Stripe Billing Portal. Each posts to the server route and redirects to the
 * hosted Stripe URL it returns.
 */
export function BillingButtons({
  isActive,
  // Ya formateados en el servidor. Este componente NO llama al formateador: la ICU
  // de Node y la del navegador pueden diferir en detalles invisibles, y esa
  // diferencia de texto es la que rompe la hidratación (error #418).
  monthly,
  yearly,
}: {
  isActive: boolean;
  monthly: string;
  yearly: string;
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
  const asientos = normalizarAsientos(seats);

  async function go(endpoint: string, body: Record<string, unknown>, key: string) {
    setLoading(key);
    setErr("");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, locale }),
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
    <span className="billing-cta">
      {isActive ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loading !== null}
          onClick={() => go("/api/stripe/portal", {}, "portal")}
        >
          {loading === "portal" ? "…" : t("accountPlanStrip.managePlan")}
        </button>
      ) : (
        <>
          <span className="seatpick">
            <label htmlFor="bv-seats">{t("accountPlanStrip.seatsLabel")}</label>
            <input
              id="bv-seats"
              className="kt-input"
              type="number"
              min={1}
              max={MAX_ASIENTOS}
              step={1}
              inputMode="numeric"
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
              onBlur={() => setSeats(String(asientos))}
              style={{ width: "5.5rem" }}
              aria-describedby="bv-seats-hint"
            />
          </span>
          {/* El aviso, EN EL PUNTO DE COMPRA. Estaba solo en el README, que es
              donde no lo lee quien está decidiendo cuántos asientos paga. */}
          <p id="bv-seats-hint" className="ck-note" style={{ margin: "4px 0 8px", width: "100%" }}>
            {t("accountPlanStrip.seatsHint")}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading !== null}
            onClick={() => go("/api/stripe/checkout", { period: "monthly", seats: asientos }, "m")}
          >
            {loading === "m" ? "…" : t("accountPlanStrip.checkoutMonthly", { monthly })}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading !== null}
            onClick={() => go("/api/stripe/checkout", { period: "yearly", seats: asientos }, "y")}
          >
            {loading === "y" ? "…" : t("accountPlanStrip.checkoutYearly", { yearly })}
          </button>
        </>
      )}
      {err ? (
        <span className="billing-err" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}
