import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import {
  FRASE_CLAVE_DE_SERVICIO_Y_PALANCAS,
  FRASE_DEPENDENCIA_GATEWAY,
  FRASE_DEPENDENCIA_SDK,
  FRASE_ADAPTADOR_SIN_SOLO_OBSERVAR,
  FRASE_LA_CLAVE_SOLO_ANADE,
  FRASE_LA_CLAVE_SOLO_ANADE_ADAPTADOR,
  FRASE_LA_CLAVE_SOLO_ANADE_GATEWAY,
  FRASE_PALANCAS_GATEWAY,
  FRASE_PALANCAS_SDK,
  frasePalancasAdaptador,
  LINEA_MODO_COMUNITARIO,
  LINEA_PALANCAS_SIN_CLAVE,
  LINEA_PALANCAS_SOLO_OBSERVAR,
  LO_QUE_ANADE_LA_NUBE,
  OPCION_SDK_SOLO_OBSERVAR,
  URL_DISPONIBILIDAD,
  VARIABLE_GATEWAY_SOLO_OBSERVAR,
  enLineas,
} from "../gateway/textos-publicos.js";
import { DEFAULT_MAX_STALENESS_SECONDS } from "../src/pipeline/create.js";
import { UMBRAL_REESCRITURA } from "../gateway/tarifa.js";
import { doctor } from "../gateway/doctor.js";
import { cableado } from "../gateway/init-fragmentos.js";
import { conFicheros, detectar, planear, textoDelPlan, type SondaDeProyecto } from "../gateway/init.js";
import { NIVELES_QUE_REBAJAN } from "../gateway/esfuerzo.js";
import { BIN, RAIZ, exigirBinCompilado } from "./helpers/bvsala-proceso.js";

/**
 * LO QUE VIAJA DENTRO DEL PAQUETE DICE LO QUE HACE LA 1.2.4.
 *
 * La auditoría de medios y la investigación de ahorro (grupos m01, m03, m16,
 * m17; hallazgos 39 y 42) encontraron, en el README de npm, el de PyPI, las
 * guías de terminales y la salida de `bvsala`, frases que no se cumplen:
 *
 *   · «every local saving lever on» — en el SDK van seis palancas por defecto y
 *     en el gateway una de cuatro;
 *   · «shared caches» / «shared semantic caches across seats» como lo que se
 *     paga — BiVelio no aloja ninguna caché;
 *   · que la licencia gratuita Measure corre en sombra y que «the levers need a
 *     paid plan» — con la 1.2.4 la clave solo AÑADE la nube;
 *   · dos recetas distintas para conectar el SDK a la nube;
 *   · el −82,76 % sin decir que es con la opción `cachePrefix` y contra la
 *     propia capa sin ella.
 *
 * Cada frase común vive en gateway/textos-publicos.ts y aquí se comprueba que
 * todos los medios dicen ESA, y que las viejas no vuelven.
 */

const leer = (ruta: string): string => readFileSync(join(RAIZ, ruta), "utf8");
const plano = (s: string): string => s.replace(/\s+/g, " ");
const readme = plano(leer("README.md"));
const pypi = plano(leer("packages/python/README.md"));
const guiaDeTerminales = plano(leer("docs/terminales/README.md"));
const guias = readdirSync(join(RAIZ, "docs/terminales")).filter((f) => f.endsWith(".md"));

describe("m17 · una sola frase sobre qué palancas van encendidas, igual en todos los sitios", () => {
  it("el README de npm y el de PyPI dicen la frase del SDK, palabra por palabra", () => {
    expect(readme).toContain(FRASE_PALANCAS_SDK);
    expect(pypi).toContain(FRASE_PALANCAS_SDK);
  });

  it("la frase del SDK nombra las seis de por defecto y ninguna de las que se encienden a mano", () => {
    for (const palanca of [
      "exact cache",
      "deduplication",
      "local resolvers",
      "prompt-cache placement",
      "trimming of superseded tool results",
      "compact serialization",
    ]) {
      expect(FRASE_PALANCAS_SDK).toContain(palanca);
    }
    expect(FRASE_PALANCAS_SDK).not.toMatch(/semantic|cascade|compaction|compress|cachePrefix/i);
  });

  it("el README dice cuáles NO van por defecto: caché semántica en sombra, compactación, cascada y cachePrefix a mano", () => {
    expect(readme).toContain("The semantic cache stays in shadow until you calibrate it on your own traffic.");
    expect(readme).toMatch(/Opt-in: tool-output and context compaction, the model cascade, the cacheable-prefix reorder \(`savings\.cachePrefix`\)/);
  });

  it("el README, PyPI y la guía de terminales dicen la frase del gateway: una de por defecto", () => {
    expect(readme).toContain(FRASE_PALANCAS_GATEWAY);
    expect(pypi).toContain(FRASE_PALANCAS_GATEWAY);
    expect(guiaDeTerminales).toContain(FRASE_PALANCAS_GATEWAY);
    // 1.2.4 · Medir = sin clave; con una licencia de pago, el gateway como la 1.2.3.
    expect(guiaDeTerminales).toContain(FRASE_CLAVE_DE_SERVICIO_Y_PALANCAS);
    expect(guiaDeTerminales).not.toContain("It switches no lever off: the free Measure license");
  });

  it("⛔ nadie vuelve a decir que todo va encendido", () => {
    const vetadas = [/every local (saving )?lever/i, /all local levers/i, /all the local saving/i, /levers? (are )?armed, zero/i, /arms every/i];
    const medios: Record<string, string> = { README: readme, PyPI: pypi };
    for (const g of guias) medios[`docs/terminales/${g}`] = plano(leer(`docs/terminales/${g}`));
    for (const [nombre, texto] of Object.entries(medios)) {
      for (const re of vetadas) expect(texto, `${nombre}: ${re}`).not.toMatch(re);
    }
  });

  it("el README no promete ahorro sin condición: dice dónde ahorra el SDK y cuándo es 0 %", () => {
    expect(readme).not.toMatch(/install it and it saves\./);
    expect(readme).toContain(
      "install it and it saves where your traffic repeats (identical or simultaneous requests) and, on Anthropic, " +
        "where your system prompt is long and stable; traffic that never repeats saves about 0 % by default.",
    );
    expect(readme).toMatch(/a high `temperature`, questions with freshness words \("today", "price"\), or personal wording \("my"\) without a `context\.sessionId`/);
  });
});

describe("m01 · la clave solo añade la nube; Measure ya no apaga nada; la sombra es opcional", () => {
  it("el README y PyPI dicen que la clave no apaga ninguna palanca, con la misma frase", () => {
    expect(readme).toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    expect(pypi).toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    // 1.2.4 · y que en el gateway una licencia de pago va como en la 1.2.3 (decisión del dueño).
    const gateway =
      "In the `bvsala` gateway the free Measure license applies the same levers as no key, and a paid license works " +
      "as in 1.2.3: each lever also needs your organization's license to include it, checked fail-closed.";
    expect(readme).toContain(gateway);
    expect(pypi).toContain(gateway);
  });

  it("⛔ el párrafo de Measure ya no dice sombra forzada, ni «a lower bound, never part of any commission», ni «the levers need a paid plan»", () => {
    expect(readme).not.toMatch(/the layer runs in \*\*shadow mode\*\*/);
    expect(readme).not.toMatch(/it runs the layer in \*\*shadow mode\*\*/);
    expect(readme).not.toContain("a lower bound, never part of any commission");
    expect(readme).not.toMatch(/levers need a paid plan/);
    // Los dos párrafos de Measure son, palabra por palabra, los de la rama
    // fix/measure-ahorra-de-verdad (para que las dos ramas se fusionen sin conflicto).
    // 1.2.4 · decisión del dueño (21-11-2026, 21:45 UTC): Measure aplica EXACTAMENTE
    // las mismas palancas que sin clave; la excepción del recorte es solo de las
    // licencias de pago, y los párrafos de Measure no la mencionan.
    expect(readme.split("the layer applies exactly the same levers as with no key, and your dashboard shows the real savings").length - 1).toBe(2);
    expect(readme).not.toMatch(/Measure[^.]*except that trimming/);
    expect(readme).not.toContain("the free Measure license and a paid one apply the same levers");
    // Verificación 3: el panel ya es gratis con Measure, así que no es lo que añade el pago.
    expect(readme).toContain("What a paid plan adds is the cloud beyond those limits (more seats and more volume), not the saving.");
    expect(readme).toContain("a lower bound, shown apart from measured savings");
  });

  it("la sombra opcional se nombra con LA opción del SDK y LA variable del gateway (un solo sitio: textos-publicos.ts)", () => {
    expect(readme).toContain(
      `**observe-only mode** is an explicit option on any plan — \`${OPCION_SDK_SOLO_OBSERVAR}: true\` in the SDK, \`${VARIABLE_GATEWAY_SOLO_OBSERVAR}=1\` in the gateway.`,
    );
    // En el README solo hay esas dos menciones literales: si los nombres cambian, se cambian aquí y allí.
    expect(readme.match(/observeOnly/g)).toHaveLength(1);
    expect(readme.match(/BVSALA_GATEWAY_OBSERVE_ONLY/g)).toHaveLength(1);
  });
});

describe("m03 · BiVelio no aloja ninguna caché: fuera «shared caches», y la frase del almacén propio", () => {
  it("⛔ ni el README, ni PyPI, ni la descripción de npm venden cachés compartidas", () => {
    const descripcion = (JSON.parse(leer("package.json")) as { description: string }).description;
    for (const [nombre, texto] of Object.entries({ README: readme, PyPI: pypi, "package.json": descripcion })) {
      expect(texto, nombre).not.toMatch(/shared (semantic )?caches/i);
      expect(texto, nombre).not.toMatch(/org entitlements/i);
    }
    expect(descripcion).toContain("the optional cloud adds the team dashboard and shared measurement");
  });

  it("lo que se paga es lo mismo en el README, en `--help`, en `doctor` y en `init`", () => {
    expect(LO_QUE_ANADE_LA_NUBE).toBe("the team dashboard, shared measurement, seats and license management");
    // En el README la frase aparece partida por «for a fixed fee»; se comprueban sus cuatro piezas juntas.
    expect(readme).toContain("A BiVelio key adds the team dashboard, shared measurement, seats and license management");
    expect(readme).toContain("| Team dashboard, shared measurement, seats and license management | — | ✅ |");
  });

  it("compartir caché entre máquinas es gratis y con un almacén del cliente (por ejemplo Redis); PostgreSQL aún no está en npm", () => {
    expect(readme).toContain("BiVelio hosts no cache.");
    expect(readme).toMatch(/Give the layer a store you run through the `exactCache` option: you implement three methods \(`get`, `set`, `delete`\) over any key-value store your instances share, such as Redis\. It is free, needs no key, and the cached answers stay in your infrastructure, never in BiVelio's\./);
    expect(readme).toContain("A PostgreSQL adapter is a release candidate and is not on npm yet.");
    expect(readme).toContain("| One cache for several machines, in a store you run (for example Redis) | ✅ | ✅ |");
    expect(readme).not.toMatch(/own PostgreSQL/);
    expect(pypi).toContain("BiVelio hosts no cache.");
  });
});

describe("m16 · el README no promete una compresión que el paquete no trae", () => {
  it("dice que el paquete no trae compresor y que la compactación es opcional y sin cifra publicada", () => {
    expect(readme).toContain(
      "The package ships no compressor: compaction is a lossless rewrite of JSON tool outputs that runs only when you switch it on, and no compression figure is published.",
    );
    expect(readme).toContain("the default compressor does nothing (the package ships no compressor: bring your own)");
    expect(readme).not.toContain("| Compression, output contracts, four savings ledgers |");
    expect(readme).not.toContain("context and tool-output compaction, serialization), and routes");
  });
});

describe("el −82,76 % dice con qué opción y contra qué", () => {
  it("README: con `savings.cachePrefix: true`, contra la propia capa sin esa opción", () => {
    const frase = readme.slice(readme.indexOf("**Exploratory live A/B (20 requests per arm)**"));
    const hasta = frase.slice(0, frase.indexOf("−82.76 %") + 10);
    expect(hasta).toContain("with the opt-in `savings.cachePrefix: true` against the layer itself without that option");
    expect(hasta).toContain("not against calling the provider directly");
  });

  it("PyPI: lo mismo, en su titular", () => {
    expect(pypi).toMatch(/with the opt-in `savings\.cachePrefix: true` against the layer itself without that option: 0 % → 95 % hit-rate, −82\.76 % per request/);
  });

  it("⛔ lo que arregló la auditoría sigue: el titular «recomputed from the public artifacts»", () => {
    expect(leer("README.md")).toContain("### Measured, not promised — recomputed from the public artifacts");
  });
});

describe("Claude Code: el paquete dice que el gateway MIDE, no promete ahorro", () => {
  it("el README, PyPI y la guía de Claude Code dicen cuándo actúa la única palanca de por defecto", () => {
    expect(readme).toMatch(/With a coding agent, the local gateway measures your spend/);
    expect(pypi).toContain("by default only one acts: cache TTL tuning, which saves only when your client pays per token and asks for the one-hour cache");
    expect(pypi).toContain("OpenAI traffic is measured when the request reports usage, and by default it is never changed.");
    const claude = plano(leer("docs/terminales/claude-code.md"));
    expect(claude).toMatch(/By default the gateway \*\*measures\*\* there/);
    expect(claude).toContain("with a claude.ai login, or on an API key with the five-minute cache, that is $0.00 and the line says why");
  });

  it("las guías de terminales ya no dicen «all the local saving» ni «org entitlements»", () => {
    for (const g of guias) {
      const texto = plano(leer(`docs/terminales/${g}`));
      expect(texto, g).not.toMatch(/org(?:'s)? entitlements|the org's entitlements/);
    }
  });

  it("la guía enseña el cartel y el resumen de salida tal como salen ahora", () => {
    const guia = leer("docs/terminales/README.md");
    expect(guia).toContain(`[bvsala gateway] ${LINEA_MODO_COMUNITARIO}`);
    expect(guia).toContain(`[bvsala gateway] ${LINEA_PALANCAS_SIN_CLAVE} · context elision dials OFF`);
    expect(guia).toContain("spent $1.84 at list-price equivalent (subscription traffic: there is no per-token invoice)");
    expect(guia).toContain("saved $0.0410 (measured)");
  });

  it("docs/guias/herramientas.md ya no habla de «any commission»", () => {
    expect(leer("docs/guias/herramientas.md")).not.toMatch(/or any commission/);
  });
});

describe("el cartel de arranque (grupo 1) dice la verdad en una línea", () => {
  it("qué actúa por defecto, que con suscripción solo mide, y la variable exacta de cada una de las demás", () => {
    expect(LINEA_PALANCAS_SIN_CLAVE).toContain("cache TTL tuning is the only one ON by default");
    expect(LINEA_PALANCAS_SIN_CLAVE).toContain("on a Claude or ChatGPT subscription the default lever changes nothing and this run only measures");
    expect(LINEA_PALANCAS_SIN_CLAVE).toContain("BVSALA_GATEWAY_ELISION=0 turns it off");
    expect(LINEA_PALANCAS_SIN_CLAVE).toContain("BVSALA_GATEWAY_SIBLING_MODEL=1");
    // Los niveles que el cartel anuncia son los que la palanca acepta.
    expect(LINEA_PALANCAS_SIN_CLAVE).toContain(`BVSALA_GATEWAY_EFFORT=${NIVELES_QUE_REBAJAN.join("|")}`);
    expect(LINEA_PALANCAS_SIN_CLAVE).not.toMatch(/levers: ON|every|all levers/i);
    expect(LINEA_MODO_COMUNITARIO).not.toMatch(/every local saving lever/);
  });
});

describe("hallazgo 42 · una sola receta para conectar el SDK a la nube: la del panel", () => {
  const RECETA = [
    "licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,",
    'licenseServerUrl: "https://savings.bivelio.com",',
    "serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,",
  ];

  it("`init` la escribe en el cableado de todas las pilas", () => {
    const codigo = cableado("sdk", "openai");
    for (const linea of RECETA) expect(codigo).toContain(linea);
    expect(codigo).toContain("A key only adds the cloud: the free Measure");
    expect(plano(codigo)).toContain("license applies exactly the same levers as no key (with a paid license, the SDK only trims superseded");
    expect(codigo).not.toContain("except that with");
    expect(codigo).not.toContain("switches no");
    expect(codigo).not.toMatch(/every local/);
  });

  it("el README trae las mismas tres líneas, las dos veces, y ya no la receta a medias", () => {
    const crudo = leer("README.md");
    for (const linea of RECETA) expect(crudo.split(`//   ${linea}`).length - 1, linea).toBe(2);
    expect(crudo).not.toContain("//   // licenseKey");
    expect(crudo).not.toMatch(/^ {2}\/\/ {3}serviceAccountKey: process\.env\.BIVELIO_SERVICE_KEY,$/m);
    expect(readme).toContain("One recipe, the same one your dashboard and `npx @bivelio/savings-layer init` print");
  });
});

describe("`bvsala doctor` e `init` (grupo 3)", () => {
  it("doctor: una palanca por defecto, y la clave solo añade la nube", async () => {
    const { texto } = await doctor(8402, { home: "/casa/prueba", path: "", existe: () => false, enPath: () => false });
    expect(texto).toContain(FRASE_PALANCAS_GATEWAY);
    expect(texto).toContain(`BIVELIO_SERVICE_KEY only adds the cloud (${LO_QUE_ANADE_LA_NUBE}).`);
    // 1.2.4 · Medir = sin clave; con una licencia de pago, como en la 1.2.3 (decisión del dueño).
    expect(plano(texto)).toContain(FRASE_CLAVE_DE_SERVICIO_Y_PALANCAS);
    expect(texto).not.toContain("it switches no lever off.");
    expect(plano(texto)).toContain(FRASE_DEPENDENCIA_GATEWAY);
    expect(texto).not.toMatch(/every local saving lever|org entitlements/);
  });

  it("init: la frase del SDK, la de la clave y la opción de solo observar", () => {
    const s: SondaDeProyecto = {
      leer: (ruta) => (ruta === "/p/app/package.json" ? JSON.stringify({ name: "app", type: "module", dependencies: { openai: "^5.0.0" } }) : undefined),
      existe: (ruta) => ruta === "/p/app/package.json",
    };
    const d = detectar("/p/app", s);
    if (!d.ok) throw new Error(d.mensaje);
    const p = planear(d.valor, {}, { node: "22.14.0", env: () => false });
    if (!p.ok) throw new Error(p.mensaje);
    const texto = textoDelPlan(conFicheros(p.valor, s), "bvsala init", "bvsala init");
    const junto = plano(texto);
    expect(junto).toContain(FRASE_PALANCAS_SDK);
    expect(junto).toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    expect(junto).toContain(FRASE_DEPENDENCIA_SDK);
    expect(junto).toContain(`add ${LO_QUE_ANADE_LA_NUBE}.`);
    expect(junto).toContain(`To only observe, without changing any request: \`${OPCION_SDK_SOLO_OBSERVAR}: true\`.`);
    expect(junto).not.toMatch(/every local lever|team metering/);
    const claves = texto.split("\n").filter((l) => /^ {2}BIVELIO_(LICENSE|SERVICE)_KEY/.test(l));
    expect(claves).toHaveLength(2);
    for (const l of claves) expect(l).toMatch(/OPTIONAL/);
    expect(claves.join("\n")).toContain("a key only adds the cloud");
  });

  // Auditoría de lo gratis (21-11-2026): `init` prometía a los adaptadores la
  // colocación de caché, el recorte, la serialización y `observeOnly: true`, que
  // no tienen (anthropicSavings({ observeOnly: true }) lo ignora y sirve de caché).
  it.each([
    ["ai-sdk", { ai: "^6.0.0", "@ai-sdk/openai": "^2.0.0" }],
    ["mastra", { "@mastra/core": "^1.68.0" }],
    ["langchain", { langchain: "^1.1.0", "@langchain/core": "^1.1.0", "@langchain/openai": "^1.0.0" }],
    ["anthropic-sdk", { "@anthropic-ai/sdk": "^0.103.0" }],
  ] as const)("init en la pila %s: las palancas del adaptador, sin observeOnly ni palancas que no tiene", (capa, deps) => {
    const s: SondaDeProyecto = {
      leer: (ruta) => (ruta === "/p/app/package.json" ? JSON.stringify({ name: "app", type: "module", dependencies: deps }) : undefined),
      existe: (ruta) => ruta === "/p/app/package.json",
    };
    const d = detectar("/p/app", s);
    if (!d.ok) throw new Error(d.mensaje);
    const p = planear(d.valor, { capa }, { node: "22.14.0", env: () => false });
    if (!p.ok) throw new Error(p.mensaje);
    expect(p.valor.capa).toBe(capa);
    const junto = plano(textoDelPlan(conFicheros(p.valor, s), "bvsala init", "bvsala init"));
    expect(junto).toContain(frasePalancasAdaptador(capa === "mastra"));
    expect(junto).toContain(FRASE_LA_CLAVE_SOLO_ANADE_ADAPTADOR);
    expect(junto).toContain(FRASE_ADAPTADOR_SIN_SOLO_OBSERVAR);
    expect(junto).toContain(FRASE_DEPENDENCIA_SDK);
    expect(junto).not.toContain(FRASE_PALANCAS_SDK);
    expect(junto).not.toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    expect(junto).not.toContain("On by default:");
    expect(junto).not.toContain("To only observe");
    expect(junto).not.toContain(`${OPCION_SDK_SOLO_OBSERVAR}: true`);
    if (capa === "mastra") expect(junto).not.toContain("in flight");
    else expect(junto).toContain("identical requests already in flight");
  });

  it("las frases del adaptador son las del README (Inside your framework y solo observar)", () => {
    expect(readme).toContain(FRASE_ADAPTADOR_SIN_SOLO_OBSERVAR);
    expect(readme).toContain("They never rewrite what your framework sends.");
    expect(readme).toContain("identical requests in flight are not shared here");
    expect(frasePalancasAdaptador(false)).toContain("it never rewrites what your framework sends");
    expect(frasePalancasAdaptador(true)).not.toContain("in flight");
  });

  it("enLineas parte por palabras, respeta el ancho y no pierde ni una", () => {
    const lineas = enLineas(FRASE_PALANCAS_SDK, 60, "    ");
    expect(lineas.length).toBeGreaterThan(2);
    for (const l of lineas) {
      expect(l.length).toBeLessThanOrEqual(60);
      expect(l.startsWith("    ")).toBe(true);
    }
    expect(plano(lineas.map((l) => l.trim()).join(" "))).toBe(FRASE_PALANCAS_SDK);
    expect(enLineas("", 10)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("`bvsala --help` (grupo 3), ejecutado de verdad", () => {
  let ayuda = "";
  beforeAll(() => {
    exigirBinCompilado();
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status).toBe(0);
    ayuda = plano(r.stdout);
  });

  it("dice las dos frases comunes y nombra la variable de solo observar", () => {
    expect(ayuda).toContain(FRASE_PALANCAS_GATEWAY);
    // El gateway no tiene el recorte de resultados sustituidos: su ayuda dice la
    // frase sin la excepción del SDK.
    expect(ayuda).toContain(FRASE_LA_CLAVE_SOLO_ANADE_GATEWAY);
    expect(ayuda).not.toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    expect(ayuda).toContain(FRASE_DEPENDENCIA_GATEWAY);
    expect(ayuda).toContain(`To only observe, without changing any request, set ${VARIABLE_GATEWAY_SOLO_OBSERVAR}=1.`);
    expect(ayuda).toContain(`BIVELIO_SERVICE_KEY only adds the cloud: ${LO_QUE_ANADE_LA_NUBE}.`);
  });

  it("⛔ no dice que todo va encendido; con Medir no apaga nada y con pago, como en la 1.2.3", () => {
    // 1.2.4 · decisiones del dueño (21-11-2026): Medir = sin clave; con una
    // licencia de pago, el gateway como en la 1.2.3 de pago. Una rama previa
    // decía «It switches no lever off.» para cualquier licencia, y con pago y la
    // nube caída no era cierto.
    expect(ayuda).not.toMatch(/feature list decide/);
    expect(ayuda).not.toMatch(/every local (saving )?lever|all local levers|arms every local/);
    expect(ayuda).not.toContain("It switches no lever off.");
    expect(ayuda).toContain("With the free Measure license it switches no lever off; with a paid license the levers follow that license, as in 1.2.3");
  });

  it("⛔ describe la rebaja de TTL como la decide el código: solo con mucho cuerpo nuevo, nunca en turnos encadenados", () => {
    // Verificación final de la 1.2.4, bloqueante 4: decía «while the session stays
    // warm» (lo contrario de gateway/tarifa.ts decidirRebaja) y citaba un 99,1 % y
    // un 8,0 % sin fuente en el repositorio.
    expect(ayuda).toContain(`at least ${Math.round(UMBRAL_REESCRITURA * 100)}% of the body`);
    expect(ayuda).toContain("chained turns keep the 1h cache");
    expect(ayuda).not.toMatch(/stays warm|99\.1%|8\.0% of the cost/);
    // La cifra que sí cita tiene fuente: el replay de la página de benchmarks (apps/web/lib/portada/palanca-ttl.ts).
    expect(ayuda).toContain("a counterfactual replay, not an A/B) it left a net 2.49% of the list-price bill");
    expect(leer("apps/web/lib/portada/palanca-ttl.ts")).toContain("neto: { point: 0.0249,");
  });

  it("dice que con suscripción solo mide, que los diales van apagados y qué imprime al salir", () => {
    expect(ayuda).toContain("On a Claude or ChatGPT subscription, with the defaults, it only measures.");
    expect(ayuda).toContain("Its dials are OFF unless you also set BVSALA_GATEWAY_DIALES_ELISION=1");
    expect(ayuda).toContain("what they cost at list price, what the levers saved (or why nothing was saved)");
  });
});

describe("los nombres de solo observar que cita el paquete existen en el código (revisión de #613)", () => {
  it("⛔ `observeOnly` (SDK) y `BVSALA_GATEWAY_OBSERVE_ONLY` (gateway) están en src/ y gateway/: este PR no puede publicarse sin el de Measure", () => {
    expect(leer("src/pipeline/config.ts")).toMatch(/observeOnly\??:/);
    expect(leer("gateway/bin.ts")).toContain("BVSALA_GATEWAY_OBSERVE_ONLY");
  });
});

/**
 * VERIFICACIÓN FINAL DE LA 1.2.4 (lente de textos, bloqueantes 2, 3 y 4).
 *
 * Lo que una persona que llega desde Product Hunt lee antes que nada: las dos
 * cifras de cabecera con su condición, qué dependencia trae una clave y cómo
 * actúa la única palanca del gateway que va encendida por defecto.
 */
describe("verificación final 1.2.4 · la clave trae una dependencia, y se dice", () => {
  it("las 72 h del texto son las del código (DEFAULT_MAX_STALENESS_SECONDS)", () => {
    expect(DEFAULT_MAX_STALENESS_SECONDS / 3600).toBe(72);
    expect(FRASE_DEPENDENCIA_SDK).toContain(`${DEFAULT_MAX_STALENESS_SECONDS / 3600} hours`);
    expect(FRASE_DEPENDENCIA_SDK).toContain("`licenseServerUrl`");
    expect(FRASE_DEPENDENCIA_SDK).toContain("`LicenseError`");
    expect(FRASE_DEPENDENCIA_SDK).toContain("the free Measure key included");
    expect(FRASE_DEPENDENCIA_SDK).toContain("With no key there is no such dependency.");
    expect(FRASE_DEPENDENCIA_GATEWAY).toContain("With no key there is no such dependency.");
  });

  it("el README la dice en «Community vs Cloud» y en el paso 2, con enlace a SECURITY.md (Availability)", () => {
    expect(readme.split(FRASE_DEPENDENCIA_SDK).length - 1).toBe(2);
    expect(readme).toContain(URL_DISPONIBILIDAD);
    // El ancla existe en SECURITY.md.
    expect(leer("SECURITY.md")).toMatch(/^## Availability: what happens if our servers do not respond$/m);
    // El resumen de arriba no promete «solo añade» sin el matiz.
    expect(readme).toContain(
      "A key only adds the cloud: the free Measure license applies exactly the same levers as no key (paid licenses have two exceptions: trimming of superseded tool results in the SDK, and the gateway, which works as in 1.2.3), and a key ties the layer to savings.bivelio.com",
    );
    expect(readme).not.toContain("Take it and nothing is switched off either");
  });

  it("la ficha de PyPI y la guía de terminales dicen la del gateway (arrancar, no 72 h)", () => {
    expect(pypi).toContain(FRASE_DEPENDENCIA_GATEWAY);
    expect(guiaDeTerminales).toContain(FRASE_DEPENDENCIA_GATEWAY);
  });

  it("el cableado de `init` lo dice junto a las tres líneas de la receta", () => {
    const codigo = plano(cableado("sdk", "openai"));
    expect(codigo).toContain("with a key the layer // needs savings.bivelio.com: 72 hours with no answer from it");
  });

  it("la tarjeta de la nube ya no dice «a fixed fee per seat» sin más: Measure es gratis", () => {
    expect(readme).toContain("free on Measure, a fixed subscription on Pro and Team, and never a commission on what you save");
    expect(readme).not.toContain("The cloud is the paid, optional part.");
  });
});

describe("verificación final 1.2.4 · las cifras de cabecera llevan su condición", () => {
  it("README: carga construida con preguntas de GSM8K, 30 % de repeticiones exactas, ~41 puntos de caché de Anthropic", () => {
    expect(readme).not.toContain("Pooled reductions on the public GSM8K benchmark");
    expect(readme).toContain("**Pooled reductions on a public workload built from GSM8K questions, 30 % of them exact repeats**");
    expect(readme).toContain("SDK 0.4.31 artifacts from September 2026, recomputed offline with no new provider calls");
    expect(readme).toContain("about 41 points of which are a descriptive contrast of Anthropic's cache pricing");
    expect(readme).toContain("pooled reductions of **31.50 %** and **75.08 %** on a workload with 30 % exact repeats");
    // El −82,76 % dice con qué versión y cuándo se midió.
    expect(readme).toContain("−82.76 % cost per request in that constructed sequence (measured with 1.2.0 on 15 Nov 2026;");
  });

  it("PyPI: lo mismo en su titular", () => {
    expect(pypi).toContain("31.50 % / 75.08 % on a public workload built from GSM8K questions, 30 % of them exact repeats");
    expect(pypi).toContain("about 41 points of the 75.08 % are Anthropic's cache pricing");
  });

  it("las cifras que se citan son las del paper (30 % de repeticiones, 41,08 puntos)", () => {
    const paper = plano(leer("docs/PAPER.md"));
    expect(paper).toContain("30 % exact-repeat");
    expect(paper).toContain("41.08 percentage points");
    expect(paper).toContain("SDK 0.4.31");
  });
});

describe("verificación final 1.2.4 · la guía de terminales describe la palanca de TTL como el código", () => {
  it("solo con mucho cuerpo nuevo; los turnos encadenados no se tocan; sin «stays warm»", () => {
    expect(guiaDeTerminales).toContain(
      "lowers the cache-write TTL from one hour to five minutes only on turns where a large part of the prompt is new " +
        `(at least ${Math.round(UMBRAL_REESCRITURA * 100)} % of the request body`,
    );
    expect(guiaDeTerminales).toContain("leaves chained turns as they are");
    for (const g of guias) expect(plano(leer(`docs/terminales/${g}`)), g).not.toMatch(/stays warm|99\.1 ?%/);
  });

  it("la línea de ejemplo de suscripción es la que imprime recuento.ts", () => {
    expect(guiaDeTerminales).toContain(
      "saved $0.00: no saving is credited on a subscription (there is no per-token invoice); with the defaults the gateway changes nothing there.",
    );
    expect(guiaDeTerminales).not.toContain("on a subscription the gateway only measures and changes nothing");
  });
});

describe("verificación final 1.2.4 · el cartel y los ejemplos", () => {
  it("el cartel nombra la variable de los diales", () => {
    expect(leer("docs/terminales/README.md")).toContain("context elision dials OFF (BVSALA_GATEWAY_DIALES_ELISION=1 turns them on)");
    expect(readme).toContain("except `BVSALA_GATEWAY_DIALES_ELISION` (the context elision dials, off by default)");
  });

  it("en modo solo-observar el cartel no dice que la rebaja de TTL va encendida", () => {
    expect(LINEA_PALANCAS_SOLO_OBSERVAR).toContain("OBSERVE-ONLY");
    expect(LINEA_PALANCAS_SOLO_OBSERVAR).toContain(`${VARIABLE_GATEWAY_SOLO_OBSERVAR}=1`);
    expect(LINEA_PALANCAS_SOLO_OBSERVAR).toContain("no lever is applied");
    expect(LINEA_PALANCAS_SOLO_OBSERVAR).not.toMatch(/ON by default|ARMED/);
  });

  it("⛔ los ejemplos del repositorio ya no dicen que el paquete necesita licencia", () => {
    for (const f of ["examples/stacks/README.md", "examples/stacks/nextjs/run.ts"]) {
      const texto = plano(leer(f));
      expect(texto, f).not.toMatch(/no unlicensed mode|needs? `?BIVELIO_LICENSE_KEY`?/);
      expect(texto, f).toMatch(/COMMUNITY mode: free, nothing sent to BiVelio/);
    }
  });

  it("el README no dice que el SDK y el gateway sean lo mismo: el gateway es un proxy local", () => {
    expect(readme).toContain("the SDK is a library inside your code, never a middleman server (the optional gateway is a local proxy on your own machine)");
  });

  it("solo observar: el README dice qué informa cada uno, y que los adaptadores no lo tienen", () => {
    expect(readme).toContain("In the SDK, `report.measure.wouldHaveSaved`");
    expect(readme).toContain("In the gateway, a `measure (shadow)` log line says what cache TTL tuning and the sibling model would have saved");
    expect(readme).toContain("The framework adapters have no observe-only mode");
  });
});

/**
 * VERIFICACIÓN 2 DE LA 1.2.4: al integrar un borrador se coló en CHANGELOG.md la
 * mitad de un comentario HTML con notas internas en español («AÑADE el de la
 * elisión…», «Ver gate-medir/.») y un «-->» suelto. CHANGELOG.md va en el
 * tarball de npm (`files`) y se ve en GitHub, y release-candidate.test.ts pasó
 * con ello dentro. Aquí se exige que ningún .md que se publica tenga un
 * comentario a medias, y que la entrada 1.2.4 esté entera en inglés.
 */
describe("verificación 2 · los .md que se publican no llevan notas internas", () => {
  const paquete = JSON.parse(leer("package.json")) as { files: string[] };
  const mdDe = (ruta: string): string[] => {
    const abs = join(RAIZ, ruta);
    let entradas: import("node:fs").Dirent[];
    try {
      entradas = readdirSync(abs, { withFileTypes: true });
    } catch {
      return ruta.endsWith(".md") ? [ruta] : [];
    }
    return entradas.flatMap((e) => mdDe(join(ruta, e.name)));
  };
  const publicados = [...new Set(["CHANGELOG.md", ...paquete.files.flatMap(mdDe)])];
  const cuenta = (texto: string, aguja: string): number => texto.split(aguja).length - 1;

  it("en CHANGELOG.md y en cada .md de `files` hay tantos «<!--» como «-->»", () => {
    expect(publicados).toContain("CHANGELOG.md");
    expect(publicados).toContain("README.md");
    expect(publicados.some((f) => f.startsWith("docs/terminales/"))).toBe(true);
    for (const f of publicados) {
      const texto = leer(f);
      expect(cuenta(texto, "<!--"), f).toBe(cuenta(texto, "-->"));
    }
  });

  it("la entrada 1.2.4 del CHANGELOG no lleva «AÑADE», «gate-medir» ni texto en español", () => {
    const changelog = leer("CHANGELOG.md");
    const desde = changelog.indexOf("## 1.2.4");
    expect(desde).toBeGreaterThan(-1);
    const hasta = changelog.indexOf("\n## ", desde + 1);
    const entrada = changelog.slice(desde, hasta === -1 ? undefined : hasta);
    expect(entrada.length).toBeGreaterThan(2000);
    expect(entrada).not.toContain("AÑADE");
    expect(entrada).not.toContain("gate-medir");
    expect(entrada).not.toContain("<!--");
    expect(entrada).not.toContain("-->");
    // Letras y signos que el inglés no usa, y palabras corrientes del español.
    expect(entrada.match(/[ñÑáéíóúÁÉÍÓÚ¿¡«»]/g)).toBeNull();
    expect(
      entrada.match(
        /\b(que|los|las|del|para|hasta|esta|rama|cifras|ambos|incluidos|proveedor|coste|frente|reloj|una|lectura|caduca|elisión|todavía|existe|añade|verja|recorte)\b/gi,
      ),
    ).toBeNull();
  });
});

/**
 * AUDITORÍA DE LO GRATIS (21-11-2026). Un bloque que se pega entero tiene que
 * arrancar gratis: una línea de ejemplo con la clave SIN COMENTAR deja el
 * marcador (`bvk_…`, `…`) como clave, y entonces el gateway sale con exit 1 («does
 * not start without a verified license») y el SDK falla cerrado con
 * LicenseError. Además, la tabla de palancas de la guía y la forma del README.
 */
describe("auditoría de lo gratis · los bloques que se pegan arrancan sin clave", () => {
  const ASIGNACION = /^\s*(?:export\s+|\$env:|set\s+)BIVELIO_(?:SERVICE|LICENSE)_KEY\s*=/;

  /** Las líneas de los bloques de código (```…```) de un .md. */
  const lineasDeCodigo = (md: string): string[] => {
    const fuera: string[] = [];
    let dentro = false;
    for (const l of md.split("\n")) {
      if (/^\s*```/.test(l)) {
        dentro = !dentro;
        continue;
      }
      if (dentro) fuera.push(l);
    }
    return fuera;
  };

  it("⛔ ningún bloque del README, de PyPI ni de docs/terminales asigna una clave de BiVelio sin comentar", () => {
    const medios: Record<string, string> = { "README.md": leer("README.md"), "packages/python/README.md": leer("packages/python/README.md") };
    for (const g of guias) medios[`docs/terminales/${g}`] = leer(`docs/terminales/${g}`);
    for (const [nombre, md] of Object.entries(medios)) {
      for (const l of lineasDeCodigo(md)) expect(l, `${nombre}: ${l}`).not.toMatch(ASIGNACION);
    }
  });

  it("las líneas comentadas siguen ahí y dicen que son OPCIONALES", () => {
    const crudo = leer("README.md");
    expect(crudo).toContain("# export BIVELIO_LICENSE_KEY=…   # OPTIONAL: a key that IS set but invalid still fails closed");
    expect(crudo).toContain("# export BIVELIO_SERVICE_KEY=…   # OPTIONAL: usage to your dashboard + license auto-renewal");
    for (const g of ["README.md", "claude-code.md", "codex.md", "kilo.md", "qwen-code.md", "goose.md", "opencode.md"]) {
      expect(leer(`docs/terminales/${g}`), g).toMatch(/^# export BIVELIO_SERVICE_KEY=bvk_… +# OPTIONAL: only adds the cloud dashboard; uncomment it with your real key/m);
    }
    expect(leer("docs/terminales/README.md")).toMatch(/^# \$env:BIVELIO_SERVICE_KEY = "bvk_…" +# OPTIONAL/m);
  });

  it("la tabla de palancas de la guía dice cuándo va armada la de TTL: sin clave y con Measure; con pago, si la licencia la incluye", () => {
    expect(guiaDeTerminales).toContain(
      "Cache TTL (`cache_ttl_tuning`, armed by default with no key and with Measure; with a paid license, only if the license includes it (fail-closed))",
    );
    expect(guiaDeTerminales).not.toContain("armed by default in community and PRO");
  });

  it("README: «In the local gateway, every gateway lever…» va en la misma frase, sin una mayúscula a media línea", () => {
    const crudo = leer("README.md");
    expect(crudo).toContain("no compression figure is published. In the local gateway, every gateway lever is free, with no key;");
    expect(crudo).not.toMatch(/In the local gateway:\nEvery gateway lever/);
  });
});

describe("LICENSE-CLOUD §1 dice lo que hace una licencia de pago en el gateway (verificación final)", () => {
  it("con licencia de pago, el gateway funciona como en la 1.2.3 (fail-closed), y no solo «the same levers»", () => {
    const lc = leer("LICENSE-CLOUD.md").replace(/\s+/g, " ");
    expect(lc).toContain("in the local gateway each lever also requires your organization's license to include it, checked fail-closed, as in version 1.2.3");
    expect(lc).not.toMatch(/Under a paid license \(Pro, Team, Enterprise\) the Software applies the same levers too/);
  });
  it("la entrada 1.2.4 del CHANGELOG no cuenta estados intermedios que nunca se publicaron", () => {
    const ch = leer("CHANGELOG.md");
    const e = ch.slice(ch.indexOf("## 1.2.4"), ch.indexOf("\n## 1.2.3"));
    expect(e).not.toMatch(/\+21\.9 %/);
  });
});
