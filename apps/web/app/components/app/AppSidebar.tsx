import { getTranslations } from "next-intl/server";

import { AppNavLink } from "./AppNavLink";

const GROUPS: { label?: string; items: { href: string; label: string; icon: string }[] }[] = [
  { items: [{ href: "/dashboard", label: "overview", icon: "overview" }] },
  {
    label: "savings",
    items: [
      { href: "/dashboard/proof", label: "proof", icon: "proof" },
      { href: "/dashboard/verify", label: "verify", icon: "verify" },
    ],
  },
  {
    label: "integrate",
    items: [
      { href: "/dashboard/how-it-works", label: "howItWorks", icon: "how" },
      { href: "/dashboard/install", label: "install", icon: "install" },
    ],
  },
  { label: "account", items: [{ href: "/dashboard/account", label: "account", icon: "account" }] },
];

/** Barra lateral del dashboard — navegación agrupada, con los mismos
 *  encabezados de grupo (11px, 600, versalitas) y las mismas cajas de icono
 *  (32px, hairline, blanco) que los menús de bivelio.com. */
export async function AppSidebar() {
  const t = await getTranslations("app.sidebar");
  return (
    <aside className="app-sidebar">
      <nav className="app-nav" aria-label="Dashboard sections">
        {GROUPS.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} style={{ display: "contents" }}>
            {group.label && <div className="app-nav-sep">{t(group.label)}</div>}
            {group.items.map((item) => (
              <AppNavLink key={item.href} href={item.href} icon={item.icon}>
                {t(item.label)}
              </AppNavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
