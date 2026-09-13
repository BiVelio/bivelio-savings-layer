import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GARANTIA_NETA_RATIO, TRAMOS } from "./billing/tarifa";
import { PRECIO_RESPALDO } from "./stripe/pricing";

/**
 * EL README ES LA PÁGINA DE NPM. Es lo primero que lee un cliente, y viaja
 * dentro del tarball: lo que diga ahí tiene que ser lo mismo que dice la web
 * y lo que hace el código. Esta prueba ata las cifras del README a su única
 * fuente (tarifa.ts y el respaldo de precios) y prohíbe las frases que ya
 * tuvimos que retirar una vez: un «hoy no optimiza» cuando la palanca de
 * tarifa va por defecto, y cifras de ahorro sin sello (la única cifra
 * prometida vive en los mensajes de la web, detrás de la verja
 * «prometido ≤ medido» de luz-verde).
 */
const RAIZ = new URL("../../../", import.meta.url);
const readme = readFileSync(fileURLToPath(new URL("README.md", RAIZ)), "utf8");
const terminales = readFileSync(fileURLToPath(new URL("docs/terminales/README.md", RAIZ)), "utf8");

describe("el README que viaja a npm dice lo mismo que el código", () => {
  it("la garantía y los tramos de la comisión son los de tarifa.ts", () => {
    const garantia = Math.round(GARANTIA_NETA_RATIO * 100);
    const max = Math.round(Math.max(...TRAMOS.map((t) => t.tipo)) * 100);
    const min = Math.round(Math.min(...TRAMOS.map((t) => t.tipo)) * 100);
    expect(readme).toContain(`at least ${garantia} % of every euro saved`);
    expect(readme).toContain(`from ${max} % down to ${min} %`);
  });

  it("los precios del README son el respaldo de pricing.ts, en las dos menciones", () => {
    const mes = PRECIO_RESPALDO.monthly.amount / 100;
    const anio = PRECIO_RESPALDO.yearly.amount / 100;
    expect(PRECIO_RESPALDO.monthly.currency).toBe("eur");
    expect(readme.match(new RegExp(`€${mes} / seat / month`, "g"))).toHaveLength(2);
    expect(readme.match(new RegExp(`€${anio} / seat /\\s+year`, "g"))).toHaveLength(2);
  });

  it("el primer mes sin comisión y «solo lo medido» están en el README, como en la web", () => {
    expect(readme).toMatch(/first month carries no commission/i);
    expect(readme).toMatch(/never from estimates/i);
    expect(readme).toMatch(/No free tier and no trial/);
  });

  it("⛔ ni el README ni las guías de terminales dicen que el gateway «no optimiza»: la palanca de tarifa va por defecto con PRO", () => {
    expect(readme).not.toMatch(/does not optimi[sz]e/i);
    expect(terminales).not.toMatch(/no optimiza todav/i);
    expect(readme).toMatch(/cache-write TTL/);
    expect(terminales).toMatch(/TTL de escritura de caché/);
  });

  it("⛔ el README no lleva cifras de ahorro sin sello", () => {
    expect(readme).not.toMatch(/\$330|\$160|\$84/);
    expect(readme).not.toMatch(/≥ ?\d+([.,]\d+)? ?%/);
    expect(readme).not.toMatch(/free in your browser/i);
  });
});
