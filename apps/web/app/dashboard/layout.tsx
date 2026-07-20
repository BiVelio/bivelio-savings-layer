import { redirect } from "next/navigation";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { authConfigured } from "@/lib/supabase/env";
import { loadDashboard, planLabel } from "./load";

export const dynamic = "force-dynamic";

/**
 * Dashboard shell: sticky topbar + left sidebar + main content, wrapping every
 * /dashboard/* route. Single auth gate — an expired token bounces through
 * /auth/refresh (a Route Handler that can rewrite cookies), never a redirect loop.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, ctx } = await loadDashboard();
  if (authConfigured && !user) redirect("/auth/refresh?next=/dashboard");

  return (
    <div className="app">
      <AppTopbar email={user?.email ?? ""} plan={planLabel(ctx)} />
      <div className="app-body">
        <AppSidebar />
        <main className="app-main">
          <div className="app-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}
