import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import AuthForm from "@/app/components/AuthForm";
import { BrandMark } from "@/app/components/BrandMark";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("signinTitle") };
}

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: "22px", gap: "10px" }}>
          <BrandMark size={24} /> <span className="tag">Savings Layer</span>
        </div>
        <h1>{t("welcomeBack")}</h1>
        <p className="sub">{t("loginSubtitle")}</p>
        <AuthForm mode="login" />
        <p className="auth-alt">
          {t("newToBivelio")} <Link href="/signup">{t("createAnAccount")}</Link>
        </p>
        <p className="auth-alt" style={{ marginTop: "10px" }}>
          <Link href="/">{t("backToVerifier")}</Link>
        </p>
      </div>
    </main>
  );
}
