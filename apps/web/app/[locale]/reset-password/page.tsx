import { getTranslations, setRequestLocale } from "next-intl/server";

import ResetPasswordForm from "@/app/components/ResetPasswordForm";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { EnlaceConDestino } from "@/app/components/acceso/EnlaceConDestino";

// Las dos hojas de las páginas de acceso (el marco, la tarjeta, los campos y
// sus piezas de affectUI): la portada no las carga. Ver la cabecera de
// `app/components/acceso/acceso.css`.
import "@/app/components/acceso/acceso.css";
import "@/vendor/affectui/affectui-acceso.css";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  // Pantalla de aplicación, no de marketing: fuera del índice.
  return { title: t("resetTitle"), robots: { index: false, follow: false } };
}

export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <AccesoShell
      pie={
        <EnlaceConDestino a="/login" className="acc-volver">
          {t("backToLogin")}
        </EnlaceConDestino>
      }
    >
      <div className="acc-intro">
        <h1>{t("resetTitle")}</h1>
        <p className="sub">{t("newPasswordSubtitle")}</p>
      </div>
      <ResetPasswordForm />
    </AccesoShell>
  );
}
