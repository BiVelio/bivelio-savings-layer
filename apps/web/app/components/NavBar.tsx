import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { BrandMark } from "./BrandMark";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Top navigation for the app surfaces (login / signup / dashboard). The static
 * marketing landing (public/landing.html) has its own header. Auth-aware: signed-in
 * users see "Dashboard", signed-out users see "Sign in".
 */
export async function NavBar() {
  let authed = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authed = !!user;
  } catch {
    // Auth not resolvable (e.g. env missing) — render the signed-out nav.
  }

  return (
    <header className="site-nav">
      <div className="site-nav-inner">
        <Link href="/" className="nav-brand" aria-label="BiVelio Savings Layer — home">
          <BrandMark size={24} />
          <span className="tag">Savings Layer</span>
        </Link>
        <nav className="nav-actions">
          <NavLinks authed={authed} />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
