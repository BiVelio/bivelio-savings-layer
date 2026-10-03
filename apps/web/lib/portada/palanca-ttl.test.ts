import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PALANCA_TTL } from "./palanca-ttl";

/**
 * LA CIFRA DE LA TARJETA DEL GATEWAY, CONTRA SU INFORME.
 *
 * `palanca-ttl.ts` lleva los números escritos a mano (la portada es ISR y no
 * lee `docs/` en Vercel). Esta verja los busca en el informe del banco de TTL:
 * si el informe cambia o un número de aquí se aparta, rojo. Y vigila lo que la
 * tarjeta promete: la cota inferior publicada nunca por encima de la medida.
 */
const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const informe = readFileSync(join(RAIZ, PALANCA_TTL.informe), "utf8");

/** «0.0249» → «2,49 %», como lo escribe el informe. */
const pct2 = (x: number) => `${(x * 100).toFixed(2).replace(".", ",")} %`;

describe("la cifra de la rebaja de TTL sale del informe del banco", () => {
  it("el informe es el del día que se cita", () => {
    expect(PALANCA_TTL.informe).toContain(PALANCA_TTL.fecha);
    expect(informe).toContain(`medida en neto — ${PALANCA_TTL.fecha}`);
  });

  it("el neto puntual es el del veredicto", () => {
    expect(informe).toContain(`un +${pct2(PALANCA_TTL.neto.point)} de la factura`);
  });

  it("el intervalo es el IC 95 % por SESIÓN, cota a cota", () => {
    const fila = informe.split("\n").find((l) => l.includes("por **sesión**"));
    expect(fila, "la fila del IC por sesión").toBeDefined();
    expect(fila).toContain(`**+${pct2(PALANCA_TTL.neto.lower)} … +${pct2(PALANCA_TTL.neto.upper)}**`);
    expect(informe).toContain("IC 95 % (bootstrap");
    expect(PALANCA_TTL.confianza).toBe(0.95);
  });

  it("las sesiones, las peticiones y los días son los del informe", () => {
    expect(informe).toContain(`**${PALANCA_TTL.sesiones} sesiones del tráfico de Claude Code de una`);
    const miles = PALANCA_TTL.peticiones.toLocaleString("de-DE");
    expect(informe).toContain(`**${miles} peticiones en ${PALANCA_TTL.dias} días**`);
    expect(informe).toContain(`| por **sesión** (${PALANCA_TTL.sesiones} clusters)`);
  });

  it("es NETO, de UNA organización y a precio de LISTA: lo que la tarjeta dice", () => {
    expect(informe).toContain("después de restar");
    expect(informe).toContain("sola organización");
    expect(informe).toContain("precios de lista");
  });

  it("el intervalo excluye el cero y contiene la estimación", () => {
    expect(PALANCA_TTL.neto.lower).toBeGreaterThan(0);
    expect(PALANCA_TTL.neto.lower).toBeLessThan(PALANCA_TTL.neto.point);
    expect(PALANCA_TTL.neto.point).toBeLessThan(PALANCA_TTL.neto.upper);
  });
});
