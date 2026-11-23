import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";

/**
 * LA WEB DICE LO QUE HACE LA 1.2.5, la primera versión en npm y PyPI desde la
 * 1.2.3 (la 1.2.4 no llegó a publicarse). Cada caso es una frase que, tras #610,
 * seguía diciendo menos o algo distinto de lo que hace el paquete construido
 * desde main, y se ata aquí a la fuente que lo hace:
 *   · la FAQ (y su JSON-LD, que es el mismo texto) ataba las 72 h a cualquier
 *     clave; el SDK solo las cuenta con `licenseServerUrl` (src/pipeline/create.ts),
 *     que es como lo deja el panel;
 *   · el resumen al salir de los envoltorios da el gasto a precio de lista y lo
 *     ahorrado por base, measured, by reference y estimated (gateway/recuento.ts);
 *     el panel solo hablaba de peticiones medidas, y «cómo funciona» olvidaba la
 *     base por referencia;
 *   · el cliente de Python dice `npx @bivelio/savings-layer gateway`, la orden que
 *     funciona tras `pip install` (`bvsala` no está en el PATH de quien usa pip);
 *   · el alta de Measure en el panel dice desde qué versión ahorra, como /pricing
 *     y el alta pública.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
type Loc = (typeof LOCALES)[number];

const crudo = (loc: string) => JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8"));
type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>((acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)), {});
  }
  return { [p]: String(o) };
}
const cargar = (loc: string): Plano => aplanar(crudo(loc));
const RAIZ = new URL("../../../", import.meta.url);
const delRepo = (rel: string) => readFileSync(fileURLToPath(new URL(rel, RAIZ)), "utf8");

/** «A precio de lista», como lo dice cada idioma en la tarjeta de Claude Code de /how-it-works. */
const PRECIO_DE_LISTA: Record<Loc, string> = {
  ca: "a preu de llista",
  de: "zum Listenpreis",
  en: "at list price",
  es: "a precio de lista",
  fr: "au prix catalogue",
  id: "harga daftar",
  it: "prezzo di listino",
  nl: "catalogusprijs",
  pl: "po cenie katalogowej",
  pt: "preço de tabela",
  tr: "liste fiyatıyla",
  vi: "giá niêm yết",
};

describe("la fuente: lo que hace el paquete 1.2.5", () => {
  it("SDK: las horas sin respuesta solo corren con licenseServerUrl", () => {
    const create = delRepo("src/pipeline/create.ts");
    const conUrl = create.indexOf("if (config.licenseServerUrl)");
    const horas = create.indexOf("DEFAULT_MAX_STALENESS_SECONDS,", conUrl);
    expect(conUrl, "create.ts ya no condiciona la revocación a licenseServerUrl").toBeGreaterThan(0);
    expect(horas, "maxStalenessSeconds ya no está dentro de la rama de licenseServerUrl").toBeGreaterThan(conUrl);
  });

  it("gateway: el resumen al salir da el gasto a precio de lista, las tres bases y por qué no ahorró", () => {
    const recuento = delRepo("gateway/recuento.ts");
    expect(recuento).toContain("at list price");
    for (const base of ["(measured)", "(by reference)", "(estimated, never added to the measured figure)"]) expect(recuento).toContain(base);
    expect(recuento).toContain('"saved $0.00: ');
  });

  it("Python: los errores dan la orden de npx", () => {
    expect(delRepo("packages/python/src/bvsala/_gateway.py")).toContain("npx @bivelio/savings-layer gateway");
  });
});

describe("los 12 idiomas", () => {
  const en = cargar("en");

  it("en: las frases, tal cual", () => {
    expect(en["landing.faq.items.2.a"]).toContain(
      "with that key and licenseServerUrl set, as the dashboard sets it up, a layer that goes three days without an answer from savings.bivelio.com refuses every call",
    );
    expect(en["dashboard.installLicensePanel.agentsNote"]).toContain(
      "on exit tells you what it spent at list price, what it saved (or why nothing was saved), how many requests it metered, which ones it could not, and why.",
    );
    expect(en["howItWorks.caseCodeBody"]).toContain("what it saved by basis (measured, by reference or estimated)");
    expect(en["dashboard.installLicensePanel.pythonNote"]).toContain("through this same gateway (<code>npx @bivelio/savings-layer gateway</code>)");
    expect(en["dashboard.measurePlan.body"]).toMatch(/Never billed, no commission\. It saves with @bivelio\/savings-layer \{saves\} or later; older versions only observe\.$/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: FAQ con licenseServerUrl, el panel con el dinero al salir, npx para Python y la versión de Measure`, () => {
      const d = cargar(loc);
      // La FAQ va también al JSON-LD (t.raw): sin dígitos ni parámetros.
      const faq = d["landing.faq.items.2.a"]!;
      expect(faq, loc).toContain("licenseServerUrl");
      expect(faq, loc).not.toMatch(/[0-9{}]/);

      const agentes = d["dashboard.installLicensePanel.agentsNote"]!;
      expect(agentes, loc).toContain(PRECIO_DE_LISTA[loc]);
      expect(d["howItWorks.caseCodeBody"], loc).toContain(PRECIO_DE_LISTA[loc]);

      const python = d["dashboard.installLicensePanel.pythonNote"]!;
      expect(python, loc).toContain("<code>npx @bivelio/savings-layer gateway</code>");
      expect(python, loc).not.toContain("<code>bvsala gateway</code>");

      const t = createTranslator({ locale: loc, messages: crudo(loc), namespace: "dashboard.measurePlan", onError: (e) => { throw e; } });
      const fmt = t as unknown as (k: string, p: object) => string;
      const cuerpo = fmt("body", { seats: 5, saves: VERSION_MEDIR_AHORRA });
      expect(cuerpo, loc).toContain(`@bivelio/savings-layer ${VERSION_MEDIR_AHORRA}`);
      expect(cuerpo, loc).not.toContain("{");

      if (loc !== "en") {
        for (const k of ["landing.faq.items.2.a", "dashboard.installLicensePanel.agentsNote", "dashboard.measurePlan.body"]) {
          expect(d[k], `${loc} ${k} se quedó en inglés`).not.toBe(en[k]);
        }
      }
    });
  }

  it("el botón de Measure del panel pasa la versión por parámetro, desde la constante de /pricing", () => {
    const boton = readFileSync(new URL("../app/[locale]/dashboard/components/MeasureClaimButton.tsx", import.meta.url), "utf8");
    expect(boton).toContain('import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";');
    expect(boton).toContain('t("body", { seats, saves: VERSION_MEDIR_AHORRA })');
  });
});
