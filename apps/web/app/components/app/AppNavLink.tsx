"use client";

import { Link, usePathname } from "@/i18n/navigation";
import type { ReactNode } from "react";

import { ICONS } from "@/app/components/icons";

/** Item de la barra lateral con estado activo. El activo es NEUTRO (superficie
 *  + hairline + peso), no azul: es como bivelio.com marca lo seleccionado. */
export function AppNavLink({ href, icon, children }: { href: string; icon?: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
  const Icon = icon ? ICONS[icon] : undefined;
  return (
    <Link href={href} className={`app-nav-item ${active ? "on" : ""}`} aria-current={active ? "page" : undefined}>
      {Icon && (
        <span className="ic" aria-hidden>
          <Icon />
        </span>
      )}
      <span>{children}</span>
    </Link>
  );
}
