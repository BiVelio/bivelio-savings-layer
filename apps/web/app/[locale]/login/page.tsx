import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import AuthForm from "@/app/components/AuthForm";
import { BrandMark } from "@/app/components/BrandMark";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("signinTitle") };
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
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: "22px", gap: "10px" }}>
          <BrandMark size={24} /> <span className="tag">Savings Layer</span>
        </div>
        <h1>{t("welcomeBack")}</h1>
        <p className="sub">{t("loginSubtitle")}</p>
        {error ? <div className="auth-msg error">{t("callbackFailed")}</div> : null}
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
