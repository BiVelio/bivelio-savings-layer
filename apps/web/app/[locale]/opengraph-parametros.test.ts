import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * NINGUNA TARJETA SOCIAL PUBLICA UN MARCADOR SIN RELLENAR.
 *
 * `landing.pricing.amount` es la cadena ICU `"{amount}"`. La tarjeta la pedía con
 * `t("pricing.amount")`, SIN el parámetro, así que publicaba el marcador literal:
 * «{amount} / seat / month», en los doce idiomas, en cada enlace compartido en
 * LinkedIn, X, Slack o WhatsApp.
 *
 * Es el peor sitio para un fallo silencioso: la imagen se genera en el servidor,
 * nadie la mira al desarrollar, no rompe ningún build — y las cachés de OG de las
 * redes la congelan durante días, así que el arreglo no repara los enlaces ya
 * compartidos.
 *
 * La regla que se vigila: si una clave que usa una tarjeta OG lleva `{marcador}`,
 * la llamada tiene que pasarle argumentos.
 */
// `fileURLToPath` y no `.pathname`: esta carpeta se llama `[locale]`, y en una
// URL los corchetes viajan como %5B/%5D — `readdirSync` no encuentra la ruta.
const DIR = fileURLToPath(new URL("./", import.meta.url));
const MENSAJES = fileURLToPath(new URL("../../messages/", import.meta.url));

/** Ficheros `opengraph-image.tsx` de este árbol, incluidos los de subrutas. */
function tarjetas(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) tarjetas(`${dir}${e.name}/`, acc);
    else if (e.name === "opengraph-image.tsx") acc.push(`${dir}${e.name}`);
  }
  return acc;
}

const CLAVES = /\bt\(\s*"([^"]+)"\s*(,)?/g;

describe("las tarjetas sociales rellenan sus marcadores", () => {
  const en = JSON.parse(readFileSync(`${MENSAJES}en.json`, "utf8")) as Record<string, unknown>;

  function valor(ruta: string): string | undefined {
    let o: unknown = en;
    for (const p of ruta.split(".")) {
      if (o === null || typeof o !== "object") return undefined;
      o = (o as Record<string, unknown>)[p];
    }
    return typeof o === "string" ? o : undefined;
  }

  const encontradas = tarjetas(DIR);

  it("hay tarjetas que revisar (si no, este test no protege nada)", () => {
    expect(encontradas.length).toBeGreaterThan(0);
  });

  it.each(encontradas)("%s no pide una clave con marcador sin argumentos", (ruta) => {
    const src = readFileSync(ruta, "utf8");
    // El namespace se fija con getTranslations({ namespace }); las claves del
    // fichero son relativas a él.
    const ns = src.match(/namespace:\s*"([^"]+)"/)?.[1];
    const sinRellenar: string[] = [];
    for (const m of src.matchAll(CLAVES)) {
      const clave = ns ? `${ns}.${m[1]}` : m[1]!;
      const v = valor(clave);
      if (v === undefined) continue;
      const tieneMarcador = /\{[a-zA-Z][a-zA-Z0-9]*\}/.test(v);
      const pasaArgumentos = m[2] === ",";
      if (tieneMarcador && !pasaArgumentos) sinRellenar.push(`${clave} → ${JSON.stringify(v)}`);
    }
    expect(sinRellenar, `marcadores que se publicarían en crudo:\n  ${sinRellenar.join("\n  ")}`).toEqual([]);
  });
});
