import { AppNavLink } from "./AppNavLink";

const GROUPS: { label?: string; items: { href: string; label: string; icon: string }[] }[] = [
  { items: [{ href: "/dashboard", label: "Overview", icon: "◧" }] },
  {
    label: "Savings",
    items: [
      { href: "/dashboard/proof", label: "Proof", icon: "✓" },
      { href: "/dashboard/verify", label: "Verify", icon: "▶" },
    ],
  },
  { label: "Integrate", items: [{ href: "/dashboard/install", label: "Install", icon: "⤳" }] },
  { label: "Account", items: [{ href: "/dashboard/account", label: "Account", icon: "◔" }] },
];

/** Left dashboard sidebar — grouped nav, mirrors bivelio-privacy-gateway's AppSidebar. */
export function AppSidebar() {
  return (
    <aside className="app-sidebar">
      <nav className="app-nav" aria-label="Dashboard sections">
        {GROUPS.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} style={{ display: "contents" }}>
            {group.label && <div className="app-nav-sep">{group.label}</div>}
            {group.items.map((item) => (
              <AppNavLink key={item.href} href={item.href} icon={item.icon}>
                {item.label}
              </AppNavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
