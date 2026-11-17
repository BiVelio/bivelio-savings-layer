import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_ASIENTOS, normalizarAsientos } from "@/lib/billing/asientos";
import { committedValue, handledKeys, JUMP_KEYS, readNumber, typedValue } from "@/vendor/affectui/number-input-read";

/**
 * EL CONTRATO DEL CAMPO DE ASIENTOS — lo que se teclea en `#bv-seats` es la
 * cantidad que se manda a Stripe.
 *
 * El campo era un `<input type=number>` y pasó a ser el Number Input de
 * affectUI. La revisión de dinero encontró tres maneras de que el campo nuevo
 * mandara una cantidad que el viejo nunca habría mandado:
 *   · «Fin» saltaba a MAX_ASIENTOS (500) de una sola tecla;
 *   · «2,5» perdía la coma y compraba 25;
 *   · el valor solo se emitía al salir del campo, así que un botón activado
 *     sin sacar el foco compraba la cantidad anterior.
 *
 * Aquí se fija lo que el campo manda, con las MISMAS funciones que usa el
 * componente (vendor/affectui/number-input-read.ts) y la misma normalización
 * que usa BillingButtons (`normalizarAsientos`). El pegamento entre las dos
 * —tres líneas de JSX— se fija leyendo el fuente, como el resto de contratos
 * de esta carpeta.
 */
const MARCAS = { group: "", decimal: "." };
const ENTERO = { integer: true } as const;
const INCLUIDOS_EQUIPO = 10;

/** El campo de BillingButtons, sin navegador: el estado `seats` (texto) y lo que se manda. */
function campo({ minimo = 1, inicial = "1" }: { minimo?: number; inicial?: string } = {}) {
  let seats = inicial;
  const asientos = () => Math.max(minimo, normalizarAsientos(seats));
  // `set` del Number Input: solo avisa si el valor cambia; y el `onValueChange`
  // de BillingButtons: `setSeats(String(v ?? minimo))`.
  const emitir = (v: number | null | undefined) => {
    if (v !== undefined && v !== asientos()) seats = String(v ?? minimo);
  };
  return {
    /** Un cambio del texto del campo (una pulsación, o un pegado entero). */
    cambiar(texto: string) {
      emitir(typedValue(texto, MARCAS, ENTERO));
      return asientos();
    },
    /** Teclear carácter a carácter desde el campo vacío. */
    teclear(texto: string) {
      for (let i = 1; i <= texto.length; i++) emitir(typedValue(texto.slice(0, i), MARCAS, ENTERO));
      return asientos();
    },
    /** Salir del campo (o Enter) con ese texto dentro. */
    salir(texto: string) {
      emitir(committedValue(texto, MARCAS, { ...ENTERO, min: minimo, max: MAX_ASIENTOS, step: 1 }));
      return asientos();
    },
    asientos,
  };
}

/** Teclear y salir: lo que acaba mandándose. */
function comprar(texto: string, opciones?: { minimo?: number; inicial?: string }) {
  const c = campo(opciones);
  c.cambiar("");
  c.teclear(texto);
  return c.salir(texto);
}

describe("campo de asientos — lo que se manda al checkout", () => {
  it("vacío, cero y negativo compran el mínimo", () => {
    expect(comprar("")).toBe(1);
    expect(comprar("0")).toBe(1);
    expect(comprar("-3")).toBe(1);
    expect(comprar("−3")).toBe(1);
  });

  it("un entero se manda tal cual y por encima del tope se queda en MAX_ASIENTOS", () => {
    expect(comprar("12")).toBe(12);
    expect(comprar("500")).toBe(500);
    expect(comprar("501")).toBe(MAX_ASIENTOS);
    expect(comprar("600")).toBe(MAX_ASIENTOS);
    expect(comprar("99999")).toBe(MAX_ASIENTOS);
  });

  it("un decimal NUNCA pierde su separador: «1,5» no compra 15 ni «2.5» compra 25", () => {
    // Tecleado: cuenta lo último que se leyó como entero, que es lo que el
    // `<input type=number>` mandaba (1 y 2).
    expect(comprar("1,5")).toBe(1);
    expect(comprar("2.5")).toBe(2);
    expect(comprar("2,5")).toBe(2);
    expect(comprar("2.9")).toBe(2);
    expect(comprar("1,000")).toBe(1);
    expect(comprar("1.000")).toBe(1);
  });

  it("un espacio en medio tampoco se quita: «1 2» no compra 12", () => {
    expect(comprar("1 2")).toBe(1);
    expect(comprar("1 2")).toBe(1);
  });

  it("un texto con separadores PEGADO no se lee: el campo vuelve a la cantidad que había", () => {
    for (const pegado of ["1,5", "2.5", "1 2", "1,000", "12abc", "1e5"]) {
      const c = campo({ inicial: "7" });
      expect(c.cambiar(pegado)).toBe(7);
      expect(c.salir(pegado)).toBe(7);
    }
  });

  it("Equipo no baja de los asientos incluidos", () => {
    const equipo = { minimo: INCLUIDOS_EQUIPO, inicial: String(INCLUIDOS_EQUIPO) };
    expect(comprar("", equipo)).toBe(INCLUIDOS_EQUIPO);
    expect(comprar("0", equipo)).toBe(INCLUIDOS_EQUIPO);
    expect(comprar("3", equipo)).toBe(INCLUIDOS_EQUIPO);
    expect(comprar("9", equipo)).toBe(INCLUIDOS_EQUIPO);
    expect(comprar("10", equipo)).toBe(10);
    expect(comprar("12", equipo)).toBe(12);
    expect(comprar("600", equipo)).toBe(MAX_ASIENTOS);
    expect(comprar("12,5", equipo)).toBe(12);
  });

  it("lo que se manda va al día con lo tecleado, sin esperar a salir del campo", () => {
    const c = campo();
    expect(c.cambiar("1")).toBe(1);
    expect(c.cambiar("12")).toBe(12);
    expect(c.cambiar("120")).toBe(120);
    // Borrar para corregir pasa por el vacío, que es el mínimo, no la cifra vieja.
    expect(c.cambiar("")).toBe(1);
    expect(c.cambiar("4")).toBe(4);
  });
});

describe("campo de asientos — las teclas", () => {
  it("Inicio, Fin, RePág y AvPág no son del campo: no saltan a 1 ni a 500", () => {
    const teclas = handledKeys({ min: 1, max: MAX_ASIENTOS, jumpKeys: false });
    for (const tecla of JUMP_KEYS) expect(teclas).not.toContain(tecla);
    expect([...JUMP_KEYS].sort()).toEqual(["End", "Home", "PageDown", "PageUp"]);
    // Lo que sí hace, como el campo numérico de siempre: flechas de a uno.
    expect(teclas.sort()).toEqual(["ArrowDown", "ArrowUp", "Enter", "Escape"]);
  });

  it("sin `jumpKeys={false}` el campo SÍ saltaría al tope: por eso el formulario lo apaga", () => {
    const teclas = handledKeys({ min: 1, max: MAX_ASIENTOS });
    expect(teclas).toContain("End");
    expect(teclas).toContain("Home");
    expect(teclas).toContain("PageUp");
    expect(teclas).toContain("PageDown");
  });
});

describe("Number Input — lectura de enteros", () => {
  it("solo dígitos (y un menos delante) son un número", () => {
    expect(readNumber("12", MARCAS, ENTERO)).toBe(12);
    expect(readNumber(" 12 ", MARCAS, ENTERO)).toBe(12);
    expect(readNumber("-4", MARCAS, ENTERO)).toBe(-4);
    expect(readNumber("", MARCAS, ENTERO)).toBeNull();
    expect(readNumber("   ", MARCAS, ENTERO)).toBeNull();
    for (const ilegible of ["1,5", "2.5", "1 2", "1,000", "1.000", "1'000", "1’000", "12%", "4-", "(4)", "-", "."]) {
      expect(readNumber(ilegible, MARCAS, ENTERO), ilegible).toBeNaN();
    }
  });

  it("da igual el idioma: en entero, los separadores del locale tampoco se quitan", () => {
    for (const marcas of [{ group: ",", decimal: "." }, { group: ".", decimal: "," }, { group: " ", decimal: "," }]) {
      expect(readNumber("1,5", marcas, ENTERO)).toBeNaN();
      expect(readNumber("1.000", marcas, ENTERO)).toBeNaN();
      expect(readNumber("1 000", marcas, ENTERO)).toBeNaN();
    }
  });

  it("fuera del modo entero la lectura con separadores no cambia", () => {
    expect(readNumber("1,000.5", { group: ",", decimal: "." })).toBe(1000.5);
    expect(readNumber("1.000,5", { group: ".", decimal: "," })).toBe(1000.5);
    expect(readNumber("25", MARCAS, { percent: true })).toBe(0.25);
    expect(readNumber("1.2.3", MARCAS)).toBeNaN();
  });
});

describe("el formulario usa ese contrato", () => {
  const formulario = readFileSync(join(__dirname, "BillingButtons.tsx"), "utf8");
  const pieza = readFileSync(join(__dirname, "../../../../vendor/affectui/number-input.tsx"), "utf8");
  const campoJsx = formulario.slice(formulario.indexOf("<NumberInput"), formulario.indexOf("/>", formulario.indexOf("<NumberInput")));

  it("BillingButtons monta el campo en entero, sin teclas de salto, y normaliza lo que recibe", () => {
    expect(campoJsx).toMatch(/id="bv-seats"/);
    expect(campoJsx).toMatch(/^\s*integer$/m);
    expect(campoJsx).toMatch(/jumpKeys=\{false\}/);
    expect(campoJsx).toMatch(/min=\{minimo\}/);
    expect(campoJsx).toMatch(/value=\{asientos\}/);
    expect(campoJsx).toMatch(/onValueChange=\{\(v\) => setSeats\(String\(v \?\? minimo\)\)\}/);
    expect(formulario).toMatch(/const asientos = Math\.max\(minimo, normalizarAsientos\(seats\)\);/);
    expect(formulario).toMatch(/const minimo = plan === "equipo" \? precios\.equipo\.incluidos : 1;/);
    // Lo que se manda es `asientos`, no el texto del campo.
    expect(formulario.match(/seats: asientos \}/g)).toHaveLength(2);
  });

  it("el Number Input lee, emite y elige sus teclas con las funciones probadas aquí", () => {
    expect(pieza).toMatch(/readNumber\(text, marks, \{ percent, integer \}\)/);
    expect(pieza).toMatch(/typedValue\(text, marks, \{ percent, integer \}\)/);
    expect(pieza).toMatch(/committedValue\(draft, marks, \{ percent, integer, min: lo, max: hi, step: stepSize \}\)/);
    expect(pieza).toMatch(/handledKeys\(\{ min: lo, max: hi, jumpKeys \}\)\.includes\(e\.key\)/);
    // Y no guarda otra lectura propia que quite separadores.
    expect(pieza).not.toMatch(/split\(marks\.group\)/);
  });
});
