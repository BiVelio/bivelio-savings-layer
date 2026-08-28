import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { LocaleSwitcher } from "@/app/components/LocaleSwitcher";
import { SavingsLogo } from "@/app/components/SavingsLogo";

/** Barra superior del dashboard — misma altura, fondo translúcido y hairline
 *  que la cabecera de bivelio.com, con la cuenta a la derecha. Lleva el mismo
 *  logo oficial de Savings que el NavBar público (isotipo solo en móvil). */
export async function AppTopbar({ email, plan }: { email: string; plan: string }) {
  const t = await getTranslations("nav");
  return (
    <header className="app-topbar">
      <Link href="/dashboard" className="brand app-brand" aria-label="Savings by BiVelio — dashboard">
        <SavingsLogo variant="full" height={36} className="app-logo-full" />
        <SavingsLogo variant="mark" height={32} className="app-logo-mark" />
      </Link>
      <div className="app-spacer" />
      <div className="app-account">
        <span className="app-plan">{plan}</span>
        {email && (
          <span className="email" title={email}>
            {email}
          </span>
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
