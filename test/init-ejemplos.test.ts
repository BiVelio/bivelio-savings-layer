import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import {
  CAPAS,
  PROVEEDORES_DE,
  LINEAS_DE_COMPACTACION,
  cableado,
  comprobacionRuta,
  medicionDeCompactacion,
  comprobacionScript,
  usoExpress,
  usoNext,
} from "../gateway/init-fragmentos.js";
import { ejemplosDeInit } from "../scripts/ejemplos-de-init.js";

/**
 * LO QUE `bvsala init` LE DA AL CLIENTE, PROBADO COMO LO USARÍA EL CLIENTE.
 *
 * El listón es el de `fragmento-instalacion`: un fragmento que no compila pegado
 * tal cual es un camino cortado en el primer paso. Aquí se sube un escalón más:
 *
 *   1. `examples/stacks/` es exactamente la salida de init (ni una copia a mano
 *      que derive, ni un ejemplo que init no daría).
 *   2. TODAS las combinaciones capa × proveedor × anfitrión compilan en strict, con
 *      un tsconfig de aplicación, contra los tipos reales de cada framework.
 *   3. Los ejemplos se EJECUTAN contra los frameworks reales (ai 7, @mastra/core,
 *      langchain con @langchain/openai, @anthropic-ai/sdk, express 5) con la red
 *      prohibida en el proceso hijo: la comprobación dice «ok» sin salir de la
 *      máquina, que es justo lo que promete su cabecera.
 *   4. El CLI de verdad (`gateway/bin.ts init`) contra un proyecto en disco: no
 *      escribe sin permiso, escribe con él y no pisa en la segunda pasada.
 *
 * Los hijos corren desde el FUENTE con BVSALA_DEV_OPEN=1 (el paquete publicado no
 * tiene modo sin licencia; eso lo prueba `init-desde-el-tarball.test.ts`).
 */

const RAIZ = new URL("..", import.meta.url).pathname;
const TSX = join(RAIZ, "node_modules/.bin/tsx");
const SIN_RED = join(RAIZ, "test/ayudas-init/sin-red.mjs");
const PILAS = join(RAIZ, "examples/stacks");
const ejecutar = promisify(execFile);

/** Lo que hay en examples/stacks/ y NO sale de init, a propósito. */
const A_MANO = new Set(["README.md", "tsconfig.json", "nextjs/run.ts"]);

let casa = "";
beforeAll(() => {
  // Un HOME vacío: el SDK de Anthropic busca credenciales en ~/.config si no hay
  // clave, y el hijo no tiene por qué ver las de quien corre los tests.
  casa = mkdtempSync(join(tmpdir(), "bvsala-init-casa-"));
});
afterAll(() => rmSync(casa, { recursive: true, force: true }));

/** El entorno del hijo, desde cero (nunca heredado: ni claves ni puertas abiertas por accidente). */
function entorno(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: casa, BVSALA_DEV_OPEN: "1", ...extra };
}

function ficherosDe(dir: string): string[] {
  const out: string[] = [];
  const recorrer = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const ruta = join(d, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else out.push(relative(dir, ruta));
    }
  };
  recorrer(dir);
  return out.sort();
}

describe("examples/stacks/ es la salida de init", () => {
  it("cada fichero generado está en disco, byte a byte (si no: pnpm init:ejemplos)", () => {
    for (const e of ejemplosDeInit()) {
      const ruta = join(RAIZ, e.ruta);
      expect(existsSync(ruta), `falta ${e.ruta}: corre \`pnpm init:ejemplos\``).toBe(true);
      expect(readFileSync(ruta, "utf8"), `${e.ruta} no es lo que da init: corre \`pnpm init:ejemplos\``).toBe(e.contenido);
    }
  });

  it("y no hay ejemplos que init no daría (salvo los tres ficheros escritos a mano)", () => {
    const generados = new Set(ejemplosDeInit().map((e) => relative(PILAS, join(RAIZ, e.ruta))));
    const sobrantes = ficherosDe(PILAS).filter((f) => !generados.has(f) && !A_MANO.has(f));
    expect(sobrantes).toEqual([]);
    // Las seis pilas, cada una con su comprobación.
    for (const p of ["nextjs", "express", "ai-sdk", "mastra", "langchain", "anthropic-sdk"]) {
      expect([...generados].some((g) => g.startsWith(`${p}/`) && /bivelio-check/.test(g)), p).toBe(true);
    }
  });

  it("la variante JavaScript de la ruta de Next.js solo difiere en la anotación y el cast", () => {
    for (const capa of CAPAS) {
      for (const proveedor of PROVEEDORES_DE[capa]) {
        const ts = usoNext(capa, proveedor, { ts: true, importeDelCableado: "../../../lib/savings" });
        const js = usoNext(capa, proveedor, { ts: false, importeDelCableado: "../../../lib/savings" });
        expect(ts.replace("(req: Request)", "(req)").replace("(await req.json()) as { prompt: string }", "await req.json()")).toBe(js);
      }
    }
  });
});

describe("todas las combinaciones compilan pegadas tal cual", () => {
  it("capa × proveedor × {cableado, script, ruta de comprobación, ruta de uso, Express}, en strict", () => {
    const cache = join(RAIZ, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, "bvsala-init-"));
    try {
      for (const capa of CAPAS) {
        for (const proveedor of PROVEEDORES_DE[capa]) {
          const base = join(dir, `${capa}-${proveedor}`);
          const escribir = (rel: string, texto: string) => {
            mkdirSync(join(base, rel, ".."), { recursive: true });
            writeFileSync(join(base, rel), texto);
          };
          escribir("lib/savings.ts", cableado(capa, proveedor));
          escribir("bivelio-check.ts", comprobacionScript(capa, proveedor));
          escribir("app/api/bivelio-check/route.ts", comprobacionRuta(capa, proveedor));
          escribir("app/api/chat/route.ts", usoNext(capa, proveedor, { ts: true, importeDelCableado: "../../../lib/savings" }));
          escribir("server.ts", usoExpress(capa, proveedor));
          // D11: con la opción de compactación dentro, en la capa que la acepta (el SDK). Los
          // adaptadores de framework NO la tienen en sus opciones —TS2353 si se la pegas—,
          // que es la otra cara de por qué init no la propone ahí.
          if (capa === "sdk") escribir("lib/savings-compaction.ts", cableado(capa, proveedor, LINEAS_DE_COMPACTACION));
        }
      }
      escribir0(dir, "medir/measure-tool-outputs.ts", medicionDeCompactacion());
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: true,
            noUnusedLocals: true,
            isolatedModules: true,
            verbatimModuleSyntax: true,
            esModuleInterop: true,
            types: ["node"],
            typeRoots: [join(RAIZ, "node_modules/@types")],
            paths: {
              "@bivelio/savings-layer": [join(RAIZ, "src/index.ts")],
              "@bivelio/savings-layer/*": [join(RAIZ, "src/adapters/*.ts")],
            },
          },
          include: ["**/*.ts"],
        }),
      );
      let errores = "";
      try {
        execFileSync(join(RAIZ, "node_modules/.bin/tsc"), ["-p", dir], { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        errores = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(errores).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("y como .mjs/.js son JavaScript válido (node --check), que es lo que init escribe en un proyecto JS", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvsala-init-js-"));
    try {
      for (const capa of CAPAS) {
        for (const proveedor of PROVEEDORES_DE[capa]) {
          const piezas: Array<[string, string]> = [
            ["cableado", cableado(capa, proveedor)],
            ["check", comprobacionScript(capa, proveedor)],
            ["ruta", comprobacionRuta(capa, proveedor)],
            ["uso", usoNext(capa, proveedor, { ts: false, importeDelCableado: "./x" })],
            ["express", usoExpress(capa, proveedor)],
            ...(capa === "sdk" ? ([["cableado-compaction", cableado(capa, proveedor, LINEAS_DE_COMPACTACION)]] as Array<[string, string]>) : []),
            ["medir", medicionDeCompactacion()],
          ];
          for (const [nombre, texto] of piezas) {
            const ruta = join(dir, `${capa}-${proveedor}-${nombre}.mjs`);
            writeFileSync(ruta, texto);
            execFileSync(process.execPath, ["--check", ruta], { stdio: ["ignore", "pipe", "pipe"] });
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Concurrente: cada ejemplo es un proceso aparte, sin nada compartido. En tests
// concurrentes vitest pide el `expect` del contexto de cada test.
describe.concurrent("los ejemplos se ejecutan, sin red", () => {
  const scripts: Array<[string, Record<string, string>]> = [
    ["ai-sdk", {}],
    ["mastra", {}],
    ["langchain", {}],
    // El SDK de Anthropic no construye una petición sin credenciales, aunque la
    // conteste la capa: el valor no sale de la máquina (la red está prohibida).
    ["anthropic-sdk", { ANTHROPIC_API_KEY: "placeholder-not-sent" }],
    ["express", {}],
    // D11: la misma comprobación en la pila que admite la compactación (y en la que la mide).
    ["sdk-anthropic-compaction", {}],
    ["sdk-anthropic-measure", {}],
  ];

  for (const [pila, extra] of scripts) {
    it(`${pila}/bivelio-check.ts dice «ok» y sale con 0, sin llamar al modelo ni a la red`, async ({ expect }) => {
      const { stdout } = await ejecutar(TSX, ["--import", SIN_RED, join(PILAS, pila, "bivelio-check.ts")], {
        cwd: RAIZ,
        env: entorno(extra),
        timeout: 90_000,
      });
      expect(stdout.trim()).toBe('ok: the layer answered "8" on this machine without calling the model (basis: estimated).');
    }, 120_000);
  }

  it("sin licencia (open core): la comprobación sale «ok» en modo Community, sin llamar al modelo", async ({ expect }) => {
    const r = await ejecutar(TSX, ["--import", SIN_RED, join(PILAS, "ai-sdk", "bivelio-check.ts")], {
      cwd: RAIZ,
      env: { PATH: process.env.PATH ?? "", HOME: casa },
      timeout: 90_000,
    }).then(
      (salida: { stdout?: string }) => ({ code: 0, stdout: salida.stdout ?? "" }),
      (err: { code?: number; stdout?: string }) => ({ code: err.code ?? -1, stdout: err.stdout ?? "" }),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ok: the layer answered "8" on this machine without calling the model/);
  }, 120_000);

  it("Next.js: la ruta de comprobación y la de uso, llamadas como las llama Next.js (Request → Response)", async ({ expect }) => {
    const { stdout } = await ejecutar(TSX, ["--import", SIN_RED, join(PILAS, "nextjs", "run.ts")], {
      cwd: RAIZ,
      env: entorno(),
      timeout: 90_000,
    });
    expect(stdout).toMatch(/GET \/api\/bivelio-check → 200/);
    expect(stdout).toMatch(/ok: true/);
    expect(stdout).toMatch(/POST \/api\/chat → 200 \{ text: '8', basis: 'estimated' \}/);
  }, 120_000);

  it("Next.js: en producción la ruta de comprobación es un 404 y no toca la capa", async ({ expect }) => {
    const { stdout } = await ejecutar(
      TSX,
      [
        "--import",
        SIN_RED,
        "--eval",
        `const m = await import(${JSON.stringify(join(PILAS, "nextjs/app/api/bivelio-check/route.ts"))}); const r = await m.GET(); console.log(r.status, await r.text(), m.dynamic);`,
      ],
      { cwd: RAIZ, env: { PATH: process.env.PATH ?? "", HOME: casa, NODE_ENV: "production" }, timeout: 90_000 },
    );
    expect(stdout.trim()).toBe("404 Not found force-dynamic");
  }, 120_000);

  it("Express: el servidor del ejemplo contesta POST /api/chat con el informe", async ({ expect }) => {
    const puerto = await puertoLibre();
    const hijo = spawn(TSX, ["--import", SIN_RED, join(PILAS, "express", "server.ts")], {
      cwd: RAIZ,
      env: entorno({ PORT: String(puerto) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let salida = "";
    hijo.stdout.on("data", (b: Buffer) => (salida += String(b)));
    hijo.stderr.on("data", (b: Buffer) => (salida += String(b)));
    try {
      let respuesta: Response | undefined;
      for (let i = 0; i < 150 && !respuesta; i++) {
        try {
          respuesta = await fetch(`http://127.0.0.1:${puerto}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "What is 2 + 2 * 3?" }),
          });
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(respuesta, `el servidor no arrancó:\n${salida}`).toBeDefined();
      expect(respuesta!.status).toBe(200);
      expect(await respuesta!.json()).toEqual({ text: "8", basis: "estimated" });
    } finally {
      hijo.kill();
    }
  }, 120_000);
});

describe("el CLI de verdad: bvsala init contra un proyecto en disco", () => {
  let proyecto = "";
  beforeAll(() => {
    proyecto = mkdtempSync(join(tmpdir(), "bvsala-init-proyecto-"));
    writeFileSync(
      join(proyecto, "package.json"),
      JSON.stringify({ name: "demo", type: "module", dependencies: { ai: "^7.0.118", "@ai-sdk/openai": "^4.0.78" } }),
    );
    writeFileSync(join(proyecto, ".env"), "BIVELIO_LICENSE_KEY=valor-que-init-no-puede-leer\n");
  });
  afterAll(() => rmSync(proyecto, { recursive: true, force: true }));

  async function init(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return ejecutar(TSX, [join(RAIZ, "gateway/bin.ts"), "init", ...args], {
      cwd: proyecto,
      env: { PATH: process.env.PATH ?? "", HOME: casa },
      timeout: 90_000,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
    );
  }

  it("imprime, no escribe, y no enseña el contenido del .env", async () => {
    const r = await init([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/LLM calls:  Vercel AI SDK 7\.0\.118 with OpenAI models → @bivelio\/savings-layer\/ai-sdk/);
    expect(r.stdout).toMatch(/npm i @bivelio\/savings-layer gpt-tokenizer/);
    expect(r.stdout).toMatch(/Run it: node --env-file=\.env bivelio-check\.mjs/);
    expect(r.stdout).not.toContain("valor-que-init-no-puede-leer");
    expect(existsSync(join(proyecto, "bivelio-check.mjs"))).toBe(false);
    expect(existsSync(join(proyecto, "savings.js"))).toBe(false);
  }, 120_000);

  it("⛔ --write sin terminal y sin --yes: exit 1 y nada escrito", async () => {
    const r = await init(["--write"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Not writing: this is not an interactive terminal and --yes was not given/);
    expect(existsSync(join(proyecto, "bivelio-check.mjs"))).toBe(false);
  }, 120_000);

  it("--write --yes crea los dos ficheros; la segunda vez los deja como están", async () => {
    const r = await init(["--write", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created savings\.js\ncreated bivelio-check\.mjs/);
    expect(r.stdout).not.toMatch(/Nothing was written/);
    expect(readFileSync(join(proyecto, "bivelio-check.mjs"), "utf8")).toBe(comprobacionScript("ai-sdk", "openai"));
    expect(readFileSync(join(proyecto, "savings.js"), "utf8")).toBe(cableado("ai-sdk", "openai"));

    writeFileSync(join(proyecto, "savings.js"), "// del cliente\n");
    const otra = await init(["--write", "--yes"]);
    expect(otra.code).toBe(0);
    expect(otra.stdout).toMatch(/left as is: savings\.js already exists/);
    expect(otra.stdout).toMatch(/Nothing to write\./);
    expect(readFileSync(join(proyecto, "savings.js"), "utf8")).toBe("// del cliente\n");
  }, 120_000);

  it("--json es JSON; sin package.json, un error que dice qué hacer", async () => {
    const j = await init(["--json"]);
    expect(JSON.parse(j.stdout)).toMatchObject({ stack: "ai-sdk", provider: "openai" });
    const vacio = mkdtempSync(join(tmpdir(), "bvsala-init-vacio-"));
    try {
      const r = await init(["--cwd", vacio]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/\[bvsala init\] no package\.json in .*Run this from your project's root, or pass --cwd <dir>\./);
    } finally {
      rmSync(vacio, { recursive: true, force: true });
    }
  }, 120_000);
});

function escribir0(dir: string, rel: string, texto: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), texto);
}

function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const s = createServer();
    s.once("error", rechazar);
    s.listen(0, "127.0.0.1", () => {
      const direccion = s.address();
      const puerto = typeof direccion === "object" && direccion ? direccion.port : 0;
      s.close(() => resolver(puerto));
    });
  });
}
