import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LA TARJETA SOCIAL DE «CÓMO FUNCIONA» NO SE CORTA (auditoría m21, 2026-11-21).
 *
 * La factura de ejemplo («$100 → It depends» y «on how much your traffic
 * repeats») iba en la MISMA fila que las tres cajas del diagrama, a su
 * derecha. En 1200 px no cabía: se cortaba («$100 → It depen…») y en alemán
 * se montaba encima de «Anbieter-API». Ahora el panel es una columna: las
 * cajas en una línea y la factura debajo, en dos líneas. Se comprobó a ojo con
 * los doce idiomas (los más largos: de, nl, pl, id, vi).
 *
 * Esto vigila la forma, no los píxeles: si la factura vuelve a la fila de las
 * cajas, o el panel deja de ser una columna, se pone rojo.
 */
const SRC = readFileSync(fileURLToPath(new URL("./opengraph-image.tsx", import.meta.url)), "utf8");

describe("la tarjeta OG de /how-it-works: el diagrama arriba y la factura debajo", () => {
  it("el panel es una columna (cajas encima, factura debajo)", () => {
    expect(SRC).toMatch(/flexDirection: "column",\s*gap: \d+,\s*background: PANEL,/);
  });

  it("la factura va DESPUÉS de cerrar la fila de las cajas, no dentro", () => {
    const ultimaCaja = SRC.indexOf('<Node title={t("nodeApi")} />');
    const factura = SRC.indexOf('t("billWith")');
    const depende = SRC.indexOf('t("billDepends")');
    expect(ultimaCaja).toBeGreaterThan(-1);
    expect(factura).toBeGreaterThan(ultimaCaja);
    expect(depende).toBeGreaterThan(factura);
    // Entre la última caja y la factura se cierra la fila de las cajas.
    expect(SRC.slice(ultimaCaja, factura)).toMatch(/<\/div>\s*<div style=\{\{ display: "flex", flexDirection: "column"/);
  });

  it("el título cabe: una sola fuente más pequeña que antes (66 px se partía en neerlandés)", () => {
    const m = SRC.match(/fontSize: (\d+), fontWeight: 700, letterSpacing: -[\d.]+, lineHeight: 1\.08, color: INK, maxWidth: 1040/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(54);
  });
});
