import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LIMITES_MEDIR } from "@/lib/license/medir-publico";
import { BANCO_EN_VIVO } from "@/lib/portada/banco-en-vivo";
import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";

/**
 * 2026-11-21 · LAS CIFRAS DICEN LO MISMO EN TODAS PARTES (lanzamiento del 22-11).
 *
 * Cada cifra de producto tiene UNA fuente en el código, y el README de npm, la
 * página de PyPI, el `--help` del gateway y la web la repiten. Este test ata
 * las que no tenían verja:
 *
 *   · 72 h. Con clave y `licenseServerUrl`, el SDK que pasa 72 h sin respuesta
 *     de savings.bivelio.com falla cerrado con `LicenseError`
 *     (`DEFAULT_MAX_STALENESS_SECONDS` en src/pipeline/create.ts). La nota final
 *     del panel de instalación decía «nunca inutiliza tu producción si no
 *     podemos conectarnos», en los 12 idiomas: falso pasadas las 72 h.
 *   · Los topes de Measure (5 asientos, 20 000 peticiones al día) del README.
 *   · El 2,49 % del `--help` y los 31,50 % / 75,08 % del README, contra las
 *     cifras que pinta la portada.
 *   · Node 20.19 y Python 3.10, en package.json, pyproject, los dos README y el
 *     panel.
 */

const RAIZ = new URL("../../../", import.meta.url);
const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, RAIZ)), "utf8");
const DIR = new URL(".", import.meta.url).pathname;

const readme = leer("README.md");
const readmePypi = leer("packages/python/README.md");
const ayuda = leer("gateway/bin.ts");
const crear = leer("src/pipeline/create.ts");

type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>(
      (acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)),
      {},
    );
  }
  return { [p]: String(o) };
}
const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();
const cargar = (loc: string): Plano => aplanar(JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")));

describe("las cifras de producto dicen lo mismo en el paquete, la web y el código", () => {
  it("72 h sin respuesta con licenseServerUrl → LicenseError: el código, el README y el panel en los 12 idiomas", () => {
    const m = crear.match(/DEFAULT_MAX_STALENESS_SECONDS = (\d+) \* 3600/);
    expect(m?.[1]).toBe("72");
    expect(readme).toMatch(/goes 72 hours without an answer from savings\.bivelio\.com fails closed with `LicenseError`/);
    const mal = LOCALES.filter((loc) => {
      const nota = cargar(loc)["dashboard.installLicensePanel.finalNote"] ?? "";
      return !nota.includes("72") || !nota.includes("<code>LicenseError</code>");
    });
    expect(mal).toEqual([]);
    // La frase vieja, en cada idioma: prometía que una caída nuestra nunca para la producción.
    const viejas: Record<string, string> = {
      ca: "mai no inutilitza",
      de: "niemals deine Produktion",
      en: "never bricks",
      es: "nunca inutiliza",
      fr: "ne bloque jamais",
      id: "tidak pernah melumpuhkan",
      it: "non blocca mai",
      nl: "nooit plat",
      pl: "nigdy nie unieruchamia",
      pt: "nunca inutiliza",
      tr: "asla işlevsiz",
      vi: "không bao giờ làm hỏng",
    };
    const conLaVieja = LOCALES.filter((loc) =>
      (cargar(loc)["dashboard.installLicensePanel.finalNote"] ?? "").includes(viejas[loc] ?? "\u0000"),
    );
    expect(conLaVieja).toEqual([]);
  });

  it("los topes de Measure del README son los de LIMITES_MEDIR (su espejo de MEASURE_LIMITS lo fija lib/license/medir.test.ts)", () => {
    const peticiones = LIMITES_MEDIR.peticionesDiarias.toLocaleString("en-US");
    expect(readme).toMatch(new RegExp(`up to ${LIMITES_MEDIR.asientos} seats and ${peticiones}\\s+requests a day`));
  });

  it("el 2,49 % del --help es el neto de la portada (PALANCA_TTL)", () => {
    const neto = (PALANCA_TTL.neto.point * 100).toFixed(2);
    expect(ayuda).toContain(`a net ${neto}% of the list-price bill`);
  });

  it("los 31,50 % y 75,08 % del README redondean a las cifras de la portada (BANCO_EN_VIVO)", () => {
    const cifra = (re: RegExp) => Number(readme.match(re)?.[1]);
    const openai = cifra(/\*\*(\d+\.\d+) %\*\* \(gpt-4o-mini\)/);
    const anthropic = cifra(/\*\*(\d+\.\d+) %\*\* \(claude-sonnet-5/);
    expect(Math.round(openai * 10) / 1000).toBe(BANCO_EN_VIVO.openai.ahorro.point);
    expect(Math.round(anthropic * 10) / 1000).toBe(BANCO_EN_VIVO.anthropic.ahorro.point);
    expect(readmePypi).toContain(`${openai.toFixed(2)} % / ${anthropic.toFixed(2)} %`);
    expect(readme).toMatch(new RegExp(`${Math.round(BANCO_EN_VIVO.repeticiones * 100)} % of them\\s+exact repeats`));
  });

  it("Node 20.19 y Python 3.10: package.json, pyproject, los dos README y el panel", () => {
    const pkg = JSON.parse(leer("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=20.19.0");
    expect(readme).toContain("**Node ≥ 20.19.**");
    expect(readmePypi).toContain("Node.js 20.19 or newer");
    expect(leer("packages/python/pyproject.toml")).toContain('requires-python = ">=3.10"');
    expect(readmePypi).toContain("Python 3.10 or newer");
    expect(cargar("en")["dashboard.installLicensePanel.pythonNote"]).toContain("Python 3.10 or newer");
  });
});
