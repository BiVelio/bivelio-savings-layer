import { describe, expect, it } from "vitest";

import { InMemoryToolSetFreezer, ToolSelector } from "../src/router/tool-selector.js";
import type { ToolDescriptor } from "../src/contracts/types.js";

/**
 * Lo que este fichero fija, y por qué importa (medido el 2026-09-10 sobre 14,9 GB
 * de tráfico real, 10.553 peticiones con herramientas):
 *
 *  1. UN CATÁLOGO REAL NO TRAE `intents` NI `risk`. Cero de 10.636 los declaraban.
 *     Antes eso significaba emitir CERO herramientas (se le rompe la función al
 *     cliente) o reventar con TypeError. Ahora pasa íntegro.
 *  2. EL CONJUNTO SE CONGELA. `tools` va lo primero del prompt, así que un
 *     conjunto que cambia con la pregunta invalida la caché de prefijo detrás.
 *     Podar sin congelar multiplicaba por 6,1 la factura de entrada.
 *  3. NO SE ACREDITA AHORRO FANTASMA: si no se poda por falta de señal, el libro
 *     no puede apuntarse el bloque entero.
 */

/** Un catálogo tal y como llega de MCP: nombre, descripción y esquema. Nada más. */
const catalogoReal = (n: number): ToolDescriptor[] =>
  Array.from({ length: n }, (_, i) => ({ id: `herramienta_${i}`, description: `hace la cosa ${i}` }) as unknown as ToolDescriptor);

const tipada = (id: string, intents: string[], risk: "read" | "write"): ToolDescriptor =>
  ({ id, intents, risk }) as ToolDescriptor;

describe("catálogo real sin tipar: pasa íntegro, no se rompe ni se inventa ahorro", () => {
  it("NO emite cero herramientas (antes el modelo se quedaba sin capacidades)", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const r = sel.select("lee el fichero", catalogoReal(55), "SINGLE_RETRIEVAL");
    expect(r.tools.length).toBe(8);
    expect(r.tools.length).toBeGreaterThan(0);
  });

  it("la ruta TOOL_ACTION ya NO lanza TypeError al puntuar", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    expect(() => sel.select("borra el fichero", catalogoReal(55), "TOOL_ACTION")).not.toThrow();
  });

  it("no acredita ahorro fantasma: solo cae lo que no cabe en el presupuesto", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const r = sel.select("lee el fichero", catalogoReal(55), "SINGLE_RETRIEVAL");
    // 55 − 8 = 47 por presupuesto. Nunca las 55, que era el ahorro inventado.
    expect(r.droppedIds).toHaveLength(47);
    expect(r.reason).toContain("intents");
  });

  it("el conjunto de un catálogo sin tipar es ESTABLE: no depende de la pregunta", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const cat = catalogoReal(55);
    const a = sel.select("lee el fichero", cat, "SINGLE_RETRIEVAL");
    const b = sel.select("otra pregunta completamente distinta", cat, "SINGLE_RETRIEVAL");
    expect(a.tools.map((t) => t.id)).toEqual(b.tools.map((t) => t.id));
    expect(a.setIsStable).toBe(true);
    expect(b.setIsStable).toBe(true);
  });

  it("un catálogo MEDIO tipado sigue podando: la verja solo salta si NO hay señal", () => {
    const mixto = [tipada("leer", ["leer fichero"], "read"), ...catalogoReal(3)];
    const sel = new ToolSelector({ maxTools: 8 });
    const r = sel.select("leer fichero", mixto, "SINGLE_RETRIEVAL");
    expect(r.reason).not.toContain("no hay señal");
  });
});

describe("congelación del conjunto por clave", () => {
  const catalogo = [
    tipada("leer", ["leer fichero"], "read"),
    tipada("buscar", ["buscar texto"], "read"),
    tipada("listar", ["listar carpeta"], "read"),
    tipada("medir", ["medir tamaño"], "read"),
  ];

  it("sin clave NO congela: el comportamiento anterior se conserva intacto", () => {
    const sel = new ToolSelector({ maxTools: 2, learningTurns: 1 });
    const a = sel.select("leer fichero", catalogo, "SINGLE_RETRIEVAL");
    const b = sel.select("buscar texto", catalogo, "SINGLE_RETRIEVAL");
    expect(a.tools.map((t) => t.id)).not.toEqual(b.tools.map((t) => t.id));
  });

  it("con clave, tras los turnos de aprendizaje el conjunto deja de moverse", () => {
    const sel = new ToolSelector({ maxTools: 4, learningTurns: 2, freezer: new InMemoryToolSetFreezer() });
    sel.select("leer fichero", catalogo, "SINGLE_RETRIEVAL", "k");
    sel.select("buscar texto", catalogo, "SINGLE_RETRIEVAL", "k");
    const tercera = sel.select("medir tamaño", catalogo, "SINGLE_RETRIEVAL", "k");
    const cuarta = sel.select("listar carpeta", catalogo, "SINGLE_RETRIEVAL", "k");
    expect(tercera.setIsStable).toBe(true);
    expect(tercera.reason).toContain("frozen tool set");
    expect(cuarta.tools.map((t) => t.id)).toEqual(tercera.tools.map((t) => t.id));
  });

  it("la congelación devuelve setIsStable=true, que es LO QUE SALVA LA CACHÉ DE PREFIJO", () => {
    const sel = new ToolSelector({ maxTools: 2, learningTurns: 1 });
    sel.select("leer fichero", catalogo, "SINGLE_RETRIEVAL", "k2");
    const congelada = sel.select("buscar texto", catalogo, "SINGLE_RETRIEVAL", "k2");
    expect(congelada.setIsStable).toBe(true);
  });

  it("claves distintas no se pisan (una sesión no hereda el conjunto de otra)", () => {
    const sel = new ToolSelector({ maxTools: 1, learningTurns: 1 });
    sel.select("leer fichero", catalogo, "SINGLE_RETRIEVAL", "sesionA");
    sel.select("medir tamaño", catalogo, "SINGLE_RETRIEVAL", "sesionB");
    const a = sel.select("da igual", catalogo, "SINGLE_RETRIEVAL", "sesionA");
    const b = sel.select("da igual", catalogo, "SINGLE_RETRIEVAL", "sesionB");
    expect(a.tools.map((t) => t.id)).not.toEqual(b.tools.map((t) => t.id));
  });

  it("el aprendizaje ACUMULA: el conjunto congelado cubre lo elegido en los primeros turnos", () => {
    const sel = new ToolSelector({ maxTools: 4, learningTurns: 2 });
    sel.select("leer fichero", catalogo, "SINGLE_RETRIEVAL", "k3");
    sel.select("buscar texto", catalogo, "SINGLE_RETRIEVAL", "k3");
    const congelada = sel.select("cualquier cosa", catalogo, "SINGLE_RETRIEVAL", "k3");
    const ids = congelada.tools.map((t) => t.id);
    expect(ids).toContain("leer");
    expect(ids).toContain("buscar");
  });
});
