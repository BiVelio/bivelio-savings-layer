"use client";

import { Link, usePathname } from "@/i18n/navigation";
import type { ReactNode } from "react";

/** A dashboard sidebar item with active state (matches the neighbor's NavLink). */
export function AppNavLink({ href, icon, children }: { href: string; icon?: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
  return (
    <Link href={href} className={`app-nav-item ${active ? "on" : ""}`} aria-current={active ? "page" : undefined}>
      {icon && (
        <span className="ic" aria-hidden>
          {icon}
        </span>
      )}
      <span>{children}</span>
    </Link>
  );
}
