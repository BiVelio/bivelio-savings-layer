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
  it("KineticTitle lleva la frase en un sr-only, no en aria-label", () => {
    const src = leer("./KineticTitle.tsx");
    expect(src).not.toMatch(/aria-label=/);
    expect(src).toMatch(/<span className="sr-only">\{text\}<\/span>/);
    expect(src).toMatch(/aria-hidden="true"/);
  });

  it("el botón de idioma no tapa su texto visible con aria-label", () => {
    const src = leer("./LocaleSwitcher.tsx");
    const boton = src.slice(src.indexOf('className="toggle lang-trigger"'), src.indexOf("</button>"));
    expect(boton).not.toMatch(/aria-label=/);
    expect(boton).toMatch(/<span className="sr-only">\{t\("langAria"\)\}<\/span>/);
    expect(boton).toMatch(/lang-trigger-name/);
  });
});
