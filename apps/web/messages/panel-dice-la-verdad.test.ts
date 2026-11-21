import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * EL PANEL DICE LO MISMO QUE LA PORTADA, EN LOS 12 IDIOMAS (revisión de #612).
 *
 * Tras la 1.2.4 la portada ya no prometía dos cosas que no existen o no son
 * exactas, pero el panel seguía diciéndolas:
 *   · «shared caches»: la nube no tiene cachés compartidas. Lo que añade es el
 *     panel de equipo, la medición compartida, los asientos y las licencias;
 *   · «every local lever on»: todas las palancas van INCLUIDAS y gratis sin
 *     clave, pero no todas ENCENDIDAS. Por defecto van la caché exacta, la
 *     deduplicación, los resolutores locales, la colocación de la caché del
 *     proveedor y el recorte de resultados de herramientas sustituidos; el
 *     resto se enciende.
 * Y Measure aplica «las mismas palancas que sin clave», no «todas».
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
const panelDe = (loc: string): Plano =>
  Object.fromEntries(Object.entries(cargar(loc)).filter(([k]) => k.startsWith("dashboard.")));

/** «Cachés compartidas» tal como estaba escrito en cada idioma. */
const CACHES_COMPARTIDAS: Record<(typeof LOCALES)[number], RegExp> = {
  ca: /memòries cau compartides/i,
  de: /geteilte Caches/i,
  en: /shared caches?/i,
  es: /cachés compartidas/i,
  fr: /caches partagées/i,
  id: /cache bersama/i,
  it: /cache condivise/i,
  nl: /gedeelde caches/i,
  pl: /współdzielone pamięci podręczne/i,
  pt: /caches partilhadas/i,
  tr: /paylaşılan önbellek/i,
  vi: /cache dùng chung/i,
};

/** «Todas las palancas locales / activas» tal como estaba escrito en cada idioma. */
const TODAS_ENCENDIDAS: Record<(typeof LOCALES)[number], RegExp> = {
  ca: /tot l'estalvi local|totes les palanques (locals|actives)|aplica totes les palanques/i,
  de: /alle lokalen Hebel|alle Hebel aktiv|wendet alle Hebel an/i,
  en: /every local lever|every lever on|applies every lever/i,
  es: /todas las palancas (locales|activas)|aplica todas las palancas/i,
  fr: /tous les leviers (locaux|actifs)|applique tous les leviers/i,
  id: /semua tuas (lokal|aktif)|menerapkan semua tuas/i,
  it: /tutte le leve (locali|attive)|applica tutte le leve/i,
  nl: /alle lokale (hendels|hefbomen)|alle hefbomen aan|past alle hefbomen toe/i,
  pl: /wszystkie lokalne dźwignie|wszystkie dźwignie włączone|stosuje wszystkie dźwignie/i,
  pt: /todas as alavancas (locais|ativas)|aplica todas as alavancas/i,
  tr: /tüm yerel kaldıraçlar|tüm kollar açık|tüm kolları uygular/i,
  vi: /mọi đòn bẩy cục bộ|mọi đòn bẩy đều bật|áp dụng mọi đòn bẩy/i,
};

const CLAVES = [
  "dashboard.accountPlanStrip.planBody",
  "dashboard.installLicensePanel.step1",
  "dashboard.installLicensePanel.modeLocalBody",
  "dashboard.measurePlan.keyLabel",
  "dashboard.measurePlan.card.empty",
] as const;

describe("el panel no promete lo que no hay", () => {
  it("los 12 idiomas tienen exactamente las mismas claves", () => {
    const base = Object.keys(cargar("en")).sort();
    for (const loc of LOCALES) expect(Object.keys(cargar(loc)).sort(), loc).toEqual(base);
  });

  it.each(LOCALES)("%s · ningún texto de dashboard.* habla de cachés compartidas", (loc) => {
    for (const [k, v] of Object.entries(panelDe(loc))) expect(v, k).not.toMatch(CACHES_COMPARTIDAS[loc]);
  });

  it.each(LOCALES)("%s · ningún texto de dashboard.* dice que todas las palancas van encendidas", (loc) => {
    for (const [k, v] of Object.entries(panelDe(loc))) expect(v, k).not.toMatch(TODAS_ENCENDIDAS[loc]);
  });

  it.each(LOCALES)("%s · las cinco claves están traducidas (no son la copia inglesa) y conservan sus marcas", (loc) => {
    const t = cargar(loc);
    const en = cargar("en");
    for (const k of CLAVES) {
      expect(t[k], k).toBeTruthy();
      if (loc !== "en") expect(t[k], k).not.toBe(en[k]);
    }
    // Los parámetros del plan y las etiquetas del paso 1 siguen ahí.
    for (const p of ["{monthly}", "{yearly}", "{teamMonthly}", "{included}"]) {
      expect(t["dashboard.accountPlanStrip.planBody"], p).toContain(p);
    }
    expect(t["dashboard.installLicensePanel.step1"]).toMatch(/^<b>1 · .+<\/b>/);
    expect(t["dashboard.installLicensePanel.step1"]).toContain("<code>licenseKey</code>");
  });

  it("en · las frases honestas, tal cual", () => {
    const en = cargar("en");
    expect(en["dashboard.accountPlanStrip.planBody"]).toContain("team dashboard, shared measurement, seats and licences");
    for (const k of ["dashboard.installLicensePanel.step1", "dashboard.installLicensePanel.modeLocalBody"]) {
      expect(en[k], k).toContain("every lever included and free");
      expect(en[k], k).toContain(
        // La lista entera, la del README de la 1.2.4: también la serialización compacta.
        "On by default: exact cache, deduplication, local resolvers, provider cache placement, trimming of superseded tool results and compact serialization of the structured data you pass; the rest you switch on.",
      );
    }
    expect(en["dashboard.measurePlan.keyLabel"]).toContain("the same levers as with no key, one exception in the README");
    // 1.2.4 · con clave el recorte de resultados sustituidos solo actúa en el bucle
    // de herramientas de Anthropic (decisión del dueño): el panel no dice «las
    // mismas palancas» sin la excepción (verificación 4).
    expect(en["dashboard.measurePlan.card.empty"]).toContain(
      "Measure applies the same levers as with no key, except trimming of superseded tool results outside an Anthropic tool loop.",
    );
    expect(en["dashboard.measurePlan.body"]).toContain(
      "the layer applies the same levers as with no key, except that trimming of superseded tool results only acts inside a tool loop on Anthropic",
    );
    expect(en["dashboard.measurePlan.body"]).not.toContain("saves exactly as it does with no key");
  });

  it("en · Measure no se describe como modo sombra: la sombra es la excepción, nombrada como tal", () => {
    const en = cargar("en");
    const plan = Object.entries(en).filter(([k]) => k.startsWith("dashboard.measurePlan."));
    for (const [k, v] of plan) {
      if (k === "dashboard.measurePlan.card.shadowTitle" || k === "dashboard.measurePlan.card.amount" || k === "dashboard.measurePlan.card.context") continue;
      expect(v, k).not.toMatch(/shadow|would have saved|would not have spent|byte for byte/i);
    }
    // El bloque hipotético dice de dónde sale: máquinas que solo observan o clientes antiguos.
    expect(en["dashboard.measurePlan.card.context"]).toMatch(/observe-only/);
    expect(en["dashboard.measurePlan.card.title"]).toBe("Your savings");
  });
});
