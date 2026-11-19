import { describe, it, expect } from "vitest";

import { CATALOGO, buscarPorModelo, claveDeCatalogo, clavesPorLongitud, precioDeLista } from "../src/pricing/catalogo.js";

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

/**
 * N4 (auditoría del 2026-11-19) · UN ID CON VARIANTE O CON OTRO APELLIDO NO
 * HEREDA EL PRECIO DE UN MODELO MAYOR.
 *
 * `gpt-4o-mini:free` no pasaba el separador de `gpt-4o-mini`, el bucle seguía y
 * casaba `gpt-4o` (16 veces su precio, sin aviso). `gemini-2.5-flash-lite`
 * heredaba la fila de `gemini-2.5-flash`. Un id sin precio se declara; uno con
 * el precio de otro modelo, no.
 */
describe("⛔ N4 · ni las variantes «:x» ni los parientes heredan", () => {
  it("para TODA clave K, K:variante da la fila de K o nada — nunca la de otra clave", () => {
    for (const k of Object.keys(CATALOGO)) {
      for (const variante of ["free", "flex", "extended", "thinking", "nitro", "online", "x"]) {
        for (const id of [`${k}:${variante}`, `openrouter/${k}:${variante}`, `${k}-latest:${variante}`]) {
          const fila = precio(id);
          expect(fila === undefined || fila === CATALOGO[k], id).toBe(true);
          // Y hoy, en concreto, nada: la variante tiene otro precio.
          expect(claveDeCatalogo(id), id).toBeUndefined();
          expect(precioDeLista(id), id).toBeUndefined();
        }
      }
    }
  });

  it.each([
    "gpt-4o-mini:free",
    "openai/gpt-4o-mini:free",
    "gpt-4.1-nano:extended",
    "gpt-5-mini:flex",
    "claude-sonnet-4-5:thinking",
    "llama3.2:latest",
  ])("«%s» no tiene precio de lista", (id) => {
    expect(precioDeLista(id)).toBeUndefined();
  });

  it("gemini-2.5-flash-lite tiene hoy fila PROPIA (N5, 2026-11-19), que no es la de su pariente", () => {
    // El caso que abrió N4: el id ya no se resuelve a la fila de gemini-2.5-flash,
    // ni heredándola ni a falta de la suya. El «-lite» sin fila sigue en la tabla
    // de abajo con otra versión de la familia.
    expect(precio("gemini-2.5-flash-lite")).toBe(CATALOGO["gemini-2.5-flash-lite"]);
    expect(precio("gemini-2.5-flash-lite")).not.toEqual(CATALOGO["gemini-2.5-flash"]);
  });

  it.each([
    ["gemini-3.8-flash-lite", "gemini-3.8-flash"],
    ["gemini-2.5-flash-image", "gemini-2.5-flash"],
    ["gpt-4o-mini-tts", "gpt-4o-mini"],
    ["gpt-4o-mini-transcribe", "gpt-4o-mini"],
    ["gpt-4o-mini-realtime-preview", "gpt-4o-mini"],
    ["gpt-4o-realtime-preview", "gpt-4o"],
    ["gpt-4o-audio-preview", "gpt-4o"],
    ["gpt-4o-minimal", "gpt-4o"],
  ])("«%s» no hereda la fila de «%s»", (id, pariente) => {
    expect(CATALOGO[id]).toBeUndefined();
    expect(CATALOGO[pariente]).toBeDefined();
    expect(precio(id)).toBeUndefined();
    expect(precioDeLista(`vendor/${id}`)).toBeUndefined();
  });

  it("ningún id «clave-palabra» hereda de una clave distinta de la más larga que lo prefija", () => {
    const palabras = ["lite", "mini", "nano", "pro", "turbo", "flash", "image", "tts", "audio", "search", "codex", "max", "high"];
    for (const k of Object.keys(CATALOGO)) {
      for (const palabra of palabras) {
        const id = `${k}-${palabra}`;
        if (id in CATALOGO) continue;
        expect(precio(id), id).toBeUndefined();
      }
    }
  });

  it("los alias del MISMO modelo siguen heredando", () => {
    expect(precio("gpt-4o-mini-2024-07-18")).toBe(CATALOGO["gpt-4o-mini"]);
    expect(precio("openai/gpt-4o-2024-08-06")).toBe(CATALOGO["gpt-4o"]);
    expect(precio("claude-sonnet-4-5-20250929")).toBe(CATALOGO["claude-sonnet-4-5"]);
    expect(precio("claude-3-5-sonnet-latest")).toBe(CATALOGO["claude-3-5-sonnet"]);
    expect(precio("gpt-5-chat-latest")).toBe(CATALOGO["gpt-5"]);
    expect(precio("gemini-2.5-flash-preview-05-20")).toBe(CATALOGO["gemini-2.5-flash"]);
    expect(precio("gemini-2.5-pro-preview")).toBe(CATALOGO["gemini-2.5-pro"]);
    expect(precio("gemini-2.5-pro-exp-0827")).toBe(CATALOGO["gemini-2.5-pro"]);
  });

  it("con fila exacta declarada, un id con «:» sí tiene precio (el del cliente manda)", () => {
    const propio = { "modelo-inventado:free": { inputPer1k: 0, outputPer1k: 0 } };
    expect(buscarPorModelo(propio, clavesPorLongitud(propio), "vendor/modelo-inventado:free")).toBe(
      propio["modelo-inventado:free"],
    );
  });
});
