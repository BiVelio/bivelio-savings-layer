import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  REMITENTE_ALERTAS_POR_DEFECTO,
  REMITENTE_POR_DEFECTO,
  RESPUESTAS_POR_DEFECTO,
  esRemitenteValido,
  remitente,
  remitenteDeAlertas,
  responderA,
} from "./remitente";

/**
 * El remitente configurable (independencia de Privacy: Savings con su propia
 * cuenta de Resend). Lo primero que se fija es que SIN variables todo sale
 * exactamente como antes de este cambio.
 */

afterEach(() => vi.restoreAllMocks());

describe("remitente — apagado (hoy)", () => {
  it("sin variables, los valores que estaban escritos en el código", () => {
    expect(REMITENTE_POR_DEFECTO).toBe("BiVelio <no-reply@bivelio.com>");
    expect(RESPUESTAS_POR_DEFECTO).toBe("support@bivelio.com");
    expect(REMITENTE_ALERTAS_POR_DEFECTO).toBe("BiVelio Savings <alertas@bivelio.com>");
    expect(remitente({})).toBe(REMITENTE_POR_DEFECTO);
    expect(responderA({})).toBe(RESPUESTAS_POR_DEFECTO);
    expect(remitenteDeAlertas({})).toBe(REMITENTE_ALERTAS_POR_DEFECTO);
  });

  it("vacías o con espacios cuentan como no puestas", () => {
    const env = { BVSALA_CORREO_REMITENTE: "  ", BVSALA_CORREO_RESPONDER_A: "", BVSALA_CORREO_REMITENTE_ALERTAS: " " };
    expect(remitente(env)).toBe(REMITENTE_POR_DEFECTO);
    expect(responderA(env)).toBe(RESPUESTAS_POR_DEFECTO);
    expect(remitenteDeAlertas(env)).toBe(REMITENTE_ALERTAS_POR_DEFECTO);
  });
});

describe("remitente — encendido", () => {
  it("una dirección o «Nombre <dirección>» se usa tal cual", () => {
    expect(remitente({ BVSALA_CORREO_REMITENTE: "BiVelio Savings <no-reply@correo.savings.bivelio.com>" })).toBe(
      "BiVelio Savings <no-reply@correo.savings.bivelio.com>",
    );
    expect(responderA({ BVSALA_CORREO_RESPONDER_A: "soporte@savings.bivelio.com" })).toBe("soporte@savings.bivelio.com");
  });

  it("las alertas: su variable, si no la general, si no la de siempre", () => {
    expect(remitenteDeAlertas({ BVSALA_CORREO_REMITENTE_ALERTAS: "Alertas <a@x.example>", BVSALA_CORREO_REMITENTE: "b@y.example" })).toBe(
      "Alertas <a@x.example>",
    );
    expect(remitenteDeAlertas({ BVSALA_CORREO_REMITENTE: "b@y.example" })).toBe("b@y.example");
  });

  it("⛔ un valor inválido se ignora con aviso y deja el de siempre", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const malo of [
      "no-reply@bivelio.com\r\nBcc: alguien@fuera.example", // inyección de cabeceras
      "sin-arroba.bivelio.com",
      "Nombre <no-reply@bivelio>", // dominio sin punto
      "a@b.example, c@d.example", // dos direcciones
      "Nombre sin dirección",
      `${"x".repeat(200)}@bivelio.com`,
    ]) {
      expect(esRemitenteValido(malo), malo).toBe(false);
      expect(remitente({ BVSALA_CORREO_REMITENTE: malo }), malo).toBe(REMITENTE_POR_DEFECTO);
    }
    expect(aviso).toHaveBeenCalled();
  });
});

describe("los cuatro sitios que mandan correo usan el remitente configurable", () => {
  const WEB = new URL("../../", import.meta.url);
  it.each([
    ["app/api/auth/correo/route.ts", ["from: remitente()", "reply_to: responderA()"]],
    ["lib/correo/invitacion.ts", ["from: remitente()", "reply_to: responderA()"]],
    ["app/api/contacto/route.ts", ["from: remitente()"]],
    ["lib/observabilidad/alerta.ts", ["from: remitenteDeAlertas()"]],
  ])("%s", (fichero, trozos) => {
    const fuente = readFileSync(new URL(fichero, WEB), "utf8");
    for (const t of trozos) expect(fuente).toContain(t);
    // Ni una dirección de remitente escrita a mano.
    expect(fuente).not.toMatch(/from:\s*["'`]/);
  });
});
