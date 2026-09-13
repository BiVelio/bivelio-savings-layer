import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { destinoDeLaPeticion } from "@/lib/auth/destino";
import { authConfigured } from "@/lib/supabase/env";
import { loadDashboard, planLabel } from "./load";

export const dynamic = "force-dynamic";

// Todo /dashboard/* queda fuera del índice desde el propio shell, así que ninguna
// pantalla nueva bajo esta rama puede olvidarse de declararlo. Va aquí y no en el
// layout raíz a propósito: la landing SÍ debe indexarse.
export const metadata = { robots: { index: false, follow: false } };

/**
 * Dashboard shell: sticky topbar + left sidebar + main content, wrapping every
 * /dashboard/* route. Single auth gate — an expired token bounces through
 * /auth/refresh (a Route Handler that can rewrite cookies), never a redirect loop.
 * El `next` es la URL pedida, con su consulta (cabecera del middleware, ver
 * lib/auth/destino.ts): sin ella, el enlace de compra con ?codigo= perdía el
 * código en cuanto no había sesión.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, ctx } = await loadDashboard();
  if (authConfigured && !user) {
    const destino = destinoDeLaPeticion(await headers());
    redirect(`/auth/refresh?next=${encodeURIComponent(destino)}`);
  }

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
