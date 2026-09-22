"use client";

import { Link, usePathname } from "@/i18n/navigation";

/**
 * La tira de pestañas que deja que varias páginas compartan una entrada del
 * raíl (el mismo componente que el panel de privacy). Cada página CONSERVA su
 * URL: quien tenga guardada /dashboard/verify sigue llegando a ella.
 */
export function SectionTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="tabs">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
