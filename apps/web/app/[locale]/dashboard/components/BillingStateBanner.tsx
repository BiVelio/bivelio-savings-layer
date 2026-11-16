import { getLocale, getTranslations } from "next-intl/server";

import { decidirAviso } from "@/lib/billing/aviso";

import { Notice } from "@/app/components/ui";

import type { OrgContext } from "../data";
import { PortalButton } from "./PortalButton";

/**
 * El aviso de que el dinero va mal, en la primera pantalla del panel.
 *
 * Antes no existía nada parecido: un `past_due` se pintaba como "Pro" con toda
 * normalidad porque el webhook mapea ese estado a plan pro, y el cliente se
 * enteraba cuando el SDK se le paraba semanas después. La decisión de QUÉ avisar
 * vive en `lib/billing/aviso.ts` (función pura, con tests); aquí solo se pinta.
 *
 * Se renderiza NULL cuando todo está en orden, a propósito: un panel que grita
 * sin motivo enseña a ignorarlo, y entonces no sirve el día que sí pasa algo.
 */
export async function BillingStateBanner({ ctx }: { ctx: OrgContext }) {
  const aviso = decidirAviso({
    subscription: ctx.subscription,
    license: ctx.license,
    nowMs: Date.now(),
  });
  if (!aviso) return null;

  const t = await getTranslations("dashboard.billingState");
  const locale = await getLocale();
  // La fecha se formatea en SERVIDOR y baja ya como cadena, igual que el precio:
  // formatear en los dos lados reabre el error de hidratación #418, porque la ICU
  // de Node y la del navegador no coinciden en todos los detalles.
  const fecha = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));

  // `urgente` = el servicio ya está cortado o a punto. Cambia el color, no el texto.
  const urgente = aviso.tipo === "pastDueEnded" || aviso.tipo === "expired" || aviso.tipo === "revoked";

  let titulo: string;
  let cuerpo: string;
  let conPortal = false;

  switch (aviso.tipo) {
    case "pastDue":
      titulo = t("pastDueTitle");
      // Sin sello de inicio no hay cifra que enseñar — pasa cuando la fila llegó
      // a `past_due` por `customer.subscription.updated`, que no sella
      // `past_due_since`. El aviso sirve igual: lo accionable es «tu tarjeta no
      // pasa», no cuántos días quedan. Lo que NO se puede decir ahí es que la
      // gracia ha terminado, porque no se sabe.
      cuerpo = aviso.dias === null ? t("pastDueNoCount") : t("pastDueBody", { days: aviso.dias });
      conPortal = true;
      break;
    case "pastDueEnded":
      titulo = t("pastDueTitle");
      cuerpo = t("pastDueEnded");
      conPortal = true;
      break;
    case "incomplete":
      titulo = t("incompleteTitle");
      cuerpo = t("incompleteBody");
      break;
    case "grace":
      titulo = t("graceTitle");
      cuerpo = t("graceBody", { days: aviso.dias, date: fecha(aviso.expiresAt) });
      conPortal = true;
      break;
    case "expired":
      titulo = t("expiredTitle");
      cuerpo = t("expiredBody", { date: fecha(aviso.expiresAt) });
      conPortal = true;
      break;
    case "revoked":
      titulo = t("revokedTitle");
      cuerpo = t("revokedBody");
      break;
  }

  // El tono lo dicen el icono y el título, no solo el color: `danger` cuando el
  // servicio ya está cortado o a punto; `warn` mientras aún funciona.
  return (
    <Notice
      tono={urgente ? "danger" : "warn"}
      role="status"
      titulo={titulo}
      className="acct-banner"
      acciones={conPortal ? <PortalButton label={t("pastDueAction")} /> : undefined}
    >
      {cuerpo}
    </Notice>
  );
}
