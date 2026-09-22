import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { LocaleSwitcher } from "@/app/components/LocaleSwitcher";
import { SavingsLogo } from "@/app/components/SavingsLogo";

/**
 * Barra superior del panel — misma altura, fondo translúcido y hairline que
 * la cabecera de bivelio.com y que la del panel de privacy, con la cuenta a la
 * derecha: nombre de la organización, plan, correo (que ES el enlace a
 * Cuenta), idioma y cerrar sesión. Lleva el logo oficial de Savings, como el
 * NavBar público (isotipo solo en móvil).
 */
export async function AppTopbar({
  email,
  plan,
  orgName,
}: {
  email: string;
  /** El plan de la organización, o `null` cuando NO SE LEYÓ — que no es lo
   *  mismo que «el gratuito». La píldora se omite entonces, igual que el
   *  nombre: pintar un plan a través de una lectura fallida es cómo se le dice
   *  a un cliente que paga, en todas las pantallas, que no paga. */
  plan: string | null;
  /** La organización de quien mira. Vacío cuando no se pudo leer. */
  orgName: string;
}) {
  const t = await getTranslations("nav");
  const a = await getTranslations("app.topbar");
  // El nombre del plan sale del catálogo, no del enum crudo; `has()` cubre un
  // plan añadido al esquema antes de que el texto lo alcance.
  const planLabel = plan && a.has(`plan.${plan}` as never) ? a(`plan.${plan}` as never) : plan;
  return (
    <header className="app-topbar">
      <Link href="/dashboard" className="brand app-brand" aria-label="Savings by BiVelio — dashboard">
        <SavingsLogo variant="full" height={36} className="app-logo-full" />
        <SavingsLogo variant="mark" height={32} className="app-logo-mark" />
      </Link>
      <div className="app-spacer" />
      <div className="app-account">
        {orgName ? (
          <span className="app-org" title={a("orgLabel", { org: orgName })}>
            {orgName}
          </span>
        ) : null}
        {planLabel ? <span className="app-plan">{planLabel}</span> : null}
        {email && (
          <Link href="/dashboard/account" className="email" title={a("accountLink", { email })}>
            {email}
          </Link>
        )}
        <LocaleSwitcher />
        <form action="/auth/signout" method="post">
          <button className="app-signout" type="submit">
            {t("signOut")}
          </button>
        </form>
      </div>
    </header>
  );
}
