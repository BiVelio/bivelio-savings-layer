import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LO QUE «INSTALAR GRATIS» ENSEÑA SE CUMPLE SIN CLAVE (lanzamiento del
 * 22-11-2026; verificación de lo gratis con el tarball de la 1.2.4 instalado en
 * proyectos nuevos, proveedores falsos y una trampa en *.bivelio.com).
 *
 *   · El fragmento del SDK imprimía `report.cost.netSavingsRatio` con «el
 *     ahorro, medido». Sin clave, la repetición de una petición a un origen que
 *     no es la API oficial imprime 1 con `basis: "estimated"`, y la respuesta
 *     local del ejemplo también: el número no siempre es medido. Ahora imprime
 *     `report.cost` (la cifra con su base) y el comentario dice «medido o
 *     estimado», como el README.
 *   · La nota de Python de /how-it-works#install-gateway decía que cada
 *     petición «queda registrada en este panel»: en una página pública, y sin
 *     clave no hay panel. Se mide en tu máquina, y en el panel solo con clave de
 *     servicio.
 *   · La tarjeta «tu tráfico va directo» decía «a nosotros solo llegan
 *     recuentos y coste»: sin clave no llega nada (comprobado con la trampa).
 *   · La nota de `init` decía que la comprobación funciona «sin ninguna
 *     clave»: con el SDK de Anthropic necesita ANTHROPIC_API_KEY con cualquier
 *     valor (init lo dice). Lo que no hace falta es la clave de BiVelio.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;

type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>((acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)), {});
  }
  return { [p]: String(o) };
}
const cargar = (loc: string): Plano => aplanar(JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8")));
const codigo = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const CAMBIADAS = [
  "howItWorks.snipResult",
  "landing.gateway.pythonNote",
  "landing.devs.cards.2.body",
  "landing.integrate.initNote",
] as const;

describe("«Instalar gratis» no promete lo que sin clave no pasa", () => {
  it("el fragmento del SDK imprime la cifra con su base, en la portada y en /how-it-works", () => {
    for (const f of ["app/[locale]/page.tsx", "app/components/HowItWorks.tsx"]) {
      const src = codigo(f);
      expect(src, f).toContain('"console.log(report.cost)  "');
      expect(src, f).not.toContain("console.log(report.cost.netSavingsRatio)");
    }
  });

  // Pegar el bloque del gateway ENTERO ponía BIVELIO_SERVICE_KEY=bvk_… (el
  // marcador) y `bvsala claude` no arrancaba: «could not collect your license…
  // The gateway does not start without a verified license» (exit 1, comprobado
  // con el tarball de la 1.2.4). La línea opcional va comentada, como el
  // marcador que es.
  it("los bloques del gateway llevan la clave opcional comentada (portada y /how-it-works, macOS/Linux y Windows)", () => {
    const portada = codigo("app/[locale]/page.tsx");
    const como = codigo("app/[locale]/how-it-works/page.tsx");
    for (const [f, src] of [["portada", portada], ["how-it-works", como]] as const) {
      expect(src, f).not.toMatch(/\{"export "\}\s*<span className="s">BIVELIO_/);
      expect(src, f).toMatch(/\{"# export "\}\s*<span className="s">BIVELIO_SERVICE_KEY<\/span>/);
    }
    expect(como).toMatch(/\{"# "\}\s*<span className="s">\$env:BIVELIO_SERVICE_KEY<\/span>/);
  });

  it("en: medido o estimado, en tu máquina, y sin clave no llega nada", () => {
    const en = cargar("en");
    expect(en["howItWorks.snipResult"]).toBe("the saving, with its basis: measured or estimated");
    expect(en["landing.gateway.pythonNote"]).toContain("on your machine");
    expect(en["landing.gateway.pythonNote"]).not.toContain("this dashboard");
    expect(en["landing.devs.cards.2.body"]).toContain("with no key nothing reaches us");
    expect(en["landing.integrate.initNote"]).toContain("with no BiVelio key");
    expect(en["landing.integrate.initNote"]).not.toContain("with no keys at all");
  });

  for (const loc of LOCALES) {
    it(`${loc}: las claves existen, nombran Savings Cloud o BiVelio donde toca y no se quedan en inglés`, () => {
      const d = cargar(loc);
      const en = cargar("en");
      for (const k of CAMBIADAS) expect(d[k], `${loc} ${k}`).toBeTruthy();
      if (loc !== "en") expect(CAMBIADAS.filter((k) => d[k] === en[k])).toEqual([]);
      expect(d["landing.gateway.pythonNote"]).toMatch(/Savings[ -]Cloud/);
      expect(d["landing.integrate.initNote"]).toContain("BiVelio");
    });
  }
});
