import { describe, it, expect } from "vitest";

import { CATALOGO, buscarPorModelo, clavesPorLongitud } from "../src/pricing/catalogo.js";

const CLAVES = clavesPorLongitud(CATALOGO);
const precio = (m: string) => buscarPorModelo(CATALOGO, CLAVES, m);

/**
 * UNA VERSIÓN MENOR NO HEREDA EL PRECIO DE LA MAYOR; UNA INSTANTÁNEA FECHADA SÍ.
 *
 * El catálogo enumera los modelos que existen hoy, pero la herencia por prefijo
 * es lo que decide qué pasa con los que salgan mañana. Y ahí la regla laxa
 * mentía: `claude-opus-4-9` heredaba el 0,015/0,075 de `claude-opus-4`, el
 * TRIPLE del precio real de la familia 4.5. Un precio inflado no se cancela en el
 * cociente —el ahorro en euros sale 3x y la comisión se calcula sobre euros—, así
 * que un precio EQUIVOCADO es peor que ninguno: el respaldo ilustrativo al menos
 * se declara.
 *
 * El corte no es «exige un año siempre», que era la regla del intento anterior y
 * rompía los alias `-latest` que hoy heredan bien. Es qué hay tras el separador:
 * letra = mismo modelo con otro nombre; dígito = fecha (hereda) o versión (no).
 */
describe("herencia de precio por prefijo", () => {
  it("una instantánea FECHADA hereda de su modelo", () => {
    expect(precio("claude-sonnet-4-5-20250929")?.inputPer1k).toBe(CATALOGO["claude-sonnet-4-5"]!.inputPer1k);
    expect(precio("gpt-4o-2024-08-06")?.inputPer1k).toBe(CATALOGO["gpt-4o"]!.inputPer1k);
  });

  it("un alias -latest hereda: es el mismo modelo con otro nombre", () => {
    expect(precio("claude-3-5-sonnet-latest")?.inputPer1k).toBe(CATALOGO["claude-3-5-sonnet"]!.inputPer1k);
    expect(precio("gpt-5-chat-latest")).toBeDefined();
  });

  it("una VERSIÓN MENOR que no está en el catálogo NO hereda de la mayor", () => {
    // El día que exista, su precio se añade. Hasta entonces, respaldo declarado
    // — nunca el de `claude-opus-4`, que es el triple.
    expect(CATALOGO["claude-opus-4-9"]).toBeUndefined();
    expect(precio("claude-opus-4-9")).toBeUndefined();
    expect(CATALOGO["claude-opus-4"]!.inputPer1k).toBe(0.015);
  });

  it("una variante de contexto tampoco hereda", () => {
    expect(precio("gpt-4-32k")).toBeUndefined();
  });

  it("el corte por separador sigue en pie: gpt-4 no casa gpt-4o", () => {
    // gpt-4o cuesta doce veces menos que gpt-4; casarlos fue el fallo original
    // que el corte por separador vino a cerrar, y sigue cerrado.
    expect(precio("gpt-4o")!.inputPer1k).not.toBe(CATALOGO["gpt-4"]!.inputPer1k);
  });

  it("todo lo que el catálogo enumera se resuelve exacto, sin pasar por la herencia", () => {
    for (const clave of Object.keys(CATALOGO)) {
      expect(precio(clave)).toBe(CATALOGO[clave]);
    }
  });
});
