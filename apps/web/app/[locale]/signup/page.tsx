import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import AuthForm from "@/app/components/AuthForm";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { EnlaceConDestino } from "@/app/components/acceso/EnlaceConDestino";
import { Icono } from "@/app/components/acceso/iconos";
import { PanelDeMarca } from "@/app/components/acceso/PanelDeMarca";
import { PlanElegidoEnAlta, SoloSinPlanElegido } from "@/app/components/acceso/PlanElegidoEnAlta";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { LIMITES_MEDIR } from "@/lib/license/medir-publico";
import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";

// Las dos hojas de las páginas de acceso (el marco, la tarjeta, los campos y
// sus piezas de affectUI): la portada no las carga. Ver la cabecera de
// `app/components/acceso/acceso.css`.
import "@/app/components/acceso/acceso.css";
import "@/vendor/affectui/affectui-acceso.css";

// El precio del plan elegido lo lee Stripe con una caché de una hora, como en
// /pricing: la página se regenera con el mismo ritmo (ISR).
export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  // Pantalla de aplicación, no de marketing: fuera del índice.
  return { title: t("signupTitle"), robots: { index: false, follow: false } };
}

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  const tp = await getTranslations("pricingPage");
  // El plan elegido en la portada o en /pricing, con el precio de donde lo lee
  // /pricing. Se pinta en el navegador, y solo si el `next` trae ese plan.
  const planes = terminosDeLosPlanes(locale, await tarifasDeLosPlanes());
  const planElegido = {
    pro: t("signupPlanPro", { plan: tp("plans.pro.name"), price: planes.pro.mensual }),
    equipo: t("signupPlanTeam", { plan: tp("plans.team.name"), price: planes.equipo.mensual, seats: planes.equipo.incluidos }),
  };
  return (
    <AccesoShell
      lateral={<PanelDeMarca locale={locale} />}
      etiquetaLateral={t("panel.receiptMeta")}
      pie={
        <Link href="/" className="acc-volver">
          {t("backToVerifier")}
        </Link>
      }
    >
      <div className="acc-intro">
        <h1>{t("createYourAccount")}</h1>
        <p className="sub">{t("signupSubtitle")}</p>
      </div>
      <PlanElegidoEnAlta textos={planElegido} />
      <AuthForm mode="signup" />
      {/* Estático en el HTML; en el navegador conserva el `next` (el plan
          elegido en la portada o la invitación) al pasar al login. */}
      <p className="auth-alt acc-cruce">
        {t("alreadyHaveAccount")} <EnlaceConDestino a="/login">{t("signIn")}</EnlaceConDestino>
      </p>
      <div className="acc-notas">
        {/* También se puede empezar gratis con Medir: límites desde las
            constantes que aplica la ingesta (lib/license/medir.ts). Quien llega
            con Pro o Team elegido no la ve: ya ha decidido pagar. */}
        <SoloSinPlanElegido>
          <p className="acc-nota">
            {t("signupMedir", {
              seats: LIMITES_MEDIR.asientos,
              requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(locale),
            })}
          </p>
        </SoloSinPlanElegido>
        {/* La identidad es COMPARTIDA con el resto de la suite (Shield, Privacy,
            la app de BiVelio): quien ya tenga cuenta allí no debe crear otra. */}
        <p className="acc-nota">{t("signupSsoNote")}</p>
      </div>
      {/* El motor es open source y no pide cuenta: la salida tiene que verse
          desde aquí, no descubrirse después de registrarse. */}
      <p className="acc-oss">
        <span className="acc-oss-q">{t("openSourceQuestion")}</span>
        <Link href="/#sdk-install" className="acc-oss-a">
          {t("openSourceLink")}
          <Icono nombre="flecha" />
        </Link>
      </p>
    </AccesoShell>
  );
}
