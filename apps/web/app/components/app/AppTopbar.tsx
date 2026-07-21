import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { BrandMark } from "@/app/components/BrandMark";
import { LocaleSwitcher } from "@/app/components/LocaleSwitcher";
import { ThemeToggle } from "@/app/components/ThemeToggle";

/** Dashboard top bar — brand + plan + email + theme + sign out (mirrors the neighbor). */
export async function AppTopbar({ email, plan }: { email: string; plan: string }) {
  const t = await getTranslations("nav");
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
        <LocaleSwitcher />
        <ThemeToggle />
        <form action="/auth/signout" method="post">
          <button className="app-signout" type="submit">
            {t("signOut")}
          </button>
        </form>
      </div>
    </header>
  );
}
