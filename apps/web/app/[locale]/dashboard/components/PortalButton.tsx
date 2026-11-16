"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Spinner } from "@/vendor/affectui/spinner-clean";

/**
 * Botón al portal de facturación de Stripe, suelto (sin los CTA de compra).
 *
 * Existe aparte de `BillingButtons` porque el aviso de impago tiene que ofrecer
 * la acción que ARREGLA el problema —actualizar la tarjeta— sin arrastrar los
 * botones de comprar, que en ese momento son justo lo que no hay que pulsar.
 */
export function PortalButton({ label }: { label: string }) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState("");

  async function abrir() {
    setCargando(true);
    setErr("");
    try {
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setErr(json.error || t("accountPlanStrip.checkoutError"));
        setCargando(false);
        return;
      }
      window.location.href = json.url;
    } catch {
      setErr(t("accountPlanStrip.checkoutError"));
      setCargando(false);
    }
  }

  return (
    <div className="billing-cta billing-cta--solo">
      <button type="button" className="btn btn-primary" disabled={cargando} onClick={abrir}>
        {cargando ? <Spinner size={15} /> : null}
        {label}
      </button>
      {err ? (
        <p className="billing-err" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
