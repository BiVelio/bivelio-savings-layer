import { describe, expect, it } from "vitest";

import { DOMINIOS_DESECHABLES, FUENTE_DESECHABLES } from "./dominios-desechables";
import { esCorreoDesechable } from "./medir";

/**
 * Los correos desechables que el alta Medir rechaza (decisión del dueño,
 * 2026-09-29). La lista es la pública de disposable-email-domains, INCRUSTADA
 * con su commit y su fecha: estos tests fijan que es la que dice la cabecera y
 * que el alta no se la salta con un subdominio ni con mayúsculas.
 */
describe("la lista incrustada", () => {
  const dominios = DOMINIOS_DESECHABLES.split("\n").filter((l) => l.length > 0);

  it("es la que declara su cabecera: fuente, commit fijado, fecha y recuento", () => {
    expect(FUENTE_DESECHABLES.repositorio).toBe("https://github.com/disposable-email-domains/disposable-email-domains");
    expect(FUENTE_DESECHABLES.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(FUENTE_DESECHABLES.fecha).toBe("2026-09-29");
    expect(FUENTE_DESECHABLES.licencia).toBe("CC0-1.0");
    expect(dominios).toHaveLength(FUENTE_DESECHABLES.dominios);
  });

  it("un dominio por línea, en minúsculas y sin repetidos", () => {
    expect(dominios.every((d) => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(d))).toBe(true);
    expect(new Set(dominios).size).toBe(dominios.length);
  });

  it("trae los clásicos, y ningún proveedor de correo permanente", () => {
    for (const d of ["mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com"]) expect(dominios).toContain(d);
    for (const d of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "bivelio.com"]) {
      expect(dominios).not.toContain(d);
    }
  });
});

describe("esCorreoDesechable", () => {
  it("desechable, sin importar mayúsculas ni espacios", () => {
    expect(esCorreoDesechable("ana@mailinator.com")).toBe(true);
    expect(esCorreoDesechable("  Ana@MAILINATOR.com ")).toBe(true);
  });

  it("un SUBDOMINIO de un desechable también lo es (no se salta con x.mailinator.com)", () => {
    expect(esCorreoDesechable("ana@abc.mailinator.com")).toBe(true);
    expect(esCorreoDesechable("ana@mailinator.com.")).toBe(true);
  });

  it("los permanentes pasan, y un dominio que solo CONTIENE el nombre no es el desechable", () => {
    expect(esCorreoDesechable("ana@gmail.com")).toBe(false);
    expect(esCorreoDesechable("ana@acme.io")).toBe(false);
    expect(esCorreoDesechable("ana@mailinator-acme-corp.com")).toBe(false);
  });

  it("sin correo o sin dominio: no se juzga aquí (lo corta la verificación)", () => {
    expect(esCorreoDesechable(null)).toBe(false);
    expect(esCorreoDesechable("sin-arroba")).toBe(false);
  });
});
