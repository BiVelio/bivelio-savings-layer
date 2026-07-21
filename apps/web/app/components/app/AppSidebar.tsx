import { getTranslations } from "next-intl/server";

import { AppNavLink } from "./AppNavLink";

const GROUPS: { label?: string; items: { href: string; label: string; icon: string }[] }[] = [
  { items: [{ href: "/dashboard", label: "overview", icon: "◧" }] },
  {
    label: "savings",
    items: [
      { href: "/dashboard/proof", label: "proof", icon: "✓" },
      { href: "/dashboard/verify", label: "verify", icon: "▶" },
    ],
  },
  { label: "integrate", items: [{ href: "/dashboard/install", label: "install", icon: "⤳" }] },
  { label: "account", items: [{ href: "/dashboard/account", label: "account", icon: "◔" }] },
];

/** Left dashboard sidebar — grouped nav, mirrors bivelio-privacy-gateway's AppSidebar. */
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
