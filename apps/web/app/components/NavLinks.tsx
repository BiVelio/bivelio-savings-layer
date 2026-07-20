"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The marketing/navigation links in the top nav. Hidden on the auth surfaces
 * (login / signup) so those pages stay focused on the form — only the brand and
 * the theme toggle remain there.
 */
export function NavLinks({ authed }: { authed: boolean }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/signup") return null;

  return (
    <>
      <a className="nav-link" href="/#verify">Verifier</a>
      <a className="nav-link" href="/#pricing">Pricing</a>
      {authed ? (
        <Link className="nav-link" href="/dashboard">Dashboard</Link>
      ) : (
        <Link className="nav-link" href="/login">Sign in</Link>
      )}
    </>
  );
}
