import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * Paridad de los 12 locales contra `en.json`.
 *
 * Una traducción que pierde una etiqueta `<b>` o un `{placeholder}` NO rompe el
 * build: revienta en tiempo de ejecución, y solo en el idioma de un cliente, que
 * es justo donde nadie mira. Ya nos pasó dos veces —el CTA de la pantalla de pago
 * quedó en inglés en 10 idiomas, y el panel de instalación describía la clave de
 * servicio como simple telemetría cuando es lo que mantiene viva la licencia—, así
 * que la comprobación vive aquí y no en la cabeza de nadie.
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

/** Etiquetas rich (`<b>`, `<code>`) que next-intl sustituye por componentes. */
const etiquetas = (s: string): string[] =>
  (s.match(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g) ?? []).sort();

/**
 * Nombres de placeholder de PRIMER nivel. Se escanea por profundidad de llaves y
 * no con un regex porque las ramas de un plural van anidadas y sus categorías
 * difieren por idioma (el turco y el vietnamita tienen una sola forma): comparar
 * eso daría falsos positivos. Lo que sí debe coincidir es el juego de variables
 * que el código pasa.
 */
function icu(s: string): string[] {
  const nombres: string[] = [];
  let prof = 0;
  let ini = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") {
      if (prof === 0) ini = i + 1;
      prof++;
    } else if (s[i] === "}") {
      prof--;
      if (prof === 0) nombres.push(s.slice(ini, i).split(",")[0]!.trim());
    }
  }
  return [...new Set(nombres)].sort();
}

const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5));
const en = cargar("en");

describe("mensajes: paridad de los 12 idiomas", () => {
  it("están los 12 locales", () => {
    expect(LOCALES.sort()).toEqual(
      ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"],
    );
  });

  for (const loc of LOCALES.filter((l) => l !== "en")) {
    describe(loc, () => {
      const d = cargar(loc);

      it("tiene exactamente las mismas claves que en.json", () => {
        expect(Object.keys(d).sort()).toEqual(Object.keys(en).sort());
      });

      it("conserva las etiquetas rich de cada cadena", () => {
        const distintas = Object.keys(en).filter(
          (k) => d[k] !== undefined && etiquetas(en[k]!).join() !== etiquetas(d[k]!).join(),
        );
        expect(distintas).toEqual([]);
      });

      it("conserva los placeholders ICU de cada cadena", () => {
        const distintas = Object.keys(en).filter(
          (k) => d[k] !== undefined && icu(en[k]!).join() !== icu(d[k]!).join(),
        );
        expect(distintas).toEqual([]);
      });
    });
  }

  // Reglas propias de dos cadenas que el componente rellena o rendeza en plano.
  for (const loc of LOCALES) {
    it(`${loc}: pasteHint mantiene el <code></code> VACÍO que rellena el componente`, () => {
      expect(cargar(loc)["dashboard.trialKeyButton.pasteHint"]).toContain("<code></code>");
    });

    it(`${loc}: hashNote es texto plano (se renderiza sin t.rich)`, () => {
      expect(etiquetas(cargar(loc)["dashboard.serviceAccountKeySection.hashNote"]!)).toEqual([]);
    });
  }
});
