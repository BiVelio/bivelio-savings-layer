import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { ConversionRegistro } from "@/app/components/ConversionRegistro";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { Icono } from "@/app/components/acceso/iconos";
import { safeNextPath } from "@/app/auth/safe-next";
import { PLANES_EN_VENTA } from "@/lib/billing/planes";

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

/**
 * QUÉ VIENE DESPUÉS, según adónde iba quien se registró. El destino ya está
 * saneado; aquí solo se LEE para decir la verdad sobre el siguiente paso:
 * un plan elegido en la portada sigue elegido, una invitación sigue esperando,
 * y un panel recién creado todavía no tiene nada que medir.
 */
function siguientePaso(destino: string): "plan" | "invitacion" | "panel" | "otro" {
  const url = new URL(destino, "https://x.invalid");
  const plan = url.searchParams.get("plan");
  const enElPanel = /^(?:\/[a-z]{2})?\/dashboard(?:\/|$)/.test(url.pathname);
  if (enElPanel && plan !== null && (PLANES_EN_VENTA as readonly string[]).includes(plan)) return "plan";
  if (/^\/[a-z]{2}\/invitacion\//.test(url.pathname)) return "invitacion";
  return enElPanel ? "panel" : "otro";
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
  const paso = siguientePaso(destino);

  return (
    <AccesoShell>
      <ConversionRegistro idTransaccion={user.id} />
      <div className="acc-sent" data-tone="ok">
        <span className="acc-sent-icon" aria-hidden>
          <Icono nombre="hecho" />
        </span>
        <h1 className="acc-sent-title">{t("successTitle")}</h1>
        <p className="acc-sent-text">{t("successBody")}</p>
        {paso === "otro" ? null : (
          <p className="acc-sent-next">
            {paso === "plan" ? t("successPlan") : paso === "invitacion" ? t("successInvite") : t("successNext")}
          </p>
        )}
        <div className="acc-sent-actions">
          {/* Navegación dura a propósito: `destino` ya trae su prefijo de idioma
              y el router de next-intl le añadiría otro (el mismo caso que el
              login de AuthForm). */}
          <a className="btn btn-primary btn-block" href={destino}>
            {paso === "panel" ? t("successCta") : t("successContinue")}
          </a>
        </div>
      </div>
    </AccesoShell>
  );
}
