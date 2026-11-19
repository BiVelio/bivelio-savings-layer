/**
 * A2-21 · EL TÍTULO QUE SE VE AL COMPARTIR UNA PÁGINA LLEVA EL NOMBRE PÚBLICO.
 *
 * `/pricing` y `/privacy` se compartían en Product Hunt, X, LinkedIn o Slack con
 * una tarjeta titulada «Pricing terms · BV-SALA» o «What leaves your
 * infrastructure · BV-SALA», y la pestaña del navegador decía lo mismo, en los
 * 12 idiomas. BV-SALA es el nombre en clave interno: un visitante no sabe qué
 * es. El resto de páginas terminan en «· BiVelio Savings Layer», que es también
 * el `og:site_name`.
 *
 * Las dos páginas usan `metaTitle` como `<title>`, `og:title` y `twitter:title`
 * (app/[locale]/pricing/page.tsx y privacy/page.tsx), así que basta con vigilar
 * las claves de metadatos de los mensajes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname);
const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5));

function cadenas(o: unknown, ruta: string[] = [], fuera: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof o === "string") fuera.push([ruta.join("."), o]);
  else if (Array.isArray(o)) o.forEach((v, i) => cadenas(v, [...ruta, String(i)], fuera));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) cadenas(v, [...ruta, k], fuera);
  return fuera;
}

const cargar = (loc: string) => JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8"));

describe("A2-21 · ningún título ni descripción de página lleva el nombre en clave", () => {
  it("están los 12 idiomas", () => {
    expect(LOCALES).toHaveLength(12);
  });

  for (const loc of LOCALES) {
    it(`${loc}: ninguna clave meta* (metaTitle, metaDescription…) dice «BV-SALA»`, () => {
      const malas = cadenas(cargar(loc))
        .filter(([k, v]) => /^meta/i.test(k.split(".").at(-1) ?? "") && v.includes("BV-SALA"))
        .map(([k]) => k);
      expect(malas, `${loc}: ${malas.join(", ")}`).toEqual([]);
    });

    it(`${loc}: /pricing y /privacy terminan en «· BiVelio Savings Layer», como las demás páginas`, () => {
      const d = cargar(loc);
      expect(d.pricingPage.metaTitle).toMatch(/ · BiVelio Savings Layer$/);
      expect(d.privacyPage.metaTitle).toMatch(/ · BiVelio Savings Layer$/);
    });
  }
});
