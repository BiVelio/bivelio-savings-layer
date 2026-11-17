import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { AccountIcon, MachinesIcon, SignOutIcon, TeamIcon } from "@/app/components/icons";
import { LocaleSwitcher } from "@/app/components/LocaleSwitcher";
import { SavingsLogo } from "@/app/components/SavingsLogo";
import { getSidebarState } from "@/lib/dashboard/sidebar-state";
import { puede } from "@/lib/org/permisos";

import { CuentaMenu } from "./CuentaMenu";
import { destinoDelHito } from "./setup-destinos";
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
 *
 * «ESPECTACULAR» 2026-11: la cuenta deja de ser un correo suelto y un botón de
 * salir y pasa a ser el Profile Menu de affectUI (`CuentaMenu`). La tarjeta
 * dice lo que el panel ya sabe —organización, correo, rol y plan— y enlaza a
 * lo que existe: Cuenta, Equipo (solo si el rol puede gestionarlo) y Máquinas,
 * con las mismas lecturas del raíl a la derecha. Su última fila de datos es la
 * puesta en marcha MEDIDA (la que en móvil el raíl esconde) y salir sigue
 * siendo un POST a /auth/signout. El idioma se queda fuera, con su propio
 * diálogo. Nada de esto se inventa: sin lectura, la fila sale sin cifra, y sin
 * rol legible no hay etiqueta de rol.
 */
export async function AppTopbar({
  email,
  plan,
  orgName,
  role,
}: {
  email: string;
  /** El plan de la organización, o `null` cuando NO SE LEYÓ o el cobro sigue
   *  en curso (`planDeLaBarra`) — que no es lo mismo que «el gratuito». La píldora se omite entonces, igual que el
   *  nombre: pintar un plan a través de una lectura fallida es cómo se le dice
   *  a un cliente que paga, en todas las pantallas, que no paga. */
  plan: string | null;
  /** La organización de quien mira. Vacío cuando no se pudo leer. */
  orgName: string;
  /** El rol de quien mira, o nada cuando no se leyó. Decide si se ofrece Equipo. */
  role?: string | null;
}) {
  const t = await getTranslations("nav");
  const a = await getTranslations("app.topbar");
  const sb = await getTranslations("app.sidebar");
  const su = await getTranslations("app.setup");
  const eq = await getTranslations("dashboard.equipo");
  const state = email ? await getSidebarState() : null;
  // El nombre del plan sale del catálogo, no del enum crudo; `has()` cubre un
  // plan añadido al esquema antes de que el texto lo alcance.
  const planLabel = plan && a.has(`plan.${plan}` as never) ? a(`plan.${plan}` as never) : plan;
  const rolKey = role ? `rol${role.charAt(0).toUpperCase()}${role.slice(1)}` : "";
  const rolLabel = rolKey && eq.has(rolKey as never) ? eq(rolKey as never) : null;
  const progress = state?.progress && state.progress.readable ? state.progress : null;
  const siguiente = progress?.steps.find((s) => s.status === "current");
  return (
    <header className="app-topbar" data-tour="topbar">
      <Link href="/dashboard" className="brand app-brand" aria-label={a("brandAria")}>
        {/* Las consultas son las de .app-logo-full/.app-logo-mark en globals.css. */}
        <SavingsLogo variant="full" height={30} className="app-logo-full" ocultoEn="(max-width: 520px)" />
        <SavingsLogo variant="mark" height={28} className="app-logo-mark" ocultoEn="(min-width: 521px)" />
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
        <LocaleSwitcher />
        {email ? (
          <CuentaMenu
            triggerLabel={a("accountLink", { email })}
            menuLabel={a("menuLabel")}
            name={orgName}
            email={email}
            tags={[
              ...(rolLabel ? [{ id: "rol", label: rolLabel }] : []),
              ...(planLabel ? [{ id: "plan", label: planLabel, tone: "brand" as const }] : []),
            ]}
            items={[
              { id: "account", label: sb("account"), href: "/dashboard/account", icon: <AccountIcon /> },
              ...(puede(role, "gestionar_miembros")
                ? [
                    {
                      id: "team",
                      label: sb("team"),
                      href: "/dashboard/team",
                      icon: <TeamIcon />,
                      badge: typeof state?.members === "number" ? su("badge.members", { n: state.members }) : undefined,
                    },
                  ]
                : []),
              {
                id: "machines",
                label: sb("maquinas"),
                href: "/dashboard#maquinas",
                icon: <MachinesIcon />,
                badge: state?.seats ? su("badge.seats", { used: state.seats.used, seats: state.seats.seats }) : undefined,
              },
            ]}
            setup={
              progress
                ? {
                    title: su("title"),
                    countLabel: su("count", { done: progress.done, total: progress.total }),
                    done: progress.done,
                    total: progress.total,
                    nextHint: a("setupNext"),
                    next: siguiente?.label,
                    href: siguiente ? destinoDelHito(siguiente.id) : undefined,
                  }
                : undefined
            }
            signOut={{ label: t("signOut"), icon: <SignOutIcon /> }}
          />
        ) : (
          // Sin correo no hay menú que abrir, pero SALIR NO PUEDE FALTAR: una
          // sesión cuyo correo no se leyó se quedaba sin forma de cerrarse. El
          // mismo POST a /auth/signout, como botón suelto.
          <form action="/auth/signout" method="post" className="app-signout-form">
            <button className="app-signout-solo" type="submit">
              <SignOutIcon />
              <span>{t("signOut")}</span>
            </button>
          </form>
        )}
      </div>
    </header>
  );
}
