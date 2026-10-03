import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * DOS NOMBRES ACCESIBLES QUE LIGHTHOUSE MARCABA EN TODAS LAS PÁGINAS (02-10-2026).
 *
 * - El titular cinético llevaba la frase en `aria-label` sobre un <span> sin
 *   rol: está prohibido (`aria-prohibited-attr`) y los lectores lo ignoran, y
 *   como las palabras sueltas son `aria-hidden`, el h1 se quedaba sin texto.
 * - El selector de idioma tapaba lo que se ve («English EN») con
 *   `aria-label="Change language"` (`label-content-name-mismatch`): el control
 *   por voz no encuentra el botón por lo que el usuario lee en él.
 *
 * El render de verdad lo valida el navegador; aquí se fija la causa.
 */
const leer = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

describe("nombres accesibles", () => {
  // El titular cinético (KineticTitle) se retiró con el héroe nuevo
  // (2026-10-03): el h1 de la portada es texto llano, sin palabras sueltas
  // ocultas, así que el nombre accesible es el propio texto.
  it("el h1 de la portada es texto llano: sin titular cinético ni aria-label", () => {
    const src = leer("../[locale]/page.tsx");
    const h1 = src.slice(src.indexOf("<h1>"), src.indexOf("</h1>"));
    expect(h1).toContain('t("hero.title")');
    expect(h1).not.toMatch(/aria-label=|aria-hidden|KineticTitle/);
  });

  it("el botón de idioma no tapa su texto visible con aria-label", () => {
    const src = leer("./LocaleSwitcher.tsx");
    const boton = src.slice(src.indexOf('className="toggle lang-trigger"'), src.indexOf("</button>"));
    expect(boton).not.toMatch(/aria-label=/);
    expect(boton).toMatch(/<span className="sr-only">\{t\("langAria"\)\}<\/span>/);
    expect(boton).toMatch(/lang-trigger-name/);
  });
});
