import { describe, it, expect } from "vitest";

import { localeDelNext, safeNextPath } from "./safe-next";

/**
 * El aterrizaje de la conversión de registro depende de estas dos piezas: el
 * locale del `next` decide en qué idioma se abre /signup/success, y el
 * saneado impide que la página exclusiva (o el callback) se convierta en una
 * redirección abierta. La guardia completa de safeNextPath ya tiene su test
 * de origen en bivelio-privacy-gateway; aquí, lo que este repo usa.
 */
describe("localeDelNext", () => {
  const LOCALES = ["en", "es", "ca"] as const;
  it("extrae el locale del primer segmento", () => {
    expect(localeDelNext("/es/dashboard", LOCALES)).toBe("es");
    expect(localeDelNext("/en/signup/success?x=1", LOCALES)).toBe("en");
  });
  it("primer segmento que no es locale → null (el llamante pone el default)", () => {
    expect(localeDelNext("/dashboard", LOCALES)).toBeNull();
    expect(localeDelNext("/", LOCALES)).toBeNull();
    expect(localeDelNext("", LOCALES)).toBeNull();
  });
});

describe("safeNextPath — lo que la página de éxito re-sanea", () => {
  it("un next fabricado fuera del origen cae al dashboard", () => {
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com/x")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
  it("un path propio pasa tal cual", () => {
    expect(safeNextPath("/es/dashboard")).toBe("/es/dashboard");
  });
});
