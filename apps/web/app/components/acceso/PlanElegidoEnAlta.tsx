"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Icono } from "./iconos";
import { planDelDestino, type PlanDeAlta } from "./plan-de-alta";

/**
 * EL ALTA DICE QUÉ PLAN SE ELIGIÓ (m26).
 *
 * LO QUE PASABA. Quien pulsaba «Elegir Pro» o «Elegir Team» llegaba a un alta
 * que no nombraba ni el plan ni su precio y, en cambio, le ofrecía empezar
 * gratis con Measure. El plan viajaba en el `next` y el panel lo recogía, pero
 * nadie se lo decía a la persona en el paso de crear la cuenta.
 *
 * CÓMO. /signup sigue siendo estática (ver AuthForm y EnlaceConDestino): el
 * HTML del servidor es el de siempre, sin plan. Al montar se lee
 * `window.location.search` y, SOLO si el `next` trae un plan en venta, sale
 * la línea del plan y se retira la nota de Measure. Sin plan, nada cambia.
 *
 * Los textos llegan ya escritos desde el servidor, con el precio que lee
 * /pricing (`terminosDeLosPlanes(locale, await tarifasDeLosPlanes())`): aquí
 * no se formatea ni se escribe ninguna cifra.
 */
function usePlanDeAlta(): PlanDeAlta | null {
  const [plan, setPlan] = useState<PlanDeAlta | null>(null);
  useEffect(() => {
    setPlan(planDelDestino(window.location.search));
  }, []);
  return plan;
}

/** La línea del plan elegido, o nada. */
export function AvisoDelPlan({ plan, textos }: { plan: PlanDeAlta | null; textos: Record<PlanDeAlta, string> }) {
  if (!plan) return null;
  return (
    <div className="auth-msg info acc-plan-elegido" role="status">
      <Icono nombre="info" />
      <span>{textos[plan]}</span>
    </div>
  );
}

/** Lo que solo se enseña a quien no ha elegido plan (la oferta de Measure). */
export function SinPlan({ plan, children }: { plan: PlanDeAlta | null; children: ReactNode }) {
  return plan ? null : <>{children}</>;
}

export function PlanElegidoEnAlta({ textos }: { textos: Record<PlanDeAlta, string> }) {
  return <AvisoDelPlan plan={usePlanDeAlta()} textos={textos} />;
}

export function SoloSinPlanElegido({ children }: { children: ReactNode }) {
  return <SinPlan plan={usePlanDeAlta()}>{children}</SinPlan>;
}
