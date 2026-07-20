"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Hides the marketing/top NavBar on the dashboard, which has its own topbar +
 * sidebar shell. Wrapping the (async, server) NavBar as children keeps the auth
 * check server-side while gating visibility by route on the client.
 */
export function SiteNavGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return null;
  return <>{children}</>;
}
