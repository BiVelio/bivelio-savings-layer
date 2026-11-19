import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { APARTADOS_MOVIDOS, GUIAS_DEL_README } from "./helpers/guias-del-readme.js";

/**
 * EL README ES LA PÁGINA DE NPM, Y NPM LO CORTA A 64 KiB (auditoría P7).
 *
 * El registro guarda el README del tarball truncado a 65.536 caracteres. El de
 * la 1.2.2 pesaba 87.931 bytes: la página del paquete acababa a media frase
 * («**OpenAI-comp») y sin la sección «Licensing & privacy» —la licencia
 * Apache-2.0, qué llega a BiVelio y los correos de contacto—. Nada lo veía: ni
 * el build, ni el typecheck, ni un test.
 *
 * Ahora los catorce apartados opcionales viven en docs/guias, con su texto tal
 * cual, y el README deja una línea por apartado con un enlace ABSOLUTO a GitHub
 * (los relativos no funcionan bien en npmjs.com). Esta prueba fija las cuatro
 * cosas que lo sostienen: el tamaño con margen, la sección legal entera, que
 * ningún enlace a docs/ lleve a un fichero que no existe y que cada apartado
 * movido esté en su guía.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");
const readme = leer("README.md");
const REPO = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/";
/** Lo que el registro de npm conserva del README. */
const CORTE_DE_NPM = 65_536;
const TECHO = 60_000;

/** Ancla de un título, como la genera GitHub: minúsculas, sin puntuación, espacios a guiones. */
function ancla(titulo: string): string {
  return titulo
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Mn} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Los títulos `## ` de un markdown, fuera de los bloques de código. */
function titulos(md: string): string[] {
  const fuera: string[] = [];
  let enBloque = false;
  for (const linea of md.split("\n")) {
    if (/^\s*```/.test(linea)) enBloque = !enBloque;
    else if (!enBloque && linea.startsWith("## ")) fuera.push(linea.slice(3).trim());
  }
  return fuera;
}

/** Los destinos de enlace markdown `[texto](destino)` de un texto. */
const destinos = (md: string) => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);

/** La sección «Licensing & privacy» entera: desde su título hasta el siguiente `## ` o la raya final. */
function seccionLegal(): string {
  const inicio = readme.indexOf("## Licensing & privacy");
  if (inicio < 0) return "";
  const resto = readme.slice(inicio + 3);
  const fin = resto.search(/^## |^---$/m);
  return fin < 0 ? readme.slice(inicio) : readme.slice(inicio, inicio + 3 + fin);
}

describe("el README cabe entero en la página de npm", () => {
  it(`pesa menos de ${TECHO} bytes (npm corta a ${CORTE_DE_NPM} caracteres)`, () => {
    const bytes = Buffer.byteLength(readme, "utf8");
    expect(bytes, `README.md pesa ${bytes} bytes`).toBeLessThan(TECHO);
  });

  it("lleva «Licensing & privacy» entera, y antes del corte de npm", () => {
    const legal = seccionLegal();
    expect(legal, "falta la sección «## Licensing & privacy»").not.toBe("");
    expect(readme.indexOf("## Licensing & privacy") + legal.length).toBeLessThan(TECHO);
    // Lo que se perdía con el corte: la licencia, la privacidad y a quién escribir.
    expect(legal).toContain("**Apache-2.0**");
    expect(legal).toContain("[LICENSE-CLOUD.md](./LICENSE-CLOUD.md) §5");
    expect(legal).toContain("https://savings.bivelio.com/privacy");
    for (const correo of ["support@bivelio.com", "privacy@bivelio.com", "team@bivelio.com"]) {
      expect(legal, correo).toContain(correo);
    }
  });
});

describe("los apartados que salieron del README siguen a un clic", () => {
  it("cada enlace del README a docs/ lleva a un fichero que existe (y a un título que existe)", () => {
    const aDocs = destinos(readme)
      .map((d) => (d.startsWith(REPO) ? d.slice(REPO.length) : d.replace(/^\.\//, "")))
      .filter((d) => d.startsWith("docs/"));
    expect(aDocs.length).toBeGreaterThanOrEqual(APARTADOS_MOVIDOS.length);
    const rotos: string[] = [];
    for (const d of aDocs) {
      const [ruta = "", hash] = d.split("#");
      if (!existsSync(join(RAIZ, ruta))) {
        rotos.push(`${d}: no existe ${ruta}`);
        continue;
      }
      if (hash && ruta.endsWith(".md") && !titulos(leer(ruta)).some((t) => ancla(t) === hash)) {
        rotos.push(`${d}: ${ruta} no tiene el título #${hash}`);
      }
    }
    expect(rotos).toEqual([]);
  });

  it("cada apartado movido: una línea en el README con enlace ABSOLUTO a GitHub, y su título en la guía", () => {
    for (const { titulo, guia } of APARTADOS_MOVIDOS) {
      expect(existsSync(join(RAIZ, guia)), guia).toBe(true);
      expect(titulos(leer(guia)), `${guia} no tiene «## ${titulo}»`).toContain(titulo);
      expect(readme, `el README no enlaza «${titulo}»`).toContain(`- [${titulo}](${REPO}${guia}#${ancla(titulo)})`);
      // Movido, no copiado: el desplegable ya no está en el README.
      const summary = titulo.replace(/`([^`]*)`/g, "<code>$1</code>");
      expect(readme, `«${titulo}» sigue desplegado en el README`).not.toContain(`<summary><b>${summary}</b></summary>`);
    }
  });

  it("el README no enlaza docs/guias por ruta relativa (en npmjs.com no lleva a ninguna parte)", () => {
    const relativos = destinos(readme).filter((d) => /^(?:\.\/)?docs\/guias\//.test(d));
    expect(relativos).toEqual([]);
  });

  it("los enlaces relativos de las guías siguen funcionando desde su sitio nuevo", () => {
    const rotos: string[] = [];
    for (const guia of GUIAS_DEL_README) {
      for (const d of destinos(leer(guia))) {
        if (/^(?:[a-z]+:|#)/.test(d)) continue;
        const ruta = normalize(join(dirname(guia), d.split("#")[0]!));
        if (!existsSync(join(RAIZ, ruta))) rotos.push(`${guia}: ${d}`);
      }
    }
    expect(rotos).toEqual([]);
  });

  it("las guías cumplen las verjas del README (lo que se movió sigue siendo su texto)", () => {
    // Las mismas frases que vetan para el README apps/web/lib/readme-alineado.test.ts
    // y apps/web/messages/sin-licencia-para-ahorrar.test.ts.
    const vetadas = [
      /\$330|\$160|\$84/,
      /≥ ?\d+([.,]\d+)? ?%/,
      /free in your browser/i,
      /does not optimi[sz]e/i,
      /with a PRO license|PRO-license|levers need a paid plan:/,
    ];
    const culpables: string[] = [];
    for (const guia of GUIAS_DEL_README) {
      const texto = leer(guia);
      for (const r of vetadas) if (r.test(texto)) culpables.push(`${guia}: ${r}`);
    }
    expect(culpables).toEqual([]);
  });
});
