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

  /**
   * La rebaja de TTL es AHORRO, y es gratis (CanalComunitario la concede sin clave).
   * Con la frase de la nube delante, la siguiente se leía como algo que trae la
   * clave de pago: «Con una clave de Savings Cloud ves también… En modelos de
   * Anthropic pasa además…»; en fr «elle fait aussi passer» y en nl «zet hij
   * bovendien» apuntan a «une clé» y a «de sleutel». La nube va la última: detrás
   * de ella no queda ninguna palanca.
   */
  for (const loc of LOCALES) {
    it(`${loc}: la nube cierra el párrafo y ningún ahorro va detrás de «Savings Cloud»`, () => {
      const t = tarjeta(loc);
      const nube = t.search(NUBE);
      const ttl = t.lastIndexOf("TTL");
      expect(ttl, `${loc}: no nombra la rebaja de TTL`).toBeGreaterThanOrEqual(0);
      expect(ttl, `${loc}: la rebaja de TTL va detrás de la frase de la nube`).toBeLessThan(nube);
      const ultimaFrase = t.slice(t.lastIndexOf(". ", nube) + 2);
      expect(ultimaFrase, `${loc}: la frase de la nube no es la última`).toMatch(/^[^.]*Savings[ -]Cloud[^.]*\.$/);
    });
  }

  it("es/en: sin clave se dice lo que hace el gateway — mide en local y lo cuenta al salir", () => {
    const es = tarjeta("es");
    expect(es).toContain("sin ninguna clave de BiVelio");
    // Con la 1.2.4 el resumen al salir también da el gasto a precio de lista y el ahorro por base.
    expect(es).toContain("al salir te dice cuánto ha gastado a precio de lista, cuánto ha ahorrado según su base (medido o estimado), cuántas peticiones ha medido");
    const en = tarjeta("en");
    expect(en).toContain("with no BiVelio key at all");
    expect(en).toContain("on exit tells you what it spent at list price, what it saved by basis (measured or estimated), how many requests it metered");
  });
});

/**
 * 2026-11-19 · A2-14, A2-23 y A2-29 · el resto del P5, en el gateway y la CLI.
 *
 * Sin ninguna clave, `bvsala claude` arrancaba con «TTL tuning ON if your licence
 * includes cache_ttl_tuning; fail-closed», y `bvsala --help` repetía que cada
 * palanca «only takes effect if your organization's license carries its
 * feature». Las dos cosas son falsas sin clave: `CanalComunitario` las concede
 * todas, gratis. Solo con una licencia de organización manda la lista de features
 * de ESA licencia, y entonces el texto lo dice así («your organization's
 * licence»). Las guías de docs/terminales (van dentro del paquete npm) decían
 * además que «la licencia por asiento hace falta igual». La salida de verdad
 * (arranque sin claves y `--help`) la vigila test/gateway-textos-sin-licencia.test.ts;
 * aquí se vigila el fuente, para que el texto viejo no vuelva por otra puerta.
 */
describe("el gateway y la CLI no atan las palancas a una licencia", () => {
  const FUENTES = [
    "gateway/bin.ts",
    "gateway/palanca.ts",
    "gateway/hermano.ts",
    "gateway/esfuerzo.ts",
    "gateway/envoltorios.ts",
    "gateway/doctor.ts",
    "gateway/skill.ts",
  ];
  const GUIAS = readdirSync(join(RAIZ, "docs", "terminales"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/terminales/${f}`);
  /** Las frases viejas: «tu licencia» a secas, la licencia por asiento y el gateway «que factura». */
  const VIEJAS = [
    /if your licen[cs]e includes/i,
    /licen[cs]e carries/i,
    /only takes effect if your organization's licen[cs]e/i,
    /per-seat licen[cs]e/i,
    /licencia por asiento/i,
    /mide y factura/i,
    /el caso que se monetiza/i,
    /lo que factura BV-SALA/i,
    /surcharge was 8\.0% of the bill/i,
    /\bLICENSE §5/,
  ];

  it("están las guías de los terminales (si cambia la carpeta, este bloque no protege nada)", () => {
    expect(GUIAS).toContain("docs/terminales/claude-code.md");
    expect(GUIAS).toContain("docs/terminales/codex.md");
  });

  for (const f of [...FUENTES, ...GUIAS]) {
    it(`${f}: ningún texto ata el ahorro local a una licencia`, () => {
      const t = readFileSync(join(RAIZ, f), "utf8");
      const vistas = VIEJAS.filter((re) => re.test(t)).map(String);
      expect(vistas, f).toEqual([]);
    });
  }

  it("bin.ts pasa a las líneas de arranque si el gateway está en modo comunitario (ya no un `true` fijo)", () => {
    const bin = readFileSync(join(RAIZ, "gateway", "bin.ts"), "utf8");
    expect(bin).not.toContain("`hayClave` es true");
    expect(bin).toMatch(/describirEstadoDeHermano\([^)]*comunidad\)/);
    expect(bin).toMatch(/describirEstadoDeEsfuerzo\([^)]*comunidad\)/);
    expect(bin).toMatch(/describirEstadoDeElision\([\s\S]*?comunidad,?\s*\)/);
  });

  it("gateway/tarifa.ts no describe el corpus de suscripción como una factura de API", () => {
    const t = readFileSync(join(RAIZ, "gateway", "tarifa.ts"), "utf8");
    expect(t).not.toMatch(/Anthropic factura esa escritura/);
    expect(t).not.toMatch(/de\s+(?:\*\s+)?la factura/);
    expect(t).toMatch(/SUSCRIPCIÓN/);
  });
});
