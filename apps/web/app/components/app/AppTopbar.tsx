import Link from "next/link";

import { BrandMark } from "@/app/components/BrandMark";
import { ThemeToggle } from "@/app/components/ThemeToggle";

/** Dashboard top bar — brand + plan + email + theme + sign out (mirrors the neighbor). */
export function AppTopbar({ email, plan }: { email: string; plan: string }) {
  return (
    <header className="app-topbar">
      <Link href="/dashboard" className="brand" aria-label="BiVelio — dashboard">
        <BrandMark size={24} /> <span className="tag">Savings Layer</span>
      </Link>
      <div className="app-spacer" />
      <div className="app-account">
        <span className="app-plan">{plan}</span>
        {email && (
          <span className="email" title={email}>
            {email}
          </span>
        )}
        <ThemeToggle />
        <form action="/auth/signout" method="post">
          <button className="app-signout" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
