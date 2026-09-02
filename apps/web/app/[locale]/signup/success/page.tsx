import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { ConversionRegistro } from "@/app/components/ConversionRegistro";
import { SavingsLogo } from "@/app/components/SavingsLogo";
import { safeNextPath } from "@/app/auth/safe-next";

/**
 * LA PÁGINA EXCLUSIVA DE CONFIRMACIÓN DE REGISTRO — el único sitio donde se
 * dispara la conversión de Google Ads. Solo se llega aquí desde el callback
 * tras un verifyOtp de `signup` correcto, y aun así EXIGE sesión: visitarla a
 * pelo sin cuenta redirige al login y no dispara nada. El id del usuario viaja
 * como transaction_id para que Google deduplique (ver ConversionRegistro).
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("successTitle"), robots: { index: false, follow: false } };
}

export default async function SignupSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const t = await getTranslations("auth");
  // Re-saneado aunque venga de nuestro propio callback: es query string y
  // cualquiera puede fabricar la URL — misma guardia que el callback.
  const destino = safeNextPath((await searchParams).next ?? null);

  return (
    <main className="auth-wrap">
      <ConversionRegistro idTransaccion={user.id} />
      <div className="auth-card">
        <SavingsLogo />
        <h1>{t("successTitle")}</h1>
        <p className="sub">{t("successBody")}</p>
        {/* Navegación dura a propósito: `destino` ya trae su prefijo de idioma
            y el router de next-intl le añadiría otro (el mismo caso que el
            login de AuthForm). */}
        <a className="btn" href={destino}>
          {t("successCta")}
        </a>
      </div>
    </main>
  );
}
