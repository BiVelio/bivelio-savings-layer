import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * La copia pública del gateway dice lo mismo que el binario: open core, arranca
 * sin claves (modo Community), y una clave puesta pero inválida sigue cerrando.
 *
 * Hasta la versión con la verja de licencia, el panel prometía «para medir no hace
 * falta clave de licencia» y ofrecía `bvsala claude` a quien solo usa suscripción;
 * después exigía licencia activa en los 12 idiomas. Con el open core las dos
 * versiones son falsas a la vez: sin claves arranca (Community), con clave mala
 * no. Este test fija las seis cadenas que cambian (§6.12 de la especificación del
 * frente 3) y caza lo que más fácil se escapa en una traducción a mano: un idioma
 * que se quedó con el texto inglés, o con la frase vieja.
 *
 * Mismo cargador que `parity.test.ts`: la paridad de claves, etiquetas y
 * placeholders ya la vigila ese test; aquí solo va el contenido.
 */

const DIR = new URL(".", import.meta.url).pathname;

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

const cargar = (loc: string): Plano =>
  aplanar(JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")));

const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

const GATEWAY_NOTE = "dashboard.installLicensePanel.gatewayNote";
const LANDING_NOTE = "landing.gateway.note";
const CASE_CODE = "howItWorks.caseCodeBody";
const ONLY_CHAT = "dashboard.projectorVerifier.onlyChatBody";
const CX_NOTA = "landing.skill.cxNota";
const STEP2 = "dashboard.installLicensePanel.step2";

/** Las seis claves que cambian con la verja de licencia del gateway. */
const CAMBIADAS = [GATEWAY_NOTE, LANDING_NOTE, CASE_CODE, ONLY_CHAT, CX_NOTA, STEP2] as const;

const en = cargar("en");
const es = cargar("es");

describe("copia pública: el gateway arranca sin claves (Community) y una clave inválida sigue cerrando", () => {
  it("están los 12 locales (si falta alguno, este test no protege nada)", () => {
    expect(LOCALES).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]);
  });

  it("las seis claves existen y no están vacías en los 12 locales", () => {
    const faltan = LOCALES.flatMap((loc) => {
      const d = cargar(loc);
      return CAMBIADAS.filter((k) => !d[k] || d[k]!.trim() === "").map((k) => `${loc}: ${k}`);
    });
    expect(faltan).toEqual([]);
  });

  describe("ningún idioma se quedó con el texto inglés", () => {
    for (const loc of LOCALES.filter((l) => l !== "en")) {
      it(loc, () => {
        const d = cargar(loc);
        expect(CAMBIADAS.filter((k) => d[k] === en[k])).toEqual([]);
      });
    }
  });

  it("en · gatewayNote: open core — arranca sin claves y ya no dice que sin licencia no arranca", () => {
    expect(en[GATEWAY_NOTE]).toMatch(/COMMUNITY/);
    expect(en[GATEWAY_NOTE]).not.toMatch(/does not start without an active license/i);
  });

  it("es · gatewayNote: open core — arranca sin claves (modo Community)", () => {
    expect(es[GATEWAY_NOTE]).toMatch(/modo Community/);
    expect(es[GATEWAY_NOTE]).not.toMatch(/no arranca sin una licencia activa/);
  });

  // A quien solo usa suscripción ya no se le ofrece el gateway: ese tráfico no
  // tiene factura por tokens, así que no acredita ahorro y la licencia por asiento
  // aplica igual. Lo que se le ofrece es el skill, que es gratis.
  it("onlyChatBody no ofrece `bvsala claude` en ningún locale", () => {
    const conOferta = LOCALES.filter((loc) => cargar(loc)[ONLY_CHAT]!.includes("bvsala claude"));
    expect(conOferta).toEqual([]);
  });

  // «El ahorro ahí es la siguiente fase» ya era falso: con PRO, la rebaja de TTL
  // acredita ahorro medido en el tráfico con clave de API.
  it("caseCodeBody ya no anuncia el ahorro como «la siguiente fase»", () => {
    expect(en[CASE_CODE]).not.toContain("next phase");
    expect(es[CASE_CODE]).not.toContain("siguiente fase");
  });
});
