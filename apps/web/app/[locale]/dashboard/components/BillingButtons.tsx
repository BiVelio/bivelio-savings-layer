"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

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

  async function go(endpoint: string, body: Record<string, unknown>, key: string) {
    setLoading(key);
    setErr("");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, locale }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setErr(json.error || t("accountPlanStrip.checkoutError"));
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
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading !== null}
            onClick={() => go("/api/stripe/checkout", { period: "monthly" }, "m")}
          >
            {loading === "m" ? "…" : t("accountPlanStrip.checkoutMonthly", { monthly })}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading !== null}
            onClick={() => go("/api/stripe/checkout", { period: "yearly" }, "y")}
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
