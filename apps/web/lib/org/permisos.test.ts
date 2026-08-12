import { describe, it, expect } from "vitest";

import { puede, rolesConocidos, type Accion } from "./permisos";

/**
 * La tabla de permisos. Se prueba por PROPIEDADES además de por casos, porque lo
 * que hay que garantizar no es "el owner puede X" —eso se puede leer— sino que
 * NADA se conceda por accidente.
 */

const TODAS: Accion[] = [
  "ver_panel",
  "descargar_licencia",
  "gestionar_claves",
  "comprar",
  "gestionar_facturacion",
  "gestionar_miembros",
  "transferir_propiedad",
];

describe("lo desconocido no concede nada", () => {
  // Es la mitad del valor del fichero: un rol nuevo en el `check` de la base que
  // se olvide aquí, una fila con basura, o una diferencia de mayúsculas.
  const raros = [null, undefined, "", "Owner", "OWNER", "root", "superadmin", "propietario", " owner"];
  for (const rol of raros) {
    it(`${JSON.stringify(rol)} no puede NADA`, () => {
      for (const a of TODAS) expect(puede(rol, a)).toBe(false);
    });
  }

  it("una acción inventada tampoco se concede a nadie", () => {
    for (const rol of rolesConocidos()) {
      expect(puede(rol, "borrar_la_empresa" as Accion)).toBe(false);
    }
  });

  it("no se hereda nada del prototipo de Object", () => {
    // `TABLA[rol]` sobre un objeto literal: sin esta comprobación, `"constructor"`
    // o `"toString"` devolverían una función y `.includes` reventaría o —peor—
    // algún día concedería.
    for (const rol of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      for (const a of TODAS) expect(puede(rol, a)).toBe(false);
    }
  });
});

describe("la separación que hace falta para vender", () => {
  it("⛔ billing NO puede tocar credenciales", () => {
    // El criterio entero: quien lleva las facturas de una empresa no tiene por qué
    // poder descargarse la credencial de producción. Son dos trabajos distintos.
    expect(puede("billing", "descargar_licencia")).toBe(false);
    expect(puede("billing", "gestionar_claves")).toBe(false);
    // Pero sí lo suyo.
    expect(puede("billing", "gestionar_facturacion")).toBe(true);
    expect(puede("billing", "comprar")).toBe(true);
  });

  it("⛔ member solo ve el panel", () => {
    // `role` tiene `default 'member'` en el esquema, así que esto es lo que le toca
    // a quien entre por un camino que todavía no exista. Un valor por defecto tiene
    // que ser el que menos daño haga.
    expect(puede("member", "ver_panel")).toBe(true);
    for (const a of TODAS.filter((x) => x !== "ver_panel")) {
      expect(puede("member", a)).toBe(false);
    }
  });

  it("⛔ solo el dueño transfiere la propiedad", () => {
    // Si un admin pudiera, podría quedarse con la organización de su empresa.
    expect(puede("owner", "transferir_propiedad")).toBe(true);
    for (const rol of ["admin", "billing", "member"]) {
      expect(puede(rol, "transferir_propiedad")).toBe(false);
    }
  });

  it("el dueño puede todo", () => {
    for (const a of TODAS) expect(puede("owner", a)).toBe(true);
  });

  it("admin es el dueño menos la transferencia, exactamente", () => {
    for (const a of TODAS) {
      expect(puede("admin", a)).toBe(a !== "transferir_propiedad");
    }
  });
});

describe("invariantes de la tabla", () => {
  it("todos los roles del esquema están cubiertos", () => {
    // Los cuatro del `check` de 0001:45. Si se añade uno a la base y no aquí, el
    // fallo cerrado lo deja sin permisos — visible, pero mejor que se note antes.
    expect(rolesConocidos().sort()).toEqual(["admin", "billing", "member", "owner"]);
  });

  it("todo rol conocido puede al menos ver el panel", () => {
    // Un miembro que no puede ni entrar no es un rol, es un usuario expulsado.
    for (const rol of rolesConocidos()) expect(puede(rol, "ver_panel")).toBe(true);
  });

  it("ningún rol salvo owner/admin toca credenciales", () => {
    for (const rol of rolesConocidos()) {
      const esperado = rol === "owner" || rol === "admin";
      expect(puede(rol, "descargar_licencia")).toBe(esperado);
      expect(puede(rol, "gestionar_claves")).toBe(esperado);
    }
  });
});
