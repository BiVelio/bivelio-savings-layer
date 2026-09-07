import { describe, it, expect } from "vitest";

import { compararVersiones, parsearVersion, superficieDe } from "./semver";

describe("parsearVersion", () => {
  it("acepta con y sin prefijo de superficie, con y sin sufijo", () => {
    expect(parsearVersion("gateway/0.4.16")).toEqual({ superficie: "gateway", partes: [0, 4, 16] });
    expect(parsearVersion("sdk/0.10.0-beta.1")).toEqual({ superficie: "sdk", partes: [0, 10, 0] });
    expect(parsearVersion("0.4.16")).toEqual({ superficie: null, partes: [0, 4, 16] });
    expect(parsearVersion(" gateway/1.2.3 ")).toEqual({ superficie: "gateway", partes: [1, 2, 3] });
  });

  it("devuelve null (no lanza) ante lo que no casa", () => {
    for (const mal of [
      null,
      undefined,
      "",
      "cli/0.4.16",
      "gateway/0.4",
      "gateway/0.4.16, gateway/0.4.16",
      "gateway/00000.4.16",
      "v0.4.16",
      "gateway/0.4.16-",
    ]) {
      expect(parsearVersion(mal), String(mal)).toBeNull();
    }
  });
});

describe("compararVersiones — numérica, nunca lexicográfica", () => {
  it("0.10.0 > 0.4.16 (la comparación de cadenas dice lo contrario)", () => {
    expect(compararVersiones("0.10.0", "0.4.16")).toBeGreaterThan(0);
    expect("0.10.0" < "0.4.16").toBe(true); // el error que se evita
  });

  it("ordena por mayor, menor y parche", () => {
    expect(compararVersiones("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compararVersiones("0.4.16", "0.4.17")).toBeLessThan(0);
    expect(compararVersiones("0.5.0", "0.4.99")).toBeGreaterThan(0);
    expect(compararVersiones("0.4.16", "0.4.16")).toBe(0);
  });

  it("ignora el prefijo de superficie y el sufijo", () => {
    expect(compararVersiones("gateway/0.4.16", "sdk/0.4.16")).toBe(0);
    expect(compararVersiones("0.4.16-beta.1", "0.4.16")).toBe(0);
    expect(compararVersiones("gateway/0.4.17-rc.1", "0.4.16")).toBeGreaterThan(0);
  });

  it("lanza si alguna no casa: quien llama ya la validó", () => {
    expect(() => compararVersiones("cli/0.4.16", "0.4.16")).toThrow(/no válida/);
    expect(() => compararVersiones("0.4.16", "")).toThrow();
  });
});

describe("superficieDe", () => {
  it("devuelve el prefijo o null", () => {
    expect(superficieDe("gateway/0.4.16")).toBe("gateway");
    expect(superficieDe("sdk/0.4.16")).toBe("sdk");
    expect(superficieDe("0.4.16")).toBeNull();
    expect(superficieDe(null)).toBeNull();
    expect(superficieDe(undefined)).toBeNull();
    expect(superficieDe("cli/0.4.16")).toBeNull();
  });
});
