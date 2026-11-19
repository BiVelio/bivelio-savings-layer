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

/**
 * 2026-11-19 · la tarjeta de Claude Code de /how-it-works (`howItWorks.caseCodeBody`)
 * decía que SIN NINGUNA CLAVE «tu gasto aparece en el panel, token a token». Es
 * falso: el panel es de Savings Cloud. Sin clave, el gateway mide en local con el
 * uso del proveedor y al salir dice cuántas peticiones midió y cuáles no (arreglo
 * G1, gateway/recuento.ts); con una clave de Savings Cloud se ve además en el panel.
 */
describe("sin clave, el gasto de Claude Code no aparece en el panel", () => {
  /** La frase vieja de cada idioma: «sin clave … y tu gasto aparece en el panel». */
  const FRASE_VIEJA: Record<string, string> = {
    ca: "gateway local i la teva despesa apareix al panell",
    de: "lokale Gateway und deine Ausgaben erscheinen im Panel",
    en: "local gateway and your spend shows up in the panel",
    es: "gateway local y tu gasto aparece en el panel",
    fr: "passerelle locale et votre dépense apparaît dans le panneau",
    id: "gateway lokal dan pengeluaran Anda muncul di panel",
    it: "gateway locale e la tua spesa appare nel pannello",
    nl: "lokale gateway en je uitgaven verschijnen in het paneel",
    pl: "lokalną bramkę i Twoje wydatki pojawiają się w panelu",
    pt: "gateway local e o teu gasto aparece no painel",
    tr: "yerel gateway üzerinden başlatır ve harcamanız panelde",
    vi: "gateway cục bộ và chi tiêu của bạn hiện trong bảng điều khiển",
  };
  /** «El panel» en cada idioma, con las dos palabras que usa la web donde las hay. */
  const PANEL: Record<string, RegExp> = {
    ca: /panell|tauler/i,
    de: /Panel|Dashboard/i,
    en: /panel|dashboard/i,
    es: /panel/i,
    fr: /panneau|tableau de bord/i,
    id: /panel|dasbor/i,
    it: /pannello|dashboard/i,
    nl: /paneel|dashboard/i,
    pl: /panel/i,
    pt: /painel/i,
    tr: /panel/i,
    vi: /bảng điều khiển/i,
  };
  const NUBE = /Savings[ -]Cloud/;
  const tarjeta = (loc: string): string =>
    JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8")).howItWorks.caseCodeBody;

  it("están los 12 idiomas (si falta uno, este bloque no lo protege)", () => {
    expect(Object.keys(FRASE_VIEJA).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(PANEL).sort()).toEqual([...LOCALES].sort());
  });

  it("el código sigue diciendo al salir cuántas peticiones midió en local (si esto cambia, hay que reescribir la tarjeta)", () => {
    expect(readFileSync(join(RAIZ, "gateway", "bin.ts"), "utf8")).toContain("resumenDeMedicion(arranque.medicion(), comando)");
    expect(readFileSync(join(RAIZ, "gateway", "recuento.ts"), "utf8")).toContain("request(s) metered with the provider's usage");
  });

  for (const loc of LOCALES) {
    it(`${loc}: la tarjeta de Claude Code solo pone el gasto en el panel con una clave de Savings Cloud`, () => {
      const t = tarjeta(loc);
      expect(t, loc).not.toContain(FRASE_VIEJA[loc]);
      expect(t, loc).toContain("bvsala claude");
      const nube = t.search(NUBE);
      expect(nube, `${loc}: no nombra Savings Cloud`).toBeGreaterThanOrEqual(0);
      // El panel solo aparece DESPUÉS de nombrar la nube: antes, sin clave, no hay panel.
      const panel = t.search(PANEL[loc]!);
      expect(panel, `${loc}: no nombra el panel`).toBeGreaterThan(nube);
    });
  }

  it("es/en: sin clave se dice lo que hace el gateway — mide en local y lo cuenta al salir", () => {
    const es = tarjeta("es");
    expect(es).toContain("sin ninguna clave de BiVelio");
    expect(es).toContain("al salir te dice cuántas peticiones ha medido");
    const en = tarjeta("en");
    expect(en).toContain("with no BiVelio key at all");
    expect(en).toContain("on exit tells you how many requests it metered");
  });
});
