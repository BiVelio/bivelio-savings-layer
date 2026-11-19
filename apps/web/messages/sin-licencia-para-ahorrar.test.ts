/**
 * 2026-11-19 · «solo debemos cobrar si utilizan nuestro CLOUD».
 *
 * El gateway sin clave concede en local todas sus palancas (`CanalComunitario`
 * en gateway/entitlements.ts devuelve `true` para cualquier feature). Ningún texto
 * público puede atar el ahorro local a una licencia PRO: la nube de pago añade el
 * panel, no las palancas. Si alguien vuelve a escribir «con licencia PRO» en
 * cualquier idioma, esta prueba falla.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname);
const RAIZ = join(__dirname, "..", "..", "..");
const LOCALES = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

function cadenas(o: unknown, ruta: string[] = [], fuera: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof o === "string") fuera.push([ruta.join("."), o]);
  else if (Array.isArray(o)) o.forEach((v, i) => cadenas(v, [...ruta, String(i)], fuera));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) cadenas(v, [...ruta, k], fuera);
  return fuera;
}

// «PRO» como plan o licencia, en los 12 idiomas de la web («PROMPT» no cuenta).
const PRO = /\bPRO\b(?!MPT)/;

describe("ahorrar no necesita licencia: solo se cobra la nube", () => {
  it("el código sigue concediendo todas las palancas sin clave", () => {
    const fuente = readFileSync(join(RAIZ, "gateway", "entitlements.ts"), "utf8");
    expect(fuente).toMatch(/class CanalComunitario[\s\S]*?tiene\(\): boolean \{\s*return true;/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: ningún texto de la web pide licencia PRO`, () => {
      const d = JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8"));
      const conPro = cadenas(d).filter(([, v]) => PRO.test(v)).map(([k]) => k);
      expect(conPro, `${loc}: ${conPro.join(", ")}`).toEqual([]);
    });
  }

  it("los README de GitHub/npm y de PyPI y `bvsala doctor` no atan las palancas a una licencia PRO", () => {
    for (const f of ["README.md", "packages/python/README.md", "gateway/doctor.ts"]) {
      const t = readFileSync(join(RAIZ, f), "utf8");
      expect(t, f).not.toMatch(/with a PRO license|PRO-license|levers need a paid plan:/);
    }
  });
});
