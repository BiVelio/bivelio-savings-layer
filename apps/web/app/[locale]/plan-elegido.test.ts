import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { safeNextPath } from "@/app/auth/safe-next";

/**
 * EL PLAN QUE SE ELIGE EN LA PORTADA LLEGA AL PANEL.
 *
 * Hasta la 0.5.0, «Elegir Pro» y «Elegir Equipo» llevaban los dos a `/signup`
 * a secas, y el selector del panel arrancaba siempre en Pro: quien pulsaba
 * Equipo tenía que buscarlo y volver a elegirlo antes de pagar. Ahora cada
 * botón manda su plan en el `next` del registro, que ya viaja por
 * /auth/callback y signup/success, y BillingButtons lo preselecciona.
 */
const leer = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

describe("el plan elegido en la portada", () => {
  it("Pro y Equipo mandan su plan en el next del registro", () => {
    const src = leer("./page.tsx");
    expect(src).toMatch(/query: \{ next: `\/\$\{locale\}\/dashboard\?plan=pro` \}/);
    expect(src).toMatch(/query: \{ next: `\/\$\{locale\}\/dashboard\?plan=equipo` \}/);
  });

  it("el next con ?plan= pasa el guardián de redirecciones intacto", () => {
    expect(safeNextPath("/de/dashboard?plan=equipo")).toBe("/de/dashboard?plan=equipo");
    expect(safeNextPath("/es/dashboard?plan=pro")).toBe("/es/dashboard?plan=pro");
  });

  it("BillingButtons preselecciona Equipo desde ?plan= sin abrir el checkout", () => {
    const src = leer("./dashboard/components/BillingButtons.tsx");
    const efecto = src.slice(src.indexOf("useEffect(() => {"), src.indexOf("}, [precios.equipo.incluidos]);"));
    expect(efecto).toMatch(/get\("plan"\)/);
    expect(efecto).toMatch(/setPlan\("equipo"\)/);
    expect(efecto).not.toMatch(/\bgo\(|fetch\(/);
  });
});
