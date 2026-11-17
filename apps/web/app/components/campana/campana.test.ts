import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { partirMarca } from "./Marcado";
import { ANCHO_DEL_MOSAICO, casillasDelMosaico } from "./MosaicoDeLlamadas";

/**
 * LA FIRMA DE CAMPAÑA (2026-11-17): el marcador no puede inventar ni perder
 * una letra, cada idioma declara la palabra que marca y el mosaico es el mismo
 * en el servidor y en el navegador.
 */
const RAIZ = join(__dirname, "..", "..", "..");
const IDIOMAS = ["es", "en", "ca", "fr", "de", "it", "pt", "nl", "pl", "tr", "id", "vi"] as const;

describe("partirMarca", () => {
  it("marca la última palabra con su puntuación, como «control.» en la pieza", () => {
    expect(partirMarca("Comprueba cada ahorro.")).toEqual(["Comprueba cada ", "ahorro.", ""]);
    expect(partirMarca("Decide later.")).toEqual(["Decide ", "later.", ""]);
  });

  it("respeta la marca declarada (dos palabras, o a mitad de frase)", () => {
    expect(partirMarca("Eso es Savings Layer.", "Savings Layer")).toEqual(["Eso es ", "Savings Layer.", ""]);
    expect(partirMarca("Kiểm chứng từng khoản tiết kiệm.", "tiết kiệm")).toEqual(["Kiểm chứng từng khoản ", "tiết kiệm.", ""]);
    expect(partirMarca("Her tasarrufu doğrulayın.", "tasarrufu")).toEqual(["Her ", "tasarrufu", " doğrulayın."]);
  });

  it("si la marca no está en el texto, no marca nada (y el texto queda entero)", () => {
    expect(partirMarca("Decide después.", "luego")).toBeNull();
    expect(partirMarca("")).toBeNull();
  });

  it("las tres partes siempre reconstruyen el texto", () => {
    for (const [texto, marca] of [["Mide primero.", undefined], ["C’est ça, Savings Layer.", "Savings Layer"], ["¿Dónde se instala el ahorro?", undefined]] as const) {
      const p = partirMarca(texto, marca);
      expect(p?.join("")).toBe(texto);
    }
  });
});

describe("titleMark en los 12 idiomas", () => {
  for (const l of IDIOMAS) {
    it(`${l}: cada marca está dentro de su acento`, () => {
      const m = JSON.parse(readFileSync(join(RAIZ, "messages", `${l}.json`), "utf8")).landing;
      for (const sec of ["hero", "layer", "closing"] as const) {
        const { titleAccent, titleMark } = m[sec] as { titleAccent: string; titleMark: string };
        expect(titleMark.length).toBeGreaterThan(0);
        expect(titleAccent).toContain(titleMark);
        expect(partirMarca(titleAccent, titleMark)?.join("")).toBe(titleAccent);
      }
    });
  }
});

describe("MosaicoDeLlamadas", () => {
  it("es determinista: la misma semilla pinta las mismas casillas", () => {
    const a = casillasDelMosaico(11, 4);
    const b = casillasDelMosaico(11, 4);
    expect([...a.quietas]).toEqual([...b.quietas]);
    expect(a.encendidas).toEqual(b.encendidas);
    expect([...casillasDelMosaico(12, 4).quietas]).not.toEqual([...a.quietas]);
  });

  it("es barato: pocos trazados, pocas casillas vivas y nada fuera del lienzo", () => {
    const { quietas, encendidas } = casillasDelMosaico(23, 5);
    expect(quietas.size).toBeLessThanOrEqual(20);
    expect(encendidas.length).toBeGreaterThan(0);
    expect(encendidas.length).toBeLessThanOrEqual(40);
    for (const e of encendidas) {
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.x).toBeLessThan(ANCHO_DEL_MOSAICO);
    }
    for (const trazos of quietas.values())
      for (const t of trazos) expect(Number(t.slice(1, t.indexOf(" ")))).toBeGreaterThanOrEqual(0);
  });

  it("solo se mueve sin movimiento reducido", () => {
    const css = readFileSync(join(RAIZ, "app", "globals.css"), "utf8");
    const bloque = css.slice(css.indexOf("/* ==== SLOT FIRMA DE CAMPAÑA ==== */"), css.indexOf("/* ==== FIN SLOT FIRMA DE CAMPAÑA ==== */"));
    // Cada `animation` del bloque vive dentro de un @media (prefers-reduced-motion: no-preference).
    const trozos = bloque.split("@media (prefers-reduced-motion: no-preference)");
    expect(trozos.length).toBeGreaterThan(1);
    expect(trozos[0]).not.toMatch(/animation(-name)?\s*:\s*(?!none)/);
  });
});
