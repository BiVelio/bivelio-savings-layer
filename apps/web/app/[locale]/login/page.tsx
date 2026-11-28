import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import AuthForm from "@/app/components/AuthForm";
import { MensajeDeAcceso } from "@/app/components/acceso/AccesoEstado";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { EnlaceConDestino } from "@/app/components/acceso/EnlaceConDestino";
import { PanelDeMarca } from "@/app/components/acceso/PanelDeMarca";
import { cuentaCompartidaConLaSuite } from "@/lib/auth/cuenta-compartida";

// Las dos hojas de las páginas de acceso (el marco, la tarjeta, los campos y
// sus piezas de affectUI): la portada no las carga. Ver la cabecera de
// `app/components/acceso/acceso.css`.
import "@/app/components/acceso/acceso.css";
import "@/vendor/affectui/affectui-acceso.css";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  // Pantalla de aplicación, no de marketing: fuera del índice.
  return { title: t("signinTitle"), robots: { index: false, follow: false } };
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  // /auth/callback rebota aquí con `?error=…` cuando el enlace del correo no se
  // puede canjear. Sin esto el parámetro se tragaba en silencio y el usuario
  // volvía al login sin saber por qué. Se muestra un texto FIJO y traducido, no
  // el valor del query: reflejarlo sería inyectar contenido controlado por quien
  // fabrique la URL.
  const { error } = await searchParams;
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
        <h1>{t("welcomeBack")}</h1>
        {/* «La misma cuenta que usas en toda la suite» solo mientras lo sea
            (BVSALA_CUENTA_PROPIA, lib/auth/cuenta-compartida.ts). */}
        <p className="sub">{cuentaCompartidaConLaSuite() ? t("loginSubtitle") : t("loginSubtitleSinSuite")}</p>
      </div>
      {/* `enlace_usado`: un enlace de registro que ya se canjeó (a menudo lo abre
          el filtro de seguridad del correo antes que la persona) o caducó. Ahí no
          hay «enlace nuevo» que pedir: si la cuenta está confirmada, se entra. */}
      {error ? (
        <MensajeDeAcceso tipo="error">{error === "enlace_usado" ? t("signupLinkUsed") : t("callbackFailed")}</MensajeDeAcceso>
      ) : null}
      <AuthForm mode="login" />
      {/* El enlace sale estático (`/signup`) y, ya en el navegador, se lleva el
          `next` si lo hay: quien venía de una invitación o de elegir un plan no
          lo pierde al cambiar de pantalla. */}
      <p className="auth-alt acc-cruce">
        {t("newToBivelio")} <EnlaceConDestino a="/signup">{t("createAnAccount")}</EnlaceConDestino>
      </p>
    </AccesoShell>
  );
}
