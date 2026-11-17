import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import AuthForm from "@/app/components/AuthForm";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { EnlaceConDestino } from "@/app/components/acceso/EnlaceConDestino";
import { Icono } from "@/app/components/acceso/iconos";
import { PanelDeMarca } from "@/app/components/acceso/PanelDeMarca";
import { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";

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
      <AuthForm mode="signup" />
      {/* Estático en el HTML; en el navegador conserva el `next` (el plan
          elegido en la portada o la invitación) al pasar al login. */}
      <p className="auth-alt acc-cruce">
        {t("alreadyHaveAccount")} <EnlaceConDestino a="/login">{t("signIn")}</EnlaceConDestino>
      </p>
      <div className="acc-notas">
        {/* También se puede empezar gratis con Medir: límites y versión mínima
            desde las constantes que aplica la ingesta (lib/license/medir.ts). */}
        <p className="acc-nota">
          {t("signupMedir", {
            seats: LIMITES_MEDIR.asientos,
            requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(locale),
            version: VERSION_MINIMA_MEDIR,
          })}
        </p>
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
