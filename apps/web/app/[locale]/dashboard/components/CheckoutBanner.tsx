"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";

/**
 * Acuse de recibo de la vuelta de Stripe.
 *
 * Existía el `?checkout=success` en la `success_url` desde el principio, pero no lo
 * leía NADIE: quien acababa de pagar aterrizaba en una página muda que, mientras el
 * webhook no hubiera llegado, seguía diciendo «Sin plan activo» y le volvía a poner
 * delante los botones de comprar. Con SEPA eso no son segundos: son días. Es el
 * momento exacto en el que alguien que ya ha pagado pide la devolución, o paga dos
 * veces.
 *
 * Mientras la activación está pendiente se refresca solo, para que el cliente no
 * tenga que adivinar cuándo recargar.
 */
export function CheckoutBanner({
  resultado,
  activo,
}: {
  resultado: "success" | "cancelled";
  activo: boolean;
}) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pendiente = resultado === "success" && !activo;

  useEffect(() => {
    if (!pendiente) return;
    // Sondeo acotado: cada 4 s durante 2 minutos. Pasado ese tiempo se deja de
    // insistir en vez de refrescar para siempre — si a los 2 minutos no ha
    // llegado, no es un retraso normal del webhook y el texto ya dice qué hacer.
    const t0 = Date.now();
    const id = setInterval(() => {
      if (Date.now() - t0 > 120_000) return clearInterval(id);
      router.refresh();
    }, 4_000);
    return () => clearInterval(id);
  }, [pendiente, router]);

  if (resultado === "cancelled") {
    return (
      <div className="ck-note" role="status" style={{ marginTop: 10 }}>
        {t.rich("checkoutBanner.cancelled", { b: (c) => <b>{c}</b> })}
      </div>
    );
  }

  return (
    <div className="ck-note" role="status" style={{ marginTop: 10 }}>
      {pendiente ? (
        t.rich("checkoutBanner.successPending", { b: (c) => <b>{c}</b> })
      ) : (
        <>
          {t.rich("checkoutBanner.successActive", { b: (c) => <b>{c}</b> })}{" "}
          <Link href="./install">{t("checkoutBanner.goToInstall")}</Link>
        </>
      )}
    </div>
  );
}
