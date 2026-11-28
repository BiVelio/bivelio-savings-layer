import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { cuentaCompartidaConLaSuite } from "./cuenta-compartida";

/**
 * Las cinco frases que prometen «la misma cuenta que en Shield/Privacy» o «una
 * cuenta para toda la suite» solo mientras sea verdad (BVSALA_CUENTA_PROPIA,
 * apagado por defecto). La revisión de #632 encontró dos que se habían
 * escapado (las entradillas de entrada y alta): por eso aquí se barren TODOS
 * los mensajes en busca de la suite y de Shield, no solo las claves conocidas.
 */

const WEB = new URL("../../", import.meta.url);
const leer = (f: string) => readFileSync(new URL(f, WEB), "utf8");
const IDIOMAS = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];

/**
 * Las claves que prometen la cuenta compartida y lo que se pinta en su lugar con
 * el interruptor encendido: su variante `…SinSuite`, o nada (`null`).
 */
const LAS_PROMESAS: Record<string, string | null> = {
  "auth.loginSubtitle": "auth.loginSubtitleSinSuite",
  "auth.signupSubtitle": "auth.signupSubtitleSinSuite",
  "auth.signupSsoNote": null,
  "dashboard.account.intro": null,
  "dashboard.accountPlanStrip.personalNote": "dashboard.accountPlanStrip.personalNoteSinSuite",
};

/**
 * «La suite» (o Shield) en los 12 idiomas, tal como lo dicen hoy las cinco
 * frases. En polaco y turco «paquete» y «suite» son la misma palabra
 * (`pakiet`, `paket`), y el paquete npm también sale en estos textos: por eso
 * allí se buscan las expresiones enteras y no la palabra suelta.
 */
const LA_SUITE = /\bsuite\b|\bsuity\b|süit|całym pakiecie|tüm paket|paketinin tamamı|bộ sản phẩm|Shield/i;

type Arbol = { [k: string]: string | Arbol };
const mensajes = (l: string) => JSON.parse(leer(`messages/${l}.json`)) as Arbol;
function aplanar(o: Arbol, p = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const q = p ? `${p}.${k}` : k;
    if (typeof v === "string") out[q] = v;
    else Object.assign(out, aplanar(v, q));
  }
  return out;
}

describe("cuentaCompartidaConLaSuite", () => {
  it("apagado (hoy): compartida — las frases se ven como siempre", () => {
    expect(cuentaCompartidaConLaSuite({})).toBe(true);
    for (const v of ["", " ", "0", "true", "si"]) expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: v }), v).toBe(true);
  });

  it("encendido solo con «1»", () => {
    expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: "1" })).toBe(false);
    expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: " 1 " })).toBe(false);
  });

  it("las cinco frases preguntan antes de prometer la cuenta compartida (y apagado pintan la de siempre)", () => {
    expect(leer("app/[locale]/login/page.tsx")).toContain(
      '<p className="sub">{cuentaCompartidaConLaSuite() ? t("loginSubtitle") : t("loginSubtitleSinSuite")}</p>',
    );
    const alta = leer("app/[locale]/signup/page.tsx");
    expect(alta).toContain('<p className="sub">{cuentaCompartidaConLaSuite() ? t("signupSubtitle") : t("signupSubtitleSinSuite")}</p>');
    expect(alta).toContain('cuentaCompartidaConLaSuite() ? <p className="acc-nota">{t("signupSsoNote")}</p> : null');
    expect(leer("app/[locale]/dashboard/account/page.tsx")).toContain('entradilla={cuentaCompartidaConLaSuite() ? t("account.intro") : undefined}');
    expect(leer("app/[locale]/dashboard/components/AccountPlanStrip.tsx")).toContain(
      'cuentaCompartidaConLaSuite() ? t("accountPlanStrip.personalNote") : t("accountPlanStrip.personalNoteSinSuite")',
    );
  });

  it("nadie más pide una de las cinco claves: cada una sale UNA vez, la de dentro del interruptor", () => {
    // Por su nombre literal: una clave pedida desde otro namespace (`t("intro")`
    // con `dashboard.account`) no se ve, y «intro» a secas es de muchas tarjetas.
    const CLAVES = /["'](loginSubtitle|signupSubtitle|signupSsoNote|account\.intro|accountPlanStrip\.personalNote|personalNote)["']/g;
    const RAIZ = fileURLToPath(WEB);
    const vistos: Record<string, string[]> = {};
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "messages" || e.name.startsWith(".")) continue;
        const ruta = join(dir, e.name);
        if (e.isDirectory()) recorrer(ruta);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.")) {
          const hallados = [...readFileSync(ruta, "utf8").matchAll(CLAVES)].map((m) => m[1]!);
          if (hallados.length) vistos[relative(RAIZ, ruta).split("\\").join("/")] = hallados;
        }
      }
    };
    recorrer(RAIZ);
    expect(vistos).toEqual({
      "app/[locale]/login/page.tsx": ["loginSubtitle"],
      "app/[locale]/signup/page.tsx": ["signupSubtitle", "signupSsoNote"],
      "app/[locale]/dashboard/account/page.tsx": ["account.intro"],
      "app/[locale]/dashboard/components/AccountPlanStrip.tsx": ["accountPlanStrip.personalNote"],
    });
  });
});

describe("los mensajes: ninguna promesa de la suite se escapa del interruptor", () => {
  it("en y es (de donde salen los demás idiomas): toda clave que hable de la suite o de Shield está en LAS_PROMESAS", () => {
    // Solo en/es: en francés «la suite» también es «lo que sigue» («lisez la
    // suite», «à la suite d'une relecture») y daría falsos positivos.
    for (const l of ["en", "es"]) {
      const sueltas = Object.entries(aplanar(mensajes(l)))
        .filter(([k, v]) => LA_SUITE.test(v) && !(k in LAS_PROMESAS))
        .map(([k]) => k);
      expect(sueltas, `${l}: claves que hablan de la suite o de Shield sin interruptor`).toEqual([]);
    }
  });

  it("en los 12 idiomas, la búsqueda ve las cinco promesas (si no, la comprobación de abajo no probaría nada)", () => {
    for (const l of IDIOMAS) {
      const m = aplanar(mensajes(l));
      for (const k of Object.keys(LAS_PROMESAS)) expect(m[k], `${l}: ${k}`).toMatch(LA_SUITE);
    }
  });

  it("en los 12 idiomas, ninguna variante «sin suite» habla de la suite", () => {
    for (const l of IDIOMAS) {
      const m = aplanar(mensajes(l));
      for (const v of Object.values(LAS_PROMESAS)) {
        if (!v) continue;
        expect(m[v], `${l}: falta ${v}`).toBeTruthy();
        expect(m[v], `${l}: ${v}`).not.toMatch(LA_SUITE);
      }
    }
  });

  it("las variantes salen de la frase de siempre, sin traducir a mano", () => {
    for (const l of IDIOMAS) {
      const m = aplanar(mensajes(l));
      // «Personal»: la primera frase de la de siempre.
      expect(m["dashboard.accountPlanStrip.personalNote"]!.startsWith(m["dashboard.accountPlanStrip.personalNoteSinSuite"]!), l).toBe(true);
      // Entrada: lo que va antes de «, la misma que usas en toda la suite», con punto final.
      const entrada = m["auth.loginSubtitleSinSuite"]!;
      expect(entrada.endsWith("."), l).toBe(true);
      expect(m["auth.loginSubtitle"]!.startsWith(entrada.slice(0, -1)), l).toBe(true);
      expect(entrada.length, l).toBeLessThan(m["auth.loginSubtitle"]!.length);
      // Alta: la entradilla de siempre sin su primera frase («Una cuenta BiVelio para toda la suite.»).
      const alta = m["auth.signupSubtitleSinSuite"]!;
      expect(m["auth.signupSubtitle"]!.endsWith(` ${alta}`), l).toBe(true);
      expect(alta.length, l).toBeGreaterThan(40);
    }
  });
});
