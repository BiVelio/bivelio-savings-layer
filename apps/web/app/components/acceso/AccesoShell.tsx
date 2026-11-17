import type { ReactNode } from "react";
import { preload } from "react-dom";

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
  // El paisaje del panel lateral es el LCP del acceso en escritorio y, como
  // fondo CSS, se pedía tarde: se anuncia con el mismo corte que .acc-aside
  // (desde 1024 px; por debajo el panel no se pinta y no se descarga nada).
  if (lateral) {
    preload("/brand/paisaje/dia-1600.avif", { as: "image", type: "image/avif", media: "(min-width: 1024px)", fetchPriority: "high" });
  }
  return (
    <main className={lateral ? "auth-wrap acc acc--split" : "auth-wrap acc"}>
      <div className="acc-main">
        <div className="auth-card acc-card">
          <div className="auth-brand">
            {/* El CSS lo oculta en el móvil (.acc-card .auth-brand, acceso/acceso.css). */}
            <SavingsLogo variant="mark" height={32} ocultoEn="(max-width: 640px)" />
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
