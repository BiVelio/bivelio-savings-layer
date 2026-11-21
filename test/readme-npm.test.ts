import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { APARTADOS_MOVIDOS, GUIAS_DEL_README } from "./helpers/guias-del-readme.js";
import { precioDeLista, precioDeListaPropio } from "../src/pricing/catalogo.js";

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

  it("el README no enlaza nada de docs/ por ruta relativa (en npmjs.com no lleva a ninguna parte)", () => {
    // Ni las guías ni el paper viajan en el tarball, y lo que sí viaja
    // (docs/terminales) npmjs.com no lo sirve: todo enlace a docs/ va absoluto a
    // GitHub, el mismo en las dos páginas.
    const relativos = destinos(readme).filter((d) => /^(?:\.\/)?docs\//.test(d));
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

/**
 * LO QUE EL README CUENTA DE LOS ARREGLOS DE LA 1.2.3 (notas del #599).
 *
 * Cada frase se comprobó contra el código antes de escribirla; estas pruebas
 * impiden que se pierda al reordenar el README otra vez. El comportamiento lo
 * fijan sus propias pruebas: resolver-aritmetico-declina, adaptadores/mastra,
 * salida-que-debe-variar, respuesta-vacia-no-se-cachea,
 * precio-ilustrativo-no-es-medido y gateway-no-empeora.
 */
describe("el README cuenta los arreglos de la 1.2.3", () => {
  const plano = readme.replace(/\s+/g, " ");

  it("el ejemplo de Mastra no promete «8» si su agente lleva instrucciones (con ellas la cuenta va al modelo)", () => {
    const bloque = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((m) => m[1]!)
      .find((b) => b.includes("savingsProcessor(") && b.includes("new Agent("));
    expect(bloque, "falta el ejemplo de Mastra en el README").toBeDefined();
    const instrucciones = /instructions:\s*"([^"]*)"/.exec(bloque!)?.[1] ?? "";
    const llamada = bloque!.split("\n").find((l) => l.includes("agent.generate(")) ?? "";
    if (instrucciones !== "") expect(llamada).not.toMatch(/\/\/\s*"8"/);
  });

  it("dice cuándo contesta la cuenta en la máquina y qué va al modelo", () => {
    expect(plano).toContain("a single user message, with no system prompt, no earlier turns, no tools and no structured data");
    expect(plano).toContain("`10 / 3`, percentages, dates and `2.500`");
  });

  it("dice que lo que pide azar o la hora no sale de caché, y que con `seed` el azar sí", () => {
    expect(plano).toContain("ask for random or freshly generated output");
    expect(plano).toContain("or for the current time or date is never read from or written to the exact or semantic cache");
    expect(plano).toContain("With a `seed`, a random request is cacheable again");
  });

  it("dice que lo vacío no se cachea y que un 200 con error hace fallar generate()", () => {
    expect(plano).toContain("never written to a cache");
    expect(plano).toContain("makes `generate()` throw instead of returning empty text");
  });

  it("dice que sin precio de lista el dinero sale «estimated» con priceSource illustrative", () => {
    expect(plano).toContain('its dollar figures are `"estimated"`, never `"measured"`');
    expect(plano).toContain('`priceSource: "illustrative"`');
  });

  it("dice que la rebaja de TTL no toca la suscripción (Claude Max/Pro), en el README y en la guía de terminales", () => {
    expect(plano).toContain("the TTL lever leaves Claude Max/Pro traffic untouched");
    const terminales = leer("docs/terminales/README.md").replace(/\s+/g, " ");
    expect(terminales).toContain("the TTL lever does not touch it");
    // Sin clave, el gateway mide en local: línea de log, resumen y rutas locales.
    expect(terminales).not.toMatch(/el metering se queda en las rutas locales|metering stays (on|in) the local routes/);
    expect(terminales).toContain("one log line per request, the summary on exit and the local `/_bvsala` routes");
  });
});

/**
 * EL CHANGELOG TAMBIÉN VIAJA EN EL TARBALL, Y SOLO CUENTA LO QUE EL CÓDIGO HACE.
 *
 * La entrada de la 1.2.3 llegó a anunciar filas de precio de `claude-fable-5-2` y
 * `gemini-2.5-flash-lite` que no estaban en el catálogo de main (vivían en otra
 * rama), y a poner `gemini-2.5-flash-lite` como ejemplo de id SIN precio, que
 * deja de serlo en cuanto esa rama entra. Las dos frases dependían de qué se
 * fusionara antes; estas pruebas las atan al catálogo que se publica.
 */
describe("la entrada 1.2.3 del CHANGELOG dice lo que hace el catálogo", () => {
  const changelog = leer("CHANGELOG.md");
  const desde = changelog.indexOf("## 1.2.3");
  const hasta = changelog.indexOf("\n## ", desde + 1);
  const entrada = changelog.slice(desde, hasta < 0 ? undefined : hasta);
  const plana = entrada.replace(/\s+/g, " ");

  it("no anuncia filas de precio que el catálogo no tiene", () => {
    expect(desde, "falta la entrada «## 1.2.3» del CHANGELOG").toBeGreaterThanOrEqual(0);
    const anunciados = [...plana.matchAll(/List-price rows? for ((?:`[^`]+`(?:,? and |, )?)+)/g)].flatMap((m) =>
      [...m[1]!.matchAll(/`([^`]+)`/g)].map((id) => id[1]!),
    );
    const sinFila = anunciados.filter((id) => precioDeListaPropio(id) === undefined);
    expect(sinFila, `el CHANGELOG anuncia fila propia para ${sinFila.join(", ")}`).toEqual([]);
  });

  it("los ejemplos de id sin precio de lista no lo tienen, y el pariente que ya no heredan sí", () => {
    const m = /Ids with `:` \(`([^`]+)`\) and relatives whose suffix is not an alias of the same model \(`([^`]+)` no longer takes `([^`]+)`'s row\) have no list price/.exec(
      plana,
    );
    expect(m, "cambió la frase de los ids sin precio: actualiza esta prueba").not.toBeNull();
    const [, conVariante = "", pariente = "", modelo = ""] = m!;
    expect(precioDeLista(conVariante), conVariante).toBeUndefined();
    expect(precioDeLista(pariente), pariente).toBeUndefined();
    expect(precioDeLista(modelo), modelo).toBeDefined();
  });
});

/**
 * AUDITORÍA DE MEDIOS PÚBLICOS (m04, m07, m20): lo que el README y las guías
 * dicen tiene que ser lo que el paper y la web sostienen.
 */
describe("el README dice lo que el paper y la web sostienen", () => {
  const plano = readme.replace(/\s+/g, " ");

  it("m07 · el titular es «recomputed from the public artifacts» y el −82,76 % va como A/B exploratorio, no como titular", () => {
    expect(plano).not.toMatch(/independently re-checked/i);
    expect(readme).toContain("### Measured, not promised — recomputed from the public artifacts");
    expect(plano).toContain("**Exploratory live A/B (20 requests per arm)**");
    expect(plano).not.toMatch(/\*\*82[.,]76/);
    expect(plano).not.toMatch(/no quality loss/i);
    const python = leer("packages/python/README.md").replace(/\s+/g, " ");
    expect(python).toContain("exploratory live A/B (20 requests per arm)");
    expect(python).not.toMatch(/> Live A\/B/);
  });

  it("m20 · el banco publicado se enlaza en /en/benchmarks con sus informes JSON, no en /how-it-works con un CSV", () => {
    expect(plano).not.toMatch(/raw CSV/i);
    expect(plano.match(/raw JSON reports/g)).toHaveLength(2);
    expect(plano.match(/\(https:\/\/savings\.bivelio\.com\/en\/benchmarks\)/g)).toHaveLength(2);
  });

  it("m20 · la guía de persistencia avisa de que @bivelio/persistence-postgres aún no está en npm", () => {
    expect(leer("docs/guias/persistencia.md").replace(/\s+/g, " ")).toContain("**Not on npm yet** (release candidate)");
  });

  it("m04 · «Licensing & privacy» dice qué es Apache-2.0 y qué se publica solo por transparencia", () => {
    const legal = seccionLegal().replace(/\s+/g, " ");
    expect(legal).toContain("**What the Apache-2.0 license covers.**");
    expect(legal).toContain("the Python client (`packages/python`) are Apache-2.0");
    expect(legal).toContain("for transparency only");
  });
});

/**
 * LAS GUÍAS DE TERMINALES VIAJAN EN EL TARBALL Y SE ENLAZAN DESDE UN README EN
 * INGLÉS (auditoría de medios, m30). Estaban en español —título incluido— salvo
 * una sección; quien llegaba desde npm o GitHub leía media guía. Ahora van en
 * inglés enteras, con las líneas de log que el gateway imprime de verdad.
 */
describe("docs/terminales va en inglés, como el README que lo enlaza", () => {
  const guias = readdirSync(join(RAIZ, "docs", "terminales")).filter((f) => f.endsWith(".md"));

  it("están todas las guías (si cambia la carpeta, este bloque no protege nada)", () => {
    expect(guias.length).toBeGreaterThanOrEqual(18);
    expect(guias).toContain("README.md");
    expect(guias).toContain("claude-code.md");
  });

  for (const f of guias) {
    it(`⛔ ${f}: ni tildes ni comillas angulares ni las palabras de la versión española`, () => {
      const t = leer(`docs/terminales/${f}`);
      expect(t).not.toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡«»]/);
      expect(t).not.toMatch(/\b(Qué necesitas|Envoltorio|La trampa|Comprobar|ventana \d|través del gateway|Fuente:)\b/);
    });
  }

  it("⛔ no dice que el repositorio no es público: lo es", () => {
    for (const f of guias) {
      expect(leer(`docs/terminales/${f}`), f).not.toMatch(/not\s+public|no\s+es\s+p[uú]blico/i);
    }
  });

  it("las líneas de arranque y de log citadas son las que imprime el gateway hoy", () => {
    const guia = leer("docs/terminales/README.md");
    const bin = leer("gateway/bin.ts");
    const servidor = leer("gateway/servidor.ts");
    // El ejemplo llevaba «v0.6.x» y «metering: OFF», una línea que ya no existe.
    expect(guia).not.toMatch(/v0\.\d+\.x listening/);
    expect(guia).not.toContain("metering: OFF");
    expect(guia).toContain("metering: LOCAL ONLY (community mode, no BiVelio service key)");
    expect(bin).toContain("metering: LOCAL ONLY (community mode, no BiVelio service key)");
    expect(guia).not.toMatch(/Desde la próxima versión|From the next version/i);
    // La guía de Codex copiaba dos líneas de log en español que el gateway escribe en inglés.
    const codex = leer("docs/terminales/codex.md");
    for (const linea of [
      "426 (WebSocket not supported; the client falls back to HTTP)",
      "client closed after the final usage; metered anyway",
    ]) {
      expect(codex, linea).toContain(linea);
      expect(servidor, linea).toContain(linea);
    }
  });

  it("el enlace interno a la sección de Copilot en VS Code apunta a un título que existe", () => {
    expect(leer("docs/terminales/README.md")).toContain("copilot.md#copilot-in-vs-code-byok-custom-endpoint");
    expect(leer("docs/terminales/copilot.md")).toContain('## Copilot in VS Code (BYOK, "Custom Endpoint")');
  });
});

/**
 * DOS DETALLES DEL README QUE NO CUADRABAN CON EL PAQUETE (auditoría de medios).
 *
 * m27 · la insignia y los requisitos decían «Node ≥ 20» y `engines` exige
 * 20.19; el banco publicado se enlazaba a /how-it-works y vive en /benchmarks.
 * m29 · varias frases hablaban de lo que «llega a tu factura» y de «la base de
 * la comisión», cuando Pro y Team no llevan comisión (la comisión solo se
 * nombra donde se explica el plan antiguo, cerrado).
 */
describe("el README dice la versión de Node del paquete y no habla de comisión donde no la hay", () => {
  it("⛔ «Node ≥ 20.19» en la insignia y en los requisitos, como `engines`", () => {
    const pkg = JSON.parse(leer("package.json")) as { engines: { node: string } };
    const minimo = /^>=(\d+\.\d+)\.0$/.exec(pkg.engines.node)?.[1];
    expect(minimo).toBeDefined();
    expect(readme).toContain(`badge/node-%E2%89%A5${minimo}-`);
    expect(readme).toContain(`alt="Node ≥ ${minimo}"`);
    expect(readme).toContain(`- **Node ≥ ${minimo}.**`);
    expect(readme).not.toMatch(/Node ≥ 20[^.\d]/);
  });

  it("el banco publicado se enlaza a /benchmarks", () => {
    const plano = readme.replace(/\s+/g, " ");
    expect(plano).not.toMatch(/benchmark, trial by trial[^.]*how-it-works/);
    expect(plano.match(/benchmark, trial by trial[^.]*?savings\.bivelio\.com\/en\/benchmarks/g)?.length).toBe(2);
  });

  it("⛔ ni «reach your invoice» ni «the commission base» ni «never carries commission»", () => {
    const plano = readme.replace(/\s+/g, " ");
    expect(plano).not.toMatch(/reach(es)? your invoice/);
    expect(plano).not.toMatch(/commission base/);
    expect(plano).not.toMatch(/never carries commission/);
    expect(plano).not.toMatch(/estimated savings are never billed/);
    expect(plano).toContain("Only `measured` and `reference` figures are credited as savings in your report and dashboard");
    // Lo que sí queda: Pro y Team sin comisión, y el plan antiguo explicado como cerrado.
    expect(plano).toMatch(/No commission on your savings/);
    expect(plano).toMatch(/Legacy plans, closed to new customers/);
  });

  it("⛔ las guías enlazadas no nombran una comisión fuera del plan antiguo", () => {
    // herramientas.md conserva una mención en el apartado de la compactación,
    // cuyo texto está en revisión aparte; el resto no la nombra.
    for (const f of ["cache-de-prompt.md", "palancas-de-precio.md", "medir.md"]) {
      expect(leer(`docs/guias/${f}`), f).not.toMatch(/commission/i);
    }
    expect(leer("docs/terminales/README.md")).not.toMatch(/commission/i);
  });
});
