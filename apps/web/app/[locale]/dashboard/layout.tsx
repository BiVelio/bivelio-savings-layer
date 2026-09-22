import { redirect } from "next/navigation";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { authConfigured } from "@/lib/supabase/env";
import { loadDashboard, planLabel } from "./load";

export const dynamic = "force-dynamic";

// Todo /dashboard/* queda fuera del índice desde el propio shell, así que ninguna
// pantalla nueva bajo esta rama puede olvidarse de declararlo. Va aquí y no en el
// layout raíz a propósito: la landing SÍ debe indexarse.
export const metadata = { robots: { index: false, follow: false } };

/**
 * La cáscara del panel: barra superior pegajosa + raíl izquierdo + contenido,
 * envolviendo toda ruta /dashboard/*. Es la MISMA cáscara que el panel de
 * privacy (`(app)/layout.tsx` allí): misma barra, mismo raíl de 288px, mismas
 * cifras a la derecha. Único guardián de sesión — un token caducado rebota por
 * /auth/refresh (un Route Handler que sí puede reescribir cookies), nunca un
 * bucle de redirecciones.
 *
 * LO QUE SE LE PASA AL RAÍL ES EL ROL, Y NUNCA EL PLAN: mientras el plan no
 * esté a mano en `AppSidebar`, nadie puede filtrar entradas por él, y filtrar
 * por plan es esconderle el extracto a quien tiene la tarjeta rechazada. La
 * píldora de la barra superior es la única que lo nombra.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, ctx, orgFallo } = await loadDashboard();
  if (authConfigured && !user) redirect("/auth/refresh?next=/dashboard");

  return (
    <div className="app">
      {/* `null` cuando no hay organización LEÍDA: la píldora se omite en vez de
          nombrar el plan más barato a través de una lectura que falló. */}
      <AppTopbar
        email={user?.email ?? ""}
        plan={ctx.org ? planLabel(ctx) : null}
        orgName={ctx.org?.name ?? ""}
      />
      <div className="app-body">
        <AppSidebar role={ctx.role} unknownOrg={orgFallo} />
        <main className="app-main">
          <div className="app-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}
