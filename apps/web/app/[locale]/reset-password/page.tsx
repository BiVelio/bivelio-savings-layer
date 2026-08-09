import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { BrandMark } from "@/app/components/BrandMark";
import ResetPasswordForm from "@/app/components/ResetPasswordForm";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("resetTitle") };
}

export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: "22px", gap: "10px" }}>
          <BrandMark size={24} /> <span className="tag">Savings Layer</span>
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
