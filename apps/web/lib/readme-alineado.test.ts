import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GARANTIA_NETA_RATIO, TRAMOS } from "./billing/tarifa";
import { PRECIOS_DE_LOS_PLANES } from "./billing/planes";

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

  it("los precios del README son los de planes.ts (Pro y Equipo), en las dos menciones", () => {
    const eur = (c: number) => (c / 100).toLocaleString("en-US");
    const pro = PRECIOS_DE_LOS_PLANES.pro;
    const eq = PRECIOS_DE_LOS_PLANES.equipo;
    expect(pro.monthly.currency).toBe("eur");
    expect(readme.match(new RegExp(`€${eur(pro.monthly.asientoCentimos)} / seat / month`, "g"))).toHaveLength(2);
    expect(readme.match(new RegExp(`€${eur(pro.yearly.asientoCentimos)} / seat /\\s+year`, "g"))).toHaveLength(2);
    expect(readme.match(new RegExp(`€${eur(eq.monthly.fijaCentimos)} / month\\s+with ${eq.monthly.asientosIncluidos} seats included`, "g"))).toHaveLength(2);
    expect(readme).toContain(`€${eur(eq.monthly.asientoCentimos)} per extra seat`);
    expect(readme).toContain(`€${eur(eq.yearly.fijaCentimos)} / year, €${eur(eq.yearly.asientoCentimos)} per extra seat`);
    // La modalidad con comisión (4 €/39 €) está cerrada a clientes nuevos: el README no la anuncia con precio.
    expect(readme).not.toMatch(/€4 \/ seat|€39 \/ seat/);
    expect(readme).toMatch(/closed to new customers/);
  });

  it("el primer mes sin comisión y «solo lo medido» están en el README, como en la web", () => {
    expect(readme).toMatch(/first month carries no commission/i);
    expect(readme).toMatch(/never from estimates/i);
    expect(readme).toMatch(/No trial\./);
    // La única licencia gratuita es Medir, y el README dice qué es y qué NO hace.
    expect(readme).toMatch(/free\s+\*\*Measure\*\* license/);
    expect(readme).toMatch(/\*\*shadow mode\*\*/);
    expect(readme).toMatch(/nothing is served from any cache/);
    expect(readme).toMatch(/never part of any commission/);
    expect(readme).not.toMatch(/No free tier/);
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
