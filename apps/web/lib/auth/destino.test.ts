import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

import { CABECERA_DESTINO, conDestino, destinoDeLaPeticion, rutaDeAccesoSinSesion } from "./destino";

/**
 * El enlace de compra con el código pre-aplicado tiene que sobrevivir a una
 * sesión ausente: pedir /es/dashboard/account?codigo=X sin sesión, pasar por el
 * acceso y aterrizar en ESA url, con su consulta. Antes se perdía dos veces.
 */
const ENLACE = "/es/dashboard/account?codigo=PROBADORES-SEPT";

describe("conDestino — el middleware pone la ruta pedida en la cabecera", () => {
  it("ruta + consulta, tal cual las pidió el navegador", () => {
    const r = conDestino(new NextRequest(`https://savings.bivelio.com${ENLACE}`, { headers: { cookie: "a=1" } }));
    expect(r.headers.get(CABECERA_DESTINO)).toBe(ENLACE);
    expect(r.headers.get("cookie")).toBe("a=1");
    expect(r.url).toBe(`https://savings.bivelio.com${ENLACE}`);
    expect(r.method).toBe("GET");
  });
  it("una cabecera que trajera el cliente se sobrescribe: no se confía en ella", () => {
    const r = conDestino(new NextRequest("https://savings.bivelio.com/es/dashboard", { headers: { [CABECERA_DESTINO]: "//evil.com" } }));
    expect(r.headers.get(CABECERA_DESTINO)).toBe("/es/dashboard");
  });
});

describe("destinoDeLaPeticion — la guardia del panel lee la cabecera", () => {
  it("devuelve la ruta pedida con su consulta", () => {
    expect(destinoDeLaPeticion(new Headers({ [CABECERA_DESTINO]: ENLACE }))).toBe(ENLACE);
  });
  it("sin cabecera, o con una fuera del origen, cae al panel (misma verja que ?next=)", () => {
    expect(destinoDeLaPeticion(new Headers())).toBe("/dashboard");
    expect(destinoDeLaPeticion(new Headers({ [CABECERA_DESTINO]: "//evil.com/x" }))).toBe("/dashboard");
    expect(destinoDeLaPeticion(new Headers({ [CABECERA_DESTINO]: "https://evil.com" }))).toBe("/dashboard");
  });
});

describe("rutaDeAccesoSinSesion — el refresco sin sesión no tira el destino", () => {
  it("lleva el destino en ?next=, codificado, para que AuthForm vuelva a él", () => {
    expect(rutaDeAccesoSinSesion(ENLACE)).toBe(`/login?next=${encodeURIComponent(ENLACE)}`);
    expect(decodeURIComponent(rutaDeAccesoSinSesion(ENLACE).split("next=")[1] ?? "")).toBe(ENLACE);
  });
  it("el destino por defecto no se arrastra: /login a secas", () => {
    expect(rutaDeAccesoSinSesion("/dashboard")).toBe("/login");
  });
  it("un destino fabricado fuera del origen se sanea antes de viajar", () => {
    expect(rutaDeAccesoSinSesion("//evil.com")).toBe("/login");
  });
});
