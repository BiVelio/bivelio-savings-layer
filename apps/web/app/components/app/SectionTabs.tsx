"use client";

import { Link, usePathname } from "@/i18n/navigation";

/**
 * La tira de pestañas que deja que varias páginas compartan una entrada del
 * raíl (el mismo componente que el panel de privacy). Cada página CONSERVA su
 * URL: quien tenga guardada /dashboard/verify sigue llegando a ella.
 *
 * FIRMA DE CAMPAÑA (2026-11-17): la activa lleva el marcador cian detrás de su
 * etiqueta, como la entrada activa del raíl, sobre un filete (`.pfc-tabs`).
 */
export function SectionTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="tabs pfc-tabs">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined}>
            <span className="pfc-tab-l">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
