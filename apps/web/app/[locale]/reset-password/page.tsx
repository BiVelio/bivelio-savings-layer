import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import ResetPasswordForm from "@/app/components/ResetPasswordForm";
import { SavingsLogo } from "@/app/components/SavingsLogo";

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
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <SavingsLogo variant="full" height={40} />
        </div>
        <h1>{t("resetTitle")}</h1>
        <p className="sub">{t("newPasswordSubtitle")}</p>
        <ResetPasswordForm />
        <p className="auth-alt" style={{ marginTop: "10px" }}>
          <Link href="/login">{t("backToLogin")}</Link>
        </p>
      </div>
    </main>
  );
}
