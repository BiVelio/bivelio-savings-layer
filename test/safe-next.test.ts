import { describe, expect, it } from "vitest";

import { safeNextPath } from "../apps/web/app/auth/safe-next";

// El destino `next` de /auth/callback y /auth/refresh llega del query string. Si
// se resuelve sin sanear, cualquiera puede montar un enlace que, tras iniciar
// sesión de verdad en savings.bivelio.com, deja al usuario en un dominio ajeno
// con pinta de haber pasado por nosotros. "evil.com" es solo el marcador
// convencional del atacante en este tipo de pruebas: no es un dominio nuestro y
// aquí nunca se hace ninguna petición contra él.
describe("safeNextPath (guarda de redirección abierta, CWE-601)", () => {
  it("respeta una ruta relativa legítima del mismo origen", () => {
    expect(safeNextPath("/dashboard/install")).toBe("/dashboard/install");
    expect(safeNextPath("/dashboard?tab=1")).toBe("/dashboard?tab=1");
    expect(safeNextPath("/dashboard/verify#paso2")).toBe("/dashboard/verify#paso2");
  });

  it("cae a /dashboard con cualquier variante fuera de origen", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "@evil.com",
      "https://evil.com",
      "\\\\evil.com",
      "http://evil.com/dashboard",
    ]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
    }
  });

  it("cae a /dashboard con entrada nula, vacía o sin barra inicial", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
    expect(safeNextPath("dashboard")).toBe("/dashboard");
  });

  it("resuelve la ruta saneada contra el origen de confianza sin escapar", () => {
    const origin = "https://savings.bivelio.com";
    expect(new URL(safeNextPath("//evil.com"), origin).href).toBe(
      "https://savings.bivelio.com/dashboard",
    );
    expect(new URL(safeNextPath("/dashboard/install"), origin).href).toBe(
      "https://savings.bivelio.com/dashboard/install",
    );
  });

  it("cae a /dashboard con caracteres de control que el parser elimina", () => {
    // El parser WHATWG borra tabulador (9), LF (10) y CR (13) ANTES de resolver,
    // así que "/<ctrl>/evil.com" esquivaba una guarda de barra inicial y acababa
    // en una URL relativa al protocolo fuera de origen. Era el caso que la
    // comprobación de cadena anterior no cubría.
    const origin = "https://savings.bivelio.com";
    for (const code of [9, 10, 13]) {
      const bad = "/" + String.fromCharCode(code) + "/evil.com";
      expect(safeNextPath(bad)).toBe("/dashboard");
      expect(new URL(safeNextPath(bad), origin).origin).toBe(origin);
    }
  });

  it("cae a /dashboard cuando el colapso de `..` deja una ruta relativa al protocolo", () => {
    // "/..//evil.com" se queda en el origen centinela (pathname "//evil.com"),
    // pero quien llama vuelve a resolver esa cadena contra el origen real, donde
    // el "//" inicial pasa a ser un host ajeno.
    const origin = "https://savings.bivelio.com";
    // El segundo vector es la forma porcentual que Next devuelve ya decodificada
    // (?next=%2F..%2F%2Fevil.com -> /..//evil.com).
    for (const bad of ["/..//evil.com", decodeURIComponent("%2F..%2F%2Fevil.com")]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
      expect(new URL(safeNextPath(bad), origin).origin).toBe(origin);
    }
  });
});
