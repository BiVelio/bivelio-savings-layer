import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PASOS_DEL_TOUR, pasosDelRecorrido } from "./tour-pasos";

/**
 * UN SOLO RECORRIDO DE SEIS PASOS (dueño, 2026-11-17).
 *
 * El tour tenía cuatro pasos más, del Resumen (veredicto, periodo,
 * personalizar, explorador), que solo salían con el Resumen cargado: al
 * iniciar sesión era de 10 pasos y en otros estados de 6, y parecían dos tours
 * distintos. El bueno es el de seis. Esta verja impide que vuelva a crecer con
 * destinos que dependen de lo que haya cargado la página.
 */
const APP = join(__dirname);
const fuente = (f: string) => readFileSync(join(APP, f), "utf8");

/** Un buscador de destinos que solo «ve» los `data-tour` indicados. */
const viendo = (...visibles: string[]) => (selectores: readonly string[]) =>
  selectores.find((s) => visibles.some((v) => s === `[data-tour="${v}"]`)) ?? null;

const ARMAZON = ["nav", "nav-install", "nav-proof", "nav-account", "tour-launch"];

describe("el tour del panel", () => {
  it("son estos pasos y en este orden", () => {
    expect(PASOS_DEL_TOUR.map((p) => p.id)).toEqual(["welcome", "nav", "setup", "proof", "team", "account", "finish"]);
  });

  it("todos sus destinos viven en el armazón del panel (barra lateral y superior), no en una página", () => {
    const armazon = ["AppSidebar.tsx", "AppTopbar.tsx", "TourGuide.tsx", "SetupProgress.tsx"].map(fuente).join("\n");
    for (const paso of PASOS_DEL_TOUR) {
      for (const destino of paso.destinos) {
        const valor = /\[data-tour="([^"]+)"\]/.exec(destino)?.[1];
        expect(valor, destino).toBeTruthy();
        // En el armazón como atributo (`data-tour="x"`) o como entrada del menú (`tour: "x"`).
        expect(armazon.includes(`data-tour="${valor}"`) || armazon.includes(`tour: "${valor}"`), `${paso.id} → ${destino}`).toBe(true);
      }
    }
  });

  it("owner en escritorio (equipo y tarjeta de puesta en marcha): seis pasos", () => {
    const pasos = pasosDelRecorrido(viendo(...ARMAZON, "nav-team", "setup"));
    expect(pasos.map((p) => p.id)).toEqual(["welcome", "nav", "setup", "proof", "team", "finish"]);
    expect(pasos.find((p) => p.id === "setup")?.destino).toBe('[data-tour="setup"]');
  });

  it("miembro (sin Equipo) y móvil (sin tarjeta): también seis — Cuenta y «Primeros pasos» toman su sitio", () => {
    const pasos = pasosDelRecorrido(viendo(...ARMAZON));
    expect(pasos.map((p) => p.id)).toEqual(["welcome", "nav", "setup", "proof", "account", "finish"]);
    expect(pasos.find((p) => p.id === "setup")?.destino).toBe('[data-tour="nav-install"]');
  });

  it("lo que haya cargado el Resumen no cambia la cuenta: con o sin datos, seis", () => {
    const sinDatos = pasosDelRecorrido(viendo(...ARMAZON, "nav-team"));
    const conDatos = pasosDelRecorrido(viendo(...ARMAZON, "nav-team", "verdict", "range", "customize", "explorer", "pulse"));
    expect(conDatos).toEqual(sinDatos);
    expect(conDatos).toHaveLength(6);
  });
});
