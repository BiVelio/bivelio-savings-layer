import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizarAsientos } from "@/lib/billing/asientos";

/**
 * DOS CONTRATOS DE ASIENTOS QUE LA REVISIÓN DE DINERO ENCONTRÓ ROTOS en el
 * rediseño (2026-11-16) y que este fichero fija:
 *
 *  1. El campo `#bv-seats` de BillingButtons, al cambiar de Team a Pro, debe
 *     mandar lo mismo que el <input type=number> de main. main normalizaba el
 *     estado crudo al salir del campo (`onBlur={() => setSeats(String(asientos))}`);
 *     el Number Input de affectUI solo emite cuando el valor cambia respecto al
 *     `value` ya ajustado al mínimo de Team, así que sin ese onBlur el estado
 *     crudo se quedaba por debajo (5, o 1 al reescribir «10») y Pro compraba eso.
 *
 *  2. La cifra «N de M» del raíl y del menú de la cuenta (sidebar-state.ts)
 *     sigue la regla de la tarjeta de Máquinas y de avisoDeAsientos: solo con
 *     un plan ACTIVO y con uso mayor que cero. `ctx.seats` sale de cualquier
 *     fila de suscripción, también de una cancelada: «7 de 5 pagados» sería
 *     falso para quien no paga, y el 0 de los días 1 y 2 es del calendario.
 */

const RAIZ = join(__dirname, "..", "..", "..", "..");
const fuente = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");

/** El mismo cálculo que BillingButtons (líneas `minimo` y `asientos`). */
function asientosQueSeMandan(seatsCrudo: string, plan: "pro" | "equipo", incluidos: number): number {
  const minimo = plan === "equipo" ? incluidos : 1;
  return Math.max(minimo, normalizarAsientos(seatsCrudo));
}

describe("campo de asientos · cambio de Team a Pro", () => {
  const INCLUIDOS = 10;

  it("el fuente conserva el onBlur de main dentro del Number Input de #bv-seats", () => {
    const src = fuente("app/[locale]/dashboard/components/BillingButtons.tsx");
    const bloque = src.slice(src.indexOf('id="bv-seats"'), src.indexOf("/>", src.indexOf('id="bv-seats"')));
    expect(bloque).toContain("onBlur={() => setSeats(String(asientos))}");
    // Y el cálculo que el simulador de abajo reproduce sigue siendo ese.
    expect(src).toContain('const minimo = plan === "equipo" ? precios.equipo.incluidos : 1;');
    expect(src).toContain("const asientos = Math.max(minimo, normalizarAsientos(seats));");
  });

  it("Team, escribe 5, sale del campo, elige Pro → manda 10, como main", () => {
    let crudo = "5"; // lo tecleado; el Number Input muestra 10 (mínimo de Team)
    const visto = asientosQueSeMandan(crudo, "equipo", INCLUIDOS);
    expect(visto).toBe(10);
    crudo = String(visto); // el onBlur restaurado normaliza el estado crudo
    expect(asientosQueSeMandan(crudo, "pro", INCLUIDOS)).toBe(10);
  });

  it("Team mostrando 10, reescribe «10» (pasa por «1»), sale, elige Pro → manda 10", () => {
    let crudo = "1"; // la primera tecla emite 1
    crudo = String(asientosQueSeMandan(crudo, "equipo", INCLUIDOS)); // onBlur → «10»
    expect(asientosQueSeMandan(crudo, "pro", INCLUIDOS)).toBe(10);
  });

  it("sin el onBlur, el estado crudo se quedaría en 5 y Pro compraría 5: lo que se corrige", () => {
    expect(asientosQueSeMandan("5", "pro", INCLUIDOS)).toBe(5);
  });
});

describe("«N de M» del raíl y del menú de la cuenta", () => {
  const src = fuente("lib/dashboard/sidebar-state.ts");

  it("solo con plan activo (pro o enterprise)", () => {
    expect(src).toContain('const planActivo = plan === "pro" || plan === "enterprise";');
  });

  it("solo con uso mayor que cero y con asientos pagados legibles", () => {
    const linea = src.slice(src.indexOf("const seats ="), src.indexOf("const unreadable"));
    expect(linea).toContain("planActivo");
    expect(linea).toContain("asientos.usados > 0");
    expect(linea).toContain('typeof ctx.seats === "number"');
  });
});
