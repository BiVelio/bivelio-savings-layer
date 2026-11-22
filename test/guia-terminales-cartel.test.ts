import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LINEA_MODO_COMUNITARIO } from "../gateway/textos-publicos.js";

/**
 * e2e 1.2.4 · el arranque sin claves imprimía DOS líneas «COMMUNITY MODE»: la
 * de servidor.ts («no BIVELIO_SERVICE_KEY - every request is metered…») y la de
 * bin.ts (LINEA_MODO_COMUNITARIO). La guía de terminales enseña el cartel: debe
 * enseñar UNA, la de bin.ts, y no la que se quita.
 */
describe("docs/terminales/README.md · el cartel de arranque lleva una sola línea COMMUNITY MODE", () => {
  const guia = readFileSync(new URL("../docs/terminales/README.md", import.meta.url), "utf8");
  const inicio = guia.indexOf("On startup it prints");
  const bloque = guia.slice(guia.indexOf("```\n", inicio) + 4, guia.indexOf("\n```", guia.indexOf("```\n", inicio) + 4));

  it("el bloque existe y empieza por la línea de escucha", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(bloque.split("\n")[0]).toMatch(/^\[bvsala gateway\] v1\.2\.x listening on http:\/\/127\.0\.0\.1:8402 → https:\/\/api\.anthropic\.com$/);
  });

  it("una sola línea COMMUNITY MODE, y es LINEA_MODO_COMUNITARIO", () => {
    const comunitarias = bloque.split("\n").filter((l) => l.includes("COMMUNITY MODE"));
    expect(comunitarias).toEqual([`[bvsala gateway] ${LINEA_MODO_COMUNITARIO}`]);
    expect(bloque).not.toContain("no BIVELIO_SERVICE_KEY - every request is metered");
  });
});
