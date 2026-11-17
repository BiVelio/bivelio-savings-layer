import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { anclaDe } from "./ancla";

describe("anclaDe — el fragmento de la URL no puede tirar la página", () => {
  it("descodifica un ancla normal, con o sin almohadilla", () => {
    expect(anclaDe("#verify")).toBe("verify");
    expect(anclaDe("verify")).toBe("verify");
    expect(anclaDe("#c%C3%B3mo")).toBe("cómo");
    expect(anclaDe("")).toBe("");
    expect(anclaDe("#")).toBe("");
  });

  it("un fragmento malformado es «sin ancla», no una excepción", () => {
    // Los tres que se probaron a mano: /es#%, /en#%E0%A4%A y /es/benchmarks#%.
    for (const roto of ["#%", "#%E0%A4%A", "#%zz", "#a%2", "#%C3"]) {
      expect(() => decodeURIComponent(roto.slice(1))).toThrow(URIError);
      expect(anclaDe(roto)).toBe("");
    }
  });

  it("nadie en el cliente descodifica location.hash por su cuenta", () => {
    for (const f of ["app/components/landing/EnlacesAntiguos.tsx", "app/components/evidencia/CentroDeEvidencia.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), "utf8");
      expect(src, f).not.toMatch(/decodeURIComponent\(/);
      expect(src, f).toMatch(/anclaDe\(window\.location\.hash\)/);
    }
  });
});
