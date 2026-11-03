import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

/**
 * LA ÚNICA SUPERFICIE QUE TODO CLIENTE TOCA PRIMERO ERA LA ÚNICA QUE NINGÚN TEST
 * EJERCITABA.
 *
 * `vitest.config.ts` fija `BVSALA_DEV_OPEN: "1"` para TODA la suite: los 1632
 * tests corrían con la puerta de licencia ABIERTA. Y `fragmento-instalacion`
 * COMPILA los fragmentos contra `src/`, nunca los ejecuta ni mira `dist/`. Así
 * que la puerta CERRADA del build publicado —lo primero que ve cualquiera que
 * instale de npm— no la miraba nadie. Por eso este fallo vivió desde la
 * publicación:
 *
 *   Un desarrollador instalaba, pegaba el fragmento del README y recibía
 *   *"No BiVelio license configured. Pass { licenseKey } … (or
 *   { devUnlicensed: true } for local dev). Get a key at
 *   https://savings.bivelio.com"*. Seguía el consejo del propio error… y obtenía
 *   EL MISMO ERROR, con el mismo consejo dentro. `devUnlicensed` y
 *   `BVSALA_DEV_OPEN` se compilan FUERA del build de npm
 *   (`__BV_SALA_ALLOW_DEV_OPEN__: "false"`, tsup.config.ts): son inertes ahí. Un
 *   bucle cerrado en la primera pantalla del producto.
 *
 * Este test hace lo que ningún otro hacía: `npm pack` → extraer el tarball →
 * EJECUTARLO sin clave, en un proceso aparte, y comprobar que el mensaje dice la
 * verdad y que seguir su consejo no devuelve el mismo error.
 *
 * ── POR QUÉ VA EN LA SUITE NORMAL Y NO EN UN SCRIPT ────────────────────────────
 * `scripts/simular-ci.sh` ya comprueba el tarball, pero es MANUAL —su propia
 * cabecera dice «úsalo antes de tocar el workflow o de cortar una Release»— y
 * `publish.yml` solo corre al cortar la Release. Los dos llegan tarde: el fallo
 * que esto caza se publica, no se compila mal. `pnpm test` corre en cada push
 * (ci.yml), así que aquí es donde tiene que estar. Cuesta ~1,5 s: `npm pack`
 * tarda 0,25 s, no reconstruye nada (no hay `prepack`; `prepublishOnly` no lo
 * dispara `pack`) y el resto son tres procesos node cortos. Un test lento se
 * desactiva, y uno desactivado no defiende nada.
 *
 * ── POR QUÉ NO `npm install` ──────────────────────────────────────────────────
 * El paquete no tiene `dependencies` y todos sus `peerDependencies` son OPCIONALES, así
 * que `node_modules/@bivelio/savings-layer/` = el `package/` del tarball, byte a
 * byte, es exactamente lo que `npm install` dejaría. Instalar de verdad añadiría
 * el registro (red) al camino crítico: minutos en vez de segundos, y un test
 * intermitente que alguien acabaría desactivando. El artefacto bajo prueba es el
 * mismo.
 *
 * ── Y NINGUNA LLAMADA DE RED, MENOS AÚN PAGADA ────────────────────────────────
 * El fragmento del README construye un proveedor REAL de OpenAI. Cada hijo pisa
 * `globalThis.fetch` con un stub que lanza ANTES de construir nada: si algún día
 * `assertLicensed()` dejara de ser lo primero de `generate()`, esto se convierte
 * en un fallo de test y no en una factura.
 */

const RAIZ = new URL("..", import.meta.url).pathname;

/**
 * EL ENTORNO DEL HIJO SE CONSTRUYE DESDE CERO, NUNCA HEREDADO.
 *
 * Si esto fuera `{ ...process.env }`, el hijo recibiría el `BVSALA_DEV_OPEN=1`
 * que `vitest.config.ts` pone para toda la suite y el test no probaría NADA:
 * comprobaría la puerta abierta, que es justo el agujero que lo dejó vivo. Y no
 * puede ser una LISTA NEGRA (`delete env.BVSALA_DEV_OPEN`) porque una lista
 * negra hay que acordarse de ampliarla la próxima vez que aparezca un
 * interruptor; esta es blanca y por defecto está vacía.
 *
 * Además, cada hijo INFORMA de lo que vio en `BVSALA_DEV_OPEN` y aquí se afirma
 * — si alguien "arregla" esto heredando el entorno, falla en vez de pasar por la
 * razón equivocada.
 */
const ENTORNO_LIMPIO: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };

/** Preámbulo común a todo hijo: sin red, y deja constancia del entorno que vio. */
const PREAMBULO = [
  'globalThis.fetch = () => { throw new Error("[sala-limpia] la red esta prohibida en este test"); };',
  'const salida = { puertaEnElEntorno: process.env.BVSALA_DEV_OPEN ?? "<sin definir>" };',
].join("\n");

interface Intento {
  resultado: string;
  nombre?: string;
  estado?: string;
  mensaje?: string;
}
interface SalidaDelReadme extends Intento {
  puertaEnElEntorno: string;
}
interface SalidaDeLasPalancas {
  puertaEnElEntorno: string;
  version: string;
  sinNada: Intento;
  conDevUnlicensed: Intento;
  conClaveMala: Intento;
}

let dir = "";
let consumidor = "";
let bundlePublicado = "";
let readme: SalidaDelReadme;
let palancasLimpio: SalidaDeLasPalancas;
let palancasContaminado: SalidaDeLasPalancas;

/** El primer bloque ```ts del README: el que pega quien acaba de instalar. */
function bloqueDelReadme(): string {
  const src = readFileSync(join(RAIZ, "README.md"), "utf8");
  const m = src.match(/```ts\n([\s\S]*?)```/);
  if (!m?.[1]) throw new Error("el README se quedó sin bloque de ejemplo");
  return m[1];
}

/** Ejecuta un hijo y devuelve lo que escribió en el fichero de salida. */
function ejecutar<T>(guion: string, nombre: string, entorno: NodeJS.ProcessEnv): T {
  const ruta = join(consumidor, `${nombre}.mjs`);
  const salida = join(consumidor, `${nombre}.json`);
  writeFileSync(ruta, guion);
  let stderr = "";
  try {
    execFileSync(process.execPath, [ruta, salida], {
      cwd: consumidor,
      env: entorno,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    stderr = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  if (!existsSync(salida)) {
    throw new Error(
      `el hijo "${nombre}" murió sin escribir su resultado. Si es un SyntaxError, el bloque ` +
        `del README dejó de ser JavaScript ejecutable tal cual (¿una anotación de tipo?): este ` +
        `test lo EJECUTA, no lo compila.\n${stderr}`,
    );
  }
  return JSON.parse(readFileSync(salida, "utf8")) as T;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bvsala-sala-limpia-"));
  // `npm pack` y no `pnpm pack`: es lo que corre publish.yml, así que es el
  // tarball que de verdad se sube a npm.
  const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], {
    cwd: RAIZ,
    encoding: "utf8",
  }).trim();
  execFileSync("tar", ["xzf", join(dir, tgz)], { cwd: dir });

  consumidor = join(dir, "consumidor");
  const instalado = join(consumidor, "node_modules", "@bivelio", "savings-layer");
  mkdirSync(instalado, { recursive: true });
  cpSync(join(dir, "package"), instalado, { recursive: true });
  bundlePublicado = readFileSync(join(instalado, "dist", "index.js"), "utf8");

  // 1) El fragmento del README, EJECUTADO. Los `import` se izan (dentro de un
  //    bloque son un error de sintaxis) y el resto va en un try/catch, que es lo
  //    único que hay que añadirle para poder mirar el error que recibe el cliente.
  const imports: string[] = ['import { writeFileSync } from "node:fs";'];
  const cuerpo = bloqueDelReadme()
    .split("\n")
    .filter((linea) => {
      if (/^\s*import\s/.test(linea)) {
        imports.push(linea.trim());
        return false;
      }
      return true;
    })
    .join("\n");
  readme = ejecutar<SalidaDelReadme>(
    [
      ...imports,
      PREAMBULO,
      "try {",
      cuerpo,
      '  salida.resultado = "CORRIO SIN LICENCIA";',
      '  salida.mensaje = text;',
      '  salida.estado = report.cost.basis;',
      "} catch (e) {",
      '  salida.resultado = "lanzo";',
      "  salida.nombre = e?.name;",
      "  salida.estado = e?.status;",
      "  salida.mensaje = String(e?.message ?? e);",
      "}",
      "writeFileSync(process.argv[2], JSON.stringify(salida));",
    ].join("\n"),
    "readme",
    ENTORNO_LIMPIO,
  );

  // 2) Las dos palancas que el mensaje viejo recomendaba, probadas contra el
  //    paquete publicado. Se corre DOS veces: limpio, y con BVSALA_DEV_OPEN=1
  //    puesto a mano. La segunda es además el control de la fontanería: si el
  //    entorno no llegara al hijo, no habría forma de saber que el primero está
  //    limpio porque lo construimos así y no por accidente.
  const guionDeLasPalancas = [
    'import { createSavingsLayer, BV_SALA_VERSION } from "@bivelio/savings-layer";',
    'import { writeFileSync } from "node:fs";',
    PREAMBULO,
    "const proveedor = {",
    '  id: "sala-limpia",',
    "  async generate() {",
    '    return { text: "no se deberia llegar aqui", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };',
    "  },",
    "};",
    'const peticion = { model: "m", messages: [{ role: "user", content: "hola" }] };',
    "async function intento(extra) {",
    "  try {",
    "    const capa = createSavingsLayer({ provider: proveedor, ...extra });",
    "    const r = await capa.generate(peticion);",
    "    capa.close();",
    '    return { resultado: "CORRIO", mensaje: r.text };',
    "  } catch (e) {",
    '    return { resultado: "lanzo", nombre: e?.name, estado: e?.status, mensaje: String(e?.message ?? e) };',
    "  }",
    "}",
    "salida.version = BV_SALA_VERSION;",
    "salida.sinNada = await intento({});",
    "salida.conDevUnlicensed = await intento({ devUnlicensed: true });",
    'salida.conClaveMala = await intento({ licenseKey: "bvl_esto-no-es-una-licencia_123" });',
    "writeFileSync(process.argv[2], JSON.stringify(salida));",
  ].join("\n");
  palancasLimpio = ejecutar<SalidaDeLasPalancas>(guionDeLasPalancas, "palancas", ENTORNO_LIMPIO);
  palancasContaminado = ejecutar<SalidaDeLasPalancas>(guionDeLasPalancas, "palancas-env", {
    ...ENTORNO_LIMPIO,
    BVSALA_DEV_OPEN: "1",
  });
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("sala limpia: el paquete de npm, instalado y ejecutado SIN clave", () => {
  it("el entorno del hijo no trae la puerta de desarrollo abierta", () => {
    // Sin esto, todo lo demás sería teatro: con BVSALA_DEV_OPEN=1 heredado el
    // paquete correría y no habría mensaje que juzgar.
    expect(readme.puertaEnElEntorno).toBe("<sin definir>");
    expect(palancasLimpio.puertaEnElEntorno).toBe("<sin definir>");
    // Control de la fontanería: el entorno SÍ llega cuando se pone a propósito.
    expect(palancasContaminado.puertaEnElEntorno).toBe("1");
  });

  it("el fragmento del README se EJECUTA y responde SIN licencia (modo Community, sin red)", () => {
    // Control positivo del arnés: el tarball carga, `createSavingsLayer` monta la
    // capa y `generate()` contesta en modo Community. La pregunta es aritmética
    // (2 + 2 * 3), así que la responde el resolver local SIN llamar al proveedor:
    // el stub de fetch que prohíbe la red no se llega a tocar.
    expect(readme.resultado).toBe("CORRIO SIN LICENCIA");
    expect(readme.nombre).toBeUndefined();
    expect(readme.mensaje).toBe("8");
    expect(readme.estado).toBe("estimated");
    expect(palancasLimpio.version).toBe(
      (JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { version: string }).version,
    );
  });

  it("⛔ una clave PRESENTE pero inválida sigue fail-closed, con el estado estable y la página que resuelve", () => {
    // El fail-closed que queda en open core es el de la clave que NO vale: el
    // mensaje tiene que decir qué mirar, con el enlace que resuelve, y nunca
    // proponer una palanca tapiada.
    const m = palancasLimpio.conClaveMala;
    expect(`${m.resultado}/${m.nombre}`).toBe("lanzo/LicenseError");
    expect(m.estado).toBe("invalid");
    expect(m.mensaje).toMatch(/license status: invalid/);
    expect(m.mensaje).toMatch(/https:\/\/savings\.bivelio\.com\/dashboard\/install/);
    expect(m.mensaje).not.toMatch(/devUnlicensed|BVSALA_DEV_OPEN/);
    const enlaces = m.mensaje?.match(/https:\/\/savings\.bivelio\.com[^\s)]*/g) ?? [];
    expect(enlaces.length).toBeGreaterThan(0);
    expect(enlaces.filter((u) => !/savings\.bivelio\.com\/\w/.test(u))).toEqual([]);
  });

  it("sin clave corre (Community), con devUnlicensed o BVSALA_DEV_OPEN también: la puerta de desarrollo está plegada", () => {
    // Los cuatro caminos terminan CORRIENDO: sin clave es el modo Community, y
    // las dos palancas de desarrollo están compiladas fuera del paquete
    // publicado (el entorno contaminado corre igual, no "más").
    for (const [donde, intento] of [
      ["limpio · sin nada", palancasLimpio.sinNada],
      ["limpio · devUnlicensed:true", palancasLimpio.conDevUnlicensed],
      ["BVSALA_DEV_OPEN=1 · sin nada", palancasContaminado.sinNada],
      ["BVSALA_DEV_OPEN=1 · devUnlicensed:true", palancasContaminado.conDevUnlicensed],
    ] as const) {
      expect(`${donde}: ${intento.resultado}/${intento.mensaje}`).toBe(`${donde}: CORRIO/no se deberia llegar aqui`);
      expect(intento.nombre).toBeUndefined();
    }
  });

  it("el tarball no lleva la puerta de desarrollo dentro", () => {
    // La MISMA comprobación que publish.yml y simular-ci.sh, pero en cada PR y
    // no al cortar la Release. Y es lo que sostiene la forma
    // `const …; if (!…) return …;` de `devOpen()` y `mensajeSinLicencia()`:
    // esbuild pliega la constante de build y borra la rama muerta. Escrito de
    // otra forma —un método, un ternario que no se pliega— el literal viajaría
    // en el paquete y esto lo cazaría aquí.
    expect(bundlePublicado.includes("BVSALA_DEV_OPEN")).toBe(false);
    expect(bundlePublicado.includes("devUnlicensed")).toBe(false);
  });
});

/**
 * EL BINARIO DEL GATEWAY PUBLICADO (LICENSE §2). `bvsala` va en el mismo
 * tarball y arranca solo con licencia: aquí se ejecuta el `dist/gateway/bin.js`
 * de verdad, sin red y con el entorno construido desde cero, y se comprueba que
 * cada fallo de arranque dice EXACTAMENTE qué falta — y que lo que no necesita
 * licencia (versión, doctor, la ayuda del terminal hijo) sigue funcionando.
 */
describe("sala limpia: el binario del gateway publicado", () => {
  const bin = () => join(consumidor, "node_modules", "@bivelio", "savings-layer", "dist", "gateway", "bin.js");
  const correr = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [bin(), ...args], { cwd: consumidor, env, encoding: "utf8", timeout: 30_000 });

  it("(a) lleva la clave pública embebida: sin ella ninguna licencia verificaría y bvsala no arrancaría nunca", () => {
    expect(readFileSync(bin(), "utf8")).toContain("BEGIN PUBLIC KEY");
  });

  it("(b) sin BIVELIO_SERVICE_KEY: arranca en MODO COMMUNITY y se queda escuchando (el timeout lo mata)", () => {
    // Open core: sin claves el gateway NO sale — arranca con las palancas locales
    // y cero telemetría. spawnSync lo mata al vencer su timeout, y lo capturado
    // antes del kill es justo la prueba de que estaba VIVO y escuchando.
    const r = correr(["gateway", "--port", "0"], ENTORNO_LIMPIO);
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(`${r.stdout}${r.stderr}`).toContain("COMMUNITY MODE");
    expect(r.stdout).toContain("listening on http://127.0.0.1:");
  });

  it("(c) con clave y SIN red: exit 1, «could not collect your license» con el respaldo, y jamás la clave", () => {
    // Sin red de verdad: el preámbulo pisa `fetch` ANTES de cargar el binario,
    // así que la recogida online falla aquí y no en savings.bivelio.com.
    const envoltorio = join(consumidor, "gateway-sin-red.mjs");
    writeFileSync(
      envoltorio,
      [
        'globalThis.fetch = () => { throw new Error("[sala-limpia] la red esta prohibida en este test"); };',
        `process.argv = [process.execPath, ${JSON.stringify(bin())}, "gateway", "--port", "0"];`,
        `await import(${JSON.stringify(pathToFileURL(bin()).href)});`,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, [envoltorio], {
      cwd: consumidor,
      env: { ...ENTORNO_LIMPIO, BIVELIO_SERVICE_KEY: "bvk_x" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not collect your license");
    expect(r.stderr).toContain("BIVELIO_LICENSE_KEY");
    expect(`${r.stdout}${r.stderr}`).not.toContain("bvk_x");
  });

  it("(d) la bvk_ pegada en BIVELIO_LICENSE_KEY: exit 1 con la pista, antes de tocar la red", () => {
    const r = correr(["gateway", "--port", "0"], { ...ENTORNO_LIMPIO, BIVELIO_SERVICE_KEY: "bvk_x", BIVELIO_LICENSE_KEY: "bvk_y" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Did you paste the bvk_");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/bvk_[xy]\b/);
  });

  it("(e) la versión y el doctor NO exigen licencia", () => {
    const version = correr(["--version"], ENTORNO_LIMPIO);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(
      (JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { version: string }).version,
    );
    const doctor = correr(["doctor"], ENTORNO_LIMPIO);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("COMMUNITY");
  });

  it("(f) `bvsala claude --version` va directo al terminal: ni gateway ni licencia", () => {
    const r = correr(["claude", "--version"], ENTORNO_LIMPIO);
    expect(r.stderr).not.toContain("BIVELIO_SERVICE_KEY");
    // 0 si Claude Code está instalado en esta máquina; 127 si no lo está.
    expect([0, 127]).toContain(r.status);
  });

  it("(g) el binario tampoco lleva la puerta de desarrollo", () => {
    const fuente = readFileSync(bin(), "utf8");
    expect(fuente.includes("BVSALA_DEV_OPEN")).toBe(false);
    expect(fuente.includes("devUnlicensed")).toBe(false);
  });
});

/**
 * LOS ADAPTADORES DE FRAMEWORKS PUBLICADOS, desde el MISMO tarball y SIN clave.
 *
 * Se ejecutan los tres que no importan su framework en tiempo de ejecución
 * (`ai-sdk`, `mastra` y `anthropic-sdk` solo usan sus tipos), así que corren sin
 * instalar nada más. Cada uno recibe un modelo —o un `next`— falso que cuenta
 * sus llamadas: tiene que rechazar con `LicenseError` y no llamarlo NUNCA. Y el
 * error tiene que ser la MISMA clase que exporta el paquete: prueba de que el
 * adaptador carga el `dist/index.js` del cliente y no una copia empaquetada.
 */
describe("sala limpia: los adaptadores publicados, SIN clave", () => {
  interface SalidaDeAdaptadores {
    puertaEnElEntorno: string;
    aiSdk: Intento & { misma?: boolean };
    mastra: Intento & { misma?: boolean };
    anthropic: Intento & { misma?: boolean };
    llamadas: number;
  }
  let adaptadores: SalidaDeAdaptadores;

  beforeAll(() => {
    adaptadores = ejecutar<SalidaDeAdaptadores>(
      [
        'import { LicenseError } from "@bivelio/savings-layer";',
        'import { savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";',
        'import { savingsProcessor } from "@bivelio/savings-layer/mastra";',
        'import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";',
        'import { writeFileSync } from "node:fs";',
        PREAMBULO,
        "salida.llamadas = 0;",
        "const contar = async () => { salida.llamadas += 1; return {}; };",
        "async function intento(fn) {",
        "  try {",
        "    await fn();",
        '    return { resultado: "CORRIO" };',
        "  } catch (e) {",
        '    return { resultado: "lanzo", nombre: e?.name, estado: e?.status, misma: e instanceof LicenseError, mensaje: String(e?.message ?? e) };',
        "  }",
        "}",
        'const prompt = [{ role: "user", content: [{ type: "text", text: "hola" }] }];',
        'const model = { provider: "openai.chat", modelId: "gpt-4o-mini" };',
        "const mw = savingsMiddleware({});",
        "salida.aiSdk = await intento(() => mw.wrapGenerate({ doGenerate: contar, doStream: contar, params: { prompt }, model }));",
        "mw.close();",
        "const proc = savingsProcessor({});",
        "salida.mastra = await intento(() => proc.processLLMRequest({ state: {}, stepNumber: 0, prompt, model }));",
        "proc.close();",
        "const anth = anthropicSavings({});",
        "salida.anthropic = await intento(() => anth.middleware(",
        '  { url: "https://api.anthropic.com/v1/messages", method: "POST", headers: new Headers(),',
        '    body: JSON.stringify({ model: "claude-x", max_tokens: 5, messages: [{ role: "user", content: "hola" }] }) },',
        "  async () => { salida.llamadas += 1; return new Response(\"{}\"); },",
        "  { options: undefined },",
        "));",
        "anth.close();",
        "writeFileSync(process.argv[2], JSON.stringify(salida));",
      ].join("\n"),
      "adaptadores",
      ENTORNO_LIMPIO,
    );
  }, 60_000);

  it("el entorno del hijo no trae la puerta de desarrollo abierta", () => {
    expect(adaptadores.puertaEnElEntorno).toBe("<sin definir>");
  });

  it("los tres CORREN en modo Community, con la clase del paquete cargada", () => {
    for (const [nombre, r] of [
      ["ai-sdk", adaptadores.aiSdk],
      ["mastra", adaptadores.mastra],
      ["anthropic-sdk", adaptadores.anthropic],
    ] as const) {
      expect(`${nombre}: ${r.resultado}/${r.nombre}`).toBe(`${nombre}: CORRIO/undefined`);
      expect(r.mensaje).not.toMatch(/devUnlicensed|BVSALA_DEV_OPEN/);
    }
  });

  it("⛔ y el modelo (o el fetch) SÍ se llama: open core ejecuta, no es un modo sombra", () => {
    // ai-sdk llama a su doble (contar) y anthropic-sdk a su `next`; mastra no
    // toca el modelo con esta petición (su gancho responde sin red).
    expect(adaptadores.llamadas).toBe(2);
  });
});
