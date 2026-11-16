import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { SignOutIcon } from "@/app/components/icons";
import { LocaleSwitcher } from "@/app/components/LocaleSwitcher";
import { SavingsLogo } from "@/app/components/SavingsLogo";

import { TourGuide } from "./TourGuide";

/**
 * Barra superior del panel — misma altura, fondo translúcido y hairline que
 * la cabecera de bivelio.com y que la del panel de privacy, con la cuenta a la
 * derecha: nombre de la organización, plan, correo (que ES el enlace a
 * Cuenta), idioma y cerrar sesión. Lleva el logo oficial de Savings, como el
 * NavBar público (isotipo solo en móvil).
 *
 * REDISEÑO 2026-11 (gramática «App Shell Flat»): la organización y el plan
 * pasan a la IZQUIERDA, junto a la marca, como contexto («Savings / Acme ·
 * Pro»); la derecha queda para las acciones — «Ver tour», la cuenta, el idioma
 * y salir. En estrecho el correo se queda en su inicial y «Ver tour» y «Salir»
 * en su icono, sin perder el nombre accesible (el texto se recorta, no se
 * quita). La semántica no cambia: sin organización LEÍDA no hay nombre ni
 * píldora de plan.
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
  const inicial = email ? email.trim().charAt(0).toUpperCase() : "";
  return (
    <header className="app-topbar" data-tour="topbar">
      <Link href="/dashboard" className="brand app-brand" aria-label="Savings by BiVelio — dashboard">
        <SavingsLogo variant="full" height={30} className="app-logo-full" />
        <SavingsLogo variant="mark" height={28} className="app-logo-mark" />
      </Link>
      {orgName || planLabel ? (
        <div className="app-ctx">
          <span className="app-ctx-sep" aria-hidden>
            /
          </span>
          {orgName ? (
            <span className="app-org" title={a("orgLabel", { org: orgName })}>
              {orgName}
            </span>
          ) : null}
          {planLabel ? <span className="app-plan">{planLabel}</span> : null}
        </div>
      ) : null}
      <div className="app-spacer" />
      <div className="app-account">
        <TourGuide />
        {email && (
          <Link href="/dashboard/account" className="email" title={a("accountLink", { email })} aria-label={a("accountLink", { email })}>
            <span className="app-avatar" aria-hidden>
              {inicial}
            </span>
            <span className="app-email-text">{email}</span>
          </Link>
        )}
        <LocaleSwitcher />
        <form action="/auth/signout" method="post" className="app-signout-form">
          <button className="app-signout" type="submit">
            <span className="app-signout-ic" aria-hidden>
              <SignOutIcon />
            </span>
            <span className="app-signout-label">{t("signOut")}</span>
          </button>
        </form>
      </div>
    </header>
  );
}
