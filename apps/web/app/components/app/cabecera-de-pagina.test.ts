import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { partirTitular } from "./CabeceraDePagina";

/**
 * EL MARCADOR VA DETRÁS DE LA ÚLTIMA PALABRA DEL TITULAR, SIN SU PUNTUACIÓN
 * FINAL, y se calcula: ningún catálogo lo lleva escrito. Esto lo fija con
 * títulos de verdad de los doce idiomas y con los bordes que lo romperían.
 */
describe("partirTitular", () => {
  const marca = (t: string) => {
    const p = partirTitular(t);
    expect(p.antes + p.marcada + p.despues).toBe(t);
    return p.marcada;
  };

  it("marca la última palabra", () => {
    expect(marca("Tu cuenta de BiVelio")).toBe("BiVelio");
    expect(marca("Tu medidor")).toBe("medidor");
  });

  it("deja fuera la puntuación final, también con el espacio francés", () => {
    expect(marca("Tu medidor.")).toBe("medidor");
    expect(marca("¿Dónde se instala el ahorro?")).toBe("ahorro");
    expect(marca("Prêt ?")).toBe("Prêt");
    expect(marca("«Medido en cada llamada»")).toBe("llamada");
    expect(marca("Cómo funciona…")).toBe("funciona");
  });

  it("deja fuera la apertura pegada a la palabra", () => {
    expect(marca("¿Ahorro?")).toBe("Ahorro");
    expect(marca("Hola (mundo)")).toBe("mundo");
  });

  it("un título de una palabra se marca entero; uno sin letras, nada", () => {
    expect(marca("Prueba")).toBe("Prueba");
    expect(marca("—")).toBe("");
    expect(marca("")).toBe("");
  });

  it("vale en los doce catálogos para todos los títulos de página del panel", () => {
    const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];
    for (const l of LOCALES) {
      const m = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../messages/${l}.json`, import.meta.url)), "utf8"));
      for (const clave of ["account", "install", "proof", "verify", "extracto", "equipo"]) {
        const titulo = m.dashboard?.[clave]?.title;
        if (typeof titulo !== "string") continue;
        expect(marca(titulo), `${l} dashboard.${clave}.title`).not.toBe("");
      }
    }
  });
});
