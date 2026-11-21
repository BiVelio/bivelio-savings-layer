import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import {
  FRASE_LA_CLAVE_SOLO_ANADE,
  FRASE_PALANCAS_GATEWAY,
  FRASE_PALANCAS_SDK,
  LINEA_MODO_COMUNITARIO,
  LINEA_PALANCAS_SIN_CLAVE,
  LO_QUE_ANADE_LA_NUBE,
  OPCION_SDK_SOLO_OBSERVAR,
  VARIABLE_GATEWAY_SOLO_OBSERVAR,
  enLineas,
} from "../gateway/textos-publicos.js";
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
  });

  it("⛔ el párrafo de Measure ya no dice sombra forzada, ni «a lower bound, never part of any commission», ni «the levers need a paid plan»", () => {
    expect(readme).not.toMatch(/the layer runs in \*\*shadow mode\*\*/);
    expect(readme).not.toMatch(/it runs the layer in \*\*shadow mode\*\*/);
    expect(readme).not.toContain("a lower bound, never part of any commission");
    expect(readme).not.toMatch(/levers need a paid plan/);
    // Los dos párrafos de Measure son, palabra por palabra, los de la rama
    // fix/measure-ahorra-de-verdad (para que las dos ramas se fusionen sin conflicto).
    expect(readme).toContain("the layer saves exactly as it does with no key, and your dashboard shows the real savings");
    expect(readme).toContain("What a paid plan adds is the cloud beyond those limits (more seats, more volume, the team dashboard), not the saving.");
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
    expect(codigo).toContain("A key only adds the cloud: it switches no");
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
    expect(texto).toContain(`BIVELIO_SERVICE_KEY only adds the cloud (${LO_QUE_ANADE_LA_NUBE}); it switches no lever off.`);
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
    expect(junto).toContain(`add ${LO_QUE_ANADE_LA_NUBE}.`);
    expect(junto).toContain(`To only observe, without changing any request: \`${OPCION_SDK_SOLO_OBSERVAR}: true\`.`);
    expect(junto).not.toMatch(/every local lever|team metering/);
    const claves = texto.split("\n").filter((l) => /^ {2}BIVELIO_(LICENSE|SERVICE)_KEY/.test(l));
    expect(claves).toHaveLength(2);
    for (const l of claves) expect(l).toMatch(/OPTIONAL/);
    expect(claves.join("\n")).toContain("a key only adds the cloud");
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
    expect(ayuda).toContain(FRASE_LA_CLAVE_SOLO_ANADE);
    expect(ayuda).toContain(`To only observe, without changing any request, set ${VARIABLE_GATEWAY_SOLO_OBSERVAR}=1.`);
    expect(ayuda).toContain(`BIVELIO_SERVICE_KEY only adds the cloud: ${LO_QUE_ANADE_LA_NUBE}.`);
  });

  it("⛔ ya no dice que una licencia de organización decide qué palancas aplican, ni que todo va encendido", () => {
    expect(ayuda).not.toMatch(/feature list decide/);
    expect(ayuda).not.toMatch(/with an organization license, only if it includes/);
    expect(ayuda).not.toMatch(/every local (saving )?lever|all local levers|arms every local/);
    expect(ayuda).toContain("It switches no lever off.");
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
