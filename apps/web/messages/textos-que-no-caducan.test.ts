import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * m27 y m32 · TEXTOS QUE NO CADUCAN CON CADA VERSIÓN, Y UNA LLAMADA QUE NO
 * PROMETE UNA CIFRA (2026-11-21).
 *
 * m27: con la 1.2.3 publicada, la web seguía diciendo «0.4.33 or later»,
 * «Migrate to 0.5» en el pie, «la última versión es la 0.5» en el panel y
 * «gateway 0.4.26 o posterior» en la nota de Python. No era falso, pero hacía
 * parecer viejo el producto, y cada release lo volvía a dejar atrás. Donde
 * hace falta, se dice «la última versión»; la versión mínima de Measure sigue
 * en sus condiciones (/pricing#medir, ver portada-dice-lo-medido.test.ts).
 *
 * m32: «Book 15-min call» prometía decir cuánto ahorrarías «sin instalar
 * nada», y la propia web dice que eso no se sabe sin medir. Ahora ofrece
 * enseñarte a medirlo en tu tráfico, gratis.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;

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
const cargar = (loc: string): Plano => aplanar(JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8")));

describe("m27 · sin números de versión que caducan", () => {
  for (const loc of LOCALES) {
    it(`${loc}: pie, tarjeta de Measure, alta, banda final y panel`, () => {
      const d = cargar(loc);
      // Ninguna versión escrita: ni en el enlace del pie, ni donde se ofrece Measure.
      for (const k of ["landing.footer.migrate", "pricingPage.cards.medir.version", "auth.signupMedir", "landing.footer.ctaSub"]) {
        expect(d[k], `${loc} ${k}`).toBeTruthy();
        expect(d[k], `${loc} ${k}`).not.toMatch(/\d+\.\d+|\{version\}/);
      }
      // El panel ya no da 0.4.x como requisito.
      for (const k of ["dashboard.installLicensePanel.pythonNote", "dashboard.sesiones.hint"]) {
        expect(d[k], `${loc} ${k}`).not.toMatch(/0\.4\.\d+/);
      }
      // La 0.5 se nombra solo como punto de partida de un salto con cambios
      // incompatibles, no como «la última».
      expect(d["dashboard.migrar05.note"], loc).toContain("0.5");
    });
  }

  it("en: el aviso del panel es condicional y no dice que la 0.5 sea la última", () => {
    const d = cargar("en");
    expect(d["dashboard.migrar05.note"]).toBe("Updating from a version before 0.5 brings breaking changes.");
    expect(d["dashboard.migrar05.note"]).not.toMatch(/latest/i);
    expect(d["landing.footer.migrate"]).toBe("Migration guide");
  });
});

describe("m32 · la llamada de 15 minutos", () => {
  it("en: el texto exacto del dueño", () => {
    expect(cargar("en")["landing.cta15.sub"]).toBe("We'll show you how to measure it on your own traffic, for free.");
  });

  for (const loc of LOCALES) {
    it(`${loc}: no promete una cifra ni «sin instalar nada»`, () => {
      const sub = cargar(loc)["landing.cta15.sub"]!;
      expect(sub).toBeTruthy();
      expect(sub).not.toMatch(/[0-9]/);
      expect(sub).not.toMatch(/without installing|sin instalar|sense instal|ohne etwas zu installieren|sans rien installer|tanpa memasang|senza installare|zonder iets te installeren|bez instalowania|sem instalar|hiçbir şey kurmadan|không cần cài/i);
    });
  }
});
