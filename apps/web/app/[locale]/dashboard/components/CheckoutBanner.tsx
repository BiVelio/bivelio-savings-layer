"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";

import { Notice } from "@/app/components/ui";

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
  // Pasados los dos minutos de sondeo el texto CAMBIA: «suele tardar unos
  // segundos» deja de ser verdad y hay que decir qué hacer (y qué NO hacer:
  // volver a comprar).
  const [tardio, setTardio] = useState(false);

  useEffect(() => {
    if (!pendiente) return;
    // Sondeo acotado: cada 4 s durante 2 minutos. Pasado ese tiempo se deja de
    // insistir en vez de refrescar para siempre — si a los 2 minutos no ha
    // llegado, no es un retraso normal del webhook y el texto ya dice qué hacer.
    const t0 = Date.now();
    const id = setInterval(() => {
      if (Date.now() - t0 > 120_000) {
        setTardio(true);
        return clearInterval(id);
      }
      router.refresh();
    }, 4_000);
    return () => clearInterval(id);
  }, [pendiente, router]);

  // CANCELAR EL PAGO NO ES CANCELAR UNA SUSCRIPCIÓN: quien vuelve sin pagar no
  // ha perdido nada de lo que ya tuviera, y se dice para que nadie lo dude.
  if (resultado === "cancelled") {
    return (
      <Notice tono="info" role="status" className="acct-banner">
        <p>{t.rich("checkoutBanner.cancelled", { b: (c) => <b>{c}</b> })}</p>
        <p className="acct-banner-note">{t("checkoutBanner.cancelledNote")}</p>
      </Notice>
    );
  }

  // `?checkout=success` NO PRUEBA EL PAGO: solo dice que Stripe devolvió al
  // cliente aquí. Activo es lo que diga la organización, que confirma el webhook.
  if (pendiente) {
    return (
      <Notice tono={tardio ? "warn" : "info"} role="status" className="acct-banner">
        <p>
          {tardio ? null : <span className="acct-pulse" aria-hidden />}
          {t.rich(tardio ? "checkoutBanner.successLate" : "checkoutBanner.successPending", { b: (c) => <b>{c}</b> })}
        </p>
        {tardio ? null : <p className="acct-banner-note">{t("checkoutBanner.pendingNote")}</p>}
      </Notice>
    );
  }

  return (
    <Notice
      tono="ok"
      role="status"
      className="acct-banner"
      acciones={
        <Link className="btn btn-primary btn-sm" href="./install">
          {t("checkoutBanner.goToInstall")}
        </Link>
      }
    >
      <p>{t.rich("checkoutBanner.successActive", { b: (c) => <b>{c}</b> })}</p>
    </Notice>
  );
}
