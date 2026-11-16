import type { ReactNode } from "react";

import { SavingsLogo } from "@/app/components/SavingsLogo";

/**
 * EL MARCO DE TODAS LAS PANTALLAS DE ACCESO — login, alta, confirmación,
 * nueva contraseña e invitación.
 *
 * Una tarjeta blanca sobre el marfil y, cuando se pasa `lateral`, un panel de
 * marca a su derecha (solo desde 1024px: en móvil y tableta la tarjeta va sola,
 * que es donde se escribe). Es presentación pura: sin hooks ni lecturas de
 * servidor, así que sirve igual dentro de un componente de cliente (la
 * invitación) que de una página estática (el alta).
 */
export function AccesoShell({
  children,
  lateral,
  pie,
  etiquetaLateral,
}: {
  children: ReactNode;
  /** El panel de marca. Sin él la tarjeta va centrada, sola. */
  lateral?: ReactNode;
  /** Lo que va bajo la tarjeta: la vuelta al inicio. */
  pie?: ReactNode;
  etiquetaLateral?: string;
}) {
  return (
    <main className={lateral ? "auth-wrap acc acc--split" : "auth-wrap acc"}>
      <div className="acc-main">
        <div className="auth-card acc-card">
          <div className="auth-brand">
            <SavingsLogo variant="mark" height={32} />
          </div>
          {children}
        </div>
        {pie ? <div className="acc-pie">{pie}</div> : null}
      </div>
      {lateral ? (
        <aside className="acc-aside" aria-label={etiquetaLateral}>
          {lateral}
        </aside>
      ) : null}
    </main>
  );
}
