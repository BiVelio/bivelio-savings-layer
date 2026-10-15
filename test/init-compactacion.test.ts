import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import {
  conFicheros,
  detectar,
  diffUnificado,
  jsonDelPlan,
  leerArgumentosDeInit,
  planear,
  textoDelPlan,
  type OpcionesDeInit,
  type Plan,
  type SondaDeProyecto,
} from "../gateway/init.js";
import {
  CAPAS,
  MUESTRA_DE_VERIFICACION,
  PROVEEDORES_DE,
  cableado,
  usoExpress,
  verificacionDeCompactacion,
  type Capa,
  type Proveedor,
} from "../gateway/init-fragmentos.js";

/**
 * D11 · `bvsala init` CON EVIDENCIA: `--compaction off|measure|on` y `--verify`.
 *
 * Los oráculos no son el código de init:
 *  · el diff que se propone se APLICA con `git apply` sobre el cableado de
 *    siempre y tiene que dar, byte a byte, el cableado con la opción;
 *  · `measure` deja la inferencia como estaba: el cableado es el de siempre,
 *    byte a byte, y el módulo de medición devuelve el tool output intacto;
 *  · el script de verificación se EJECUTA (sin red) y lo que imprime se mira
 *    contra la muestra y contra `JSON.parse`, no contra el recibo de la capa.
 */

const DIR = "/p/app";
const ENTORNO = { node: "22.14.0", env: () => false };

function sonda(packageJson: Record<string, unknown>, existen: string[] = []): SondaDeProyecto {
  const ficheros = new Map([[join(DIR, "package.json"), JSON.stringify(packageJson)]]);
  const hay = new Set(existen.map((r) => join(DIR, ...r.split("/"))));
  return { leer: (r) => ficheros.get(r), existe: (r) => ficheros.has(r) || hay.has(r) };
}

const PAQUETES: Record<Capa, Record<string, string>> = {
  "ai-sdk": { ai: "^7.0.118", "@ai-sdk/openai": "^4.0.78", "@ai-sdk/anthropic": "^3.0.0" },
  mastra: { "@mastra/core": "^1.71.0" },
  langchain: { langchain: "^1.5.14", "@langchain/core": "^1.2.13" },
  "anthropic-sdk": { "@anthropic-ai/sdk": "^0.128.0" },
  sdk: {},
};

function plan(o: Pick<OpcionesDeInit, "capa" | "proveedor" | "compactacion">, deps: Record<string, string> = {}, existen: string[] = []): Plan {
  const s = sonda({ type: "module", dependencies: deps }, existen);
  const d = detectar(DIR, s);
  if (!d.ok) throw new Error(d.mensaje);
  const p = planear(d.valor, o, ENTORNO);
  if (!p.ok) throw new Error(p.mensaje);
  return conFicheros(p.valor, s);
}

const cableadoDe = (p: Plan) => p.ficheros.find((f) => f.proposito === "wiring")?.contenido;

describe("argumentos", () => {
  it("--compaction acepta off, measure y on; cualquier otra cosa dice cuáles", () => {
    for (const m of ["off", "measure", "on"] as const) {
      const r = leerArgumentosDeInit(["--compaction", m], "/x");
      expect(r.ok && r.valor.compactacion).toBe(m);
    }
    const mal = leerArgumentosDeInit(["--compaction", "max"], "/x");
    expect(mal).toMatchObject({ ok: false });
    expect(!mal.ok && mal.mensaje).toMatch(/--compaction needs one of: off, measure, on/);
    expect(leerArgumentosDeInit(["--compaction"], "/x")).toMatchObject({ ok: false });
  });

  it("--verify ya no existe: la verificación es un script que se corre con node, no algo que init ejecute", () => {
    expect(leerArgumentosDeInit(["--compaction", "on", "--verify"], "/x")).toMatchObject({ ok: false });
  });

  it("⛔ ningún argumento lleva un secreto: no hay opción para la licencia ni para una clave", () => {
    for (const a of ["--license", "--license-key", "--api-key", "--key"]) {
      expect(leerArgumentosDeInit([a, "x"], "/x")).toMatchObject({ ok: false });
    }
  });
});

describe("sin --compaction (o con off), init es el de siempre", () => {
  it("mismo plan, mismo texto y mismo JSON para cada capa × proveedor", () => {
    for (const capa of CAPAS) {
      for (const proveedor of PROVEEDORES_DE[capa]) {
        const base = plan({ capa, proveedor }, PAQUETES[capa]);
        const off = plan({ capa, proveedor, compactacion: "off" }, PAQUETES[capa]);
        expect(off).toEqual(base);
        expect(base.compactacion).toBeUndefined();
        expect(textoDelPlan(off, "h", "init")).not.toMatch(/Tool-output compaction/);
        expect(JSON.parse(jsonDelPlan(off, "0")).toolOutputCompaction).toBeUndefined();
      }
    }
  });
});

describe("--compaction on: solo donde la pila lo admite", () => {
  it("el SDK con Anthropic: el cableado lleva la opción, y el diff propuesto se aplica con git apply", () => {
    const p = plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" });
    expect(p.compactacion).toMatchObject({ pedido: "on", efectivo: "on", admite: true });
    const con = cableadoDe(p)!;
    const sin = cableado("sdk", "anthropic");
    expect(con).toContain('toolOutputCompaction: { profile: "lossless-data" },');
    expect(sin).not.toContain("toolOutputCompaction");

    // El oráculo: git, no este código.
    const dir = mkdtempSync(join(tmpdir(), "bvsala-init-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "savings.js"), sin);
      writeFileSync(join(dir, "cambio.diff"), p.compactacion!.diff!);
      execFileSync("git", ["apply", "cambio.diff"], { cwd: dir });
      expect(readFileSync(join(dir, "savings.js"), "utf8")).toBe(con);
      // Y es reversible: el mismo diff al revés deja el fichero de siempre.
      execFileSync("git", ["apply", "-R", "cambio.diff"], { cwd: dir });
      expect(readFileSync(join(dir, "savings.js"), "utf8")).toBe(sin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el diff solo AÑADE líneas (nada del cableado de siempre se quita ni se cambia)", () => {
    const d = plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" }).compactacion!.diff!;
    const cuerpo = d.split("\n").slice(3).filter((l) => l !== "");
    expect(cuerpo.some((l) => l.startsWith("-"))).toBe(false);
    expect(cuerpo.filter((l) => l.startsWith("+")).length).toBeGreaterThan(0);
  });

  it("Express con el SDK y Anthropic: el diff es sobre server.*, y también se aplica", () => {
    const p = plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" }, { express: "^5.2.1" });
    expect(p.deteccion.anfitrion).toBe("express");
    const dir = mkdtempSync(join(tmpdir(), "bvsala-init-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "server.js"), usoExpress("sdk", "anthropic"));
      writeFileSync(join(dir, "cambio.diff"), p.compactacion!.diff!);
      execFileSync("git", ["apply", "cambio.diff"], { cwd: dir });
      expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(p.usos[0]!.contenido);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("los adaptadores de framework y OpenAI: no se enciende, se dice por qué, y el cableado no cambia ni un byte", () => {
    const casos: Array<[Capa, Proveedor, RegExp]> = [
      ["ai-sdk", "openai", /forwards the request your framework built/],
      ["ai-sdk", "anthropic", /forwards the request your framework built/],
      ["mastra", "anthropic", /forwards the request your framework built/],
      ["langchain", "openai", /forwards the request your framework built/],
      ["anthropic-sdk", "anthropic", /forwards the request your framework built/],
      ["sdk", "openai", /this pilot covers Anthropic Messages/],
    ];
    for (const [capa, proveedor, motivo] of casos) {
      const p = plan({ capa, proveedor, compactacion: "on" }, PAQUETES[capa]);
      expect(p.compactacion, `${capa}/${proveedor}`).toMatchObject({ pedido: "on", efectivo: "off", admite: false });
      expect(p.compactacion!.motivo).toMatch(motivo);
      expect(p.compactacion!.diff).toBeUndefined();
      expect(cableadoDe(p) ?? "").toBe(cableadoDe(plan({ capa, proveedor }, PAQUETES[capa])) ?? "");
      const texto = textoDelPlan(p, "h", "init");
      expect(texto).toMatch(/NOT turned on: /);
      expect(texto).toMatch(/Nothing in the wiring above changed\./);
      expect(texto).not.toMatch(/toolOutputCompaction: \{ profile/);
    }
  });

  it("el JSON para un agente lleva lo pedido, lo hecho, el motivo y el diff", () => {
    const si = JSON.parse(jsonDelPlan(plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" }), "0"));
    expect(si.toolOutputCompaction).toMatchObject({ requested: "on", effective: "on", supported: true, reason: null });
    expect(si.toolOutputCompaction.diff).toMatch(/^--- a\/savings\.js\n\+\+\+ b\/savings\.js\n@@ /);
    const no = JSON.parse(jsonDelPlan(plan({ capa: "mastra", proveedor: "openai", compactacion: "on" }, PAQUETES.mastra), "0"));
    expect(no.toolOutputCompaction).toMatchObject({ requested: "on", effective: "off", supported: false, diff: null });
    expect(no.toolOutputCompaction.reason).toMatch(/Mastra adapter/);
  });

  it("--write con on escribe el cableado CON la opción (la pista de --write repite --compaction)", () => {
    const p = plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" });
    expect(textoDelPlan(p, "h", "npx x init")).toMatch(/npx x init --compaction on --write\./);
  });
});

describe("--compaction measure: nada de la inferencia cambia", () => {
  it("en cualquier pila, el cableado es el de siempre byte a byte, y se añade el módulo que mide", () => {
    for (const capa of CAPAS) {
      for (const proveedor of PROVEEDORES_DE[capa]) {
        const p = plan({ capa, proveedor, compactacion: "measure" }, PAQUETES[capa]);
        expect(p.compactacion?.efectivo).toBe("measure");
        expect(cableadoDe(p) ?? "").toBe(cableadoDe(plan({ capa, proveedor }, PAQUETES[capa])) ?? "");
        expect(p.usos).toEqual(plan({ capa, proveedor }, PAQUETES[capa]).usos);
        const medir = p.ficheros.filter((f) => f.proposito === "measure");
        expect(medir.map((f) => f.ruta)).toEqual(["measure-tool-outputs.js"]);
      }
    }
  });

  it("el módulo de medición (el ejemplo generado) devuelve cada output intacto y cuenta la cobertura", async () => {
    const m = (await import("../examples/stacks/sdk-anthropic-measure/measure-tool-outputs.js")) as {
      measureToolOutput: (s: string) => string;
      measuredSummary: () => string;
      measured: { outputs: number; applied: number };
    };
    const salidas = MUESTRA_DE_VERIFICACION.map((x) => x.output);
    for (const s of salidas) expect(m.measureToolOutput(s)).toBe(s);
    expect(m.measured).toMatchObject({ outputs: 3, applied: 1 });
    expect(m.measuredSummary()).toMatch(/^1 of 3 tool outputs would be compacted \(33%\), \d+ -> \d+ estimated tokens\. Reasons: /);
    expect(m.measuredSummary()).toContain('"duplicate_keys":1');
  });
});

describe("la verificación: un script, UNA llamada local, el recibo y la cobertura", () => {
  const RAIZ = new URL("..", import.meta.url).pathname;
  const TSX = join(RAIZ, "node_modules/.bin/tsx");
  const SIN_RED = join(RAIZ, "test/ayudas-init/sin-red.mjs");
  let casa = "";
  beforeAll(() => {
    casa = mkdtempSync(join(tmpdir(), "bvsala-init-casa-"));
  });
  afterAll(() => rmSync(casa, { recursive: true, force: true }));

  const correr = (ejemplo: string, env: Record<string, string>) =>
    promisify(execFile)(TSX, ["--import", SIN_RED, join(RAIZ, "examples/stacks", ejemplo, "bivelio-verify-compaction.ts")], {
      cwd: RAIZ,
      env: { PATH: process.env.PATH ?? "", HOME: casa, ...env },
      timeout: 90_000,
    }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (e: { code?: number; stdout?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? "" }),
    );

  it("init la pone en el plan con --compaction: la de `on` donde se enciende, la de medir en el resto", () => {
    const si = plan({ capa: "sdk", proveedor: "anthropic", compactacion: "on" });
    expect(si.ficheros.find((f) => f.proposito === "verify")?.contenido).toBe(verificacionDeCompactacion("on"));
    for (const [capa, proveedor, modo] of [
      ["mastra", "openai", "on"],
      ["sdk", "openai", "on"],
      ["ai-sdk", "openai", "measure"],
    ] as const) {
      const p = plan({ capa, proveedor, compactacion: modo }, PAQUETES[capa]);
      expect(p.ficheros.find((f) => f.proposito === "verify")?.contenido, `${capa}/${modo}`).toBe(verificacionDeCompactacion("measure"));
    }
    expect(plan({ capa: "sdk", proveedor: "anthropic" }).ficheros.some((f) => f.proposito === "verify")).toBe(false);
    const texto = textoDelPlan(si, "h", "init");
    expect(texto).toMatch(/Verify it: node bivelio-verify-compaction\.mjs/);
  });

  it("on: dice «ok», con una decisión por tool output y la cobertura de la MUESTRA, sin prometer ahorro", async () => {
    const r = await correr("sdk-anthropic-compaction", { BVSALA_DEV_OPEN: "1" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^receipt: report\.toolOutputCompaction, profile lossless-data, tokens estimated \(heuristic\)$/m);
    expect(r.stdout).toMatch(/toolu_verify_1 +applied +applied +\d+ -> \d+ tokens/);
    expect(r.stdout).toMatch(/toolu_verify_2 +bypassed +duplicate_keys/);
    expect(r.stdout).toMatch(/toolu_verify_3 +bypassed +not_json/);
    expect(r.stdout).toMatch(/coverage: 1 of 3 tool outputs \(33%\) on this built-in SAMPLE\./);
    expect(r.stdout).toMatch(/no saving is promised/);
    expect(r.stdout).toMatch(/^ok: the receipt matches what the model received\.$/m);
    expect(r.stdout).not.toMatch(/\[sin-red\]/);
    // El oráculo, aparte del script: lo aplicado tiene que bajar de verdad y leerse igual.
    const [antes, despues] = /toolu_verify_1 +applied +applied +(\d+) -> (\d+)/.exec(r.stdout)!.slice(1).map(Number);
    expect(despues!).toBeLessThan(antes!);
  }, 120_000);

  it("measure: lo mismo, sin que la capa toque nada (todo llega byte a byte)", async () => {
    const r = await correr("sdk-anthropic-measure", { BVSALA_DEV_OPEN: "1" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/what lossless-data WOULD do \(measure only\)/);
    expect(r.stdout).toMatch(/coverage: 1 of 3 tool outputs/);
    expect(r.stdout).toMatch(/^ok: /m);
  }, 120_000);

  it("⛔ una licencia que no verifica: «not ok», sale con 1, y su valor no aparece en la salida", async () => {
    const falsa = "bvl_valor-de-prueba-que-no-debe-imprimirse_9f3c";
    const r = await correr("sdk-anthropic-compaction", { BIVELIO_LICENSE_KEY: falsa });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not ok: the license did not verify offline\. Set BIVELIO_LICENSE_KEY in your environment/);
    expect(r.stdout).not.toContain("9f3c");
    expect(r.stdout).not.toMatch(/\[sin-red\]/);
  }, 120_000);

  it("⛔ sin licencia: lo mismo, por nombre", async () => {
    const r = await correr("sdk-anthropic-compaction", {});
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/BIVELIO_LICENSE_KEY/);
  }, 120_000);

  it("diffUnificado: sin cambios, nada; con cambios, cabeceras y un trozo que git aplica", () => {
    expect(diffUnificado("a", "x\ny\n", "x\ny\n")).toBe("");
    expect(diffUnificado("a", "x\nz\n", "x\ny\nz\n")).toBe("--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n x\n+y\n z\n");
    const dir = mkdtempSync(join(tmpdir(), "bvsala-init-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      for (const [antes, despues] of [
        ["uno\ndos\ntres", "uno\ndos\ntres\ncuatro"],
        ["a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\n"],
        ["", "nuevo\n"],
      ] as const) {
        writeFileSync(join(dir, "f"), antes);
        writeFileSync(join(dir, "c.diff"), diffUnificado("f", antes, despues));
        execFileSync("git", ["apply", "c.diff"], { cwd: dir });
        expect(readFileSync(join(dir, "f"), "utf8")).toBe(despues);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("el CLI de verdad: init --compaction on, sin red", () => {
  const RAIZ = new URL("..", import.meta.url).pathname;
  const TSX = join(RAIZ, "node_modules/.bin/tsx");
  let proyecto = "";
  let casa = "";
  beforeAll(() => {
    proyecto = mkdtempSync(join(tmpdir(), "bvsala-init-compaction-"));
    casa = mkdtempSync(join(tmpdir(), "bvsala-init-casa-"));
    writeFileSync(join(proyecto, "package.json"), JSON.stringify({ name: "demo", type: "module", dependencies: {} }));
  });
  afterAll(() => {
    rmSync(proyecto, { recursive: true, force: true });
    rmSync(casa, { recursive: true, force: true });
  });

  const init = (args: string[]) =>
    promisify(execFile)(TSX, [join(RAIZ, "gateway/bin.ts"), "init", ...args], {
      cwd: proyecto,
      env: { PATH: process.env.PATH ?? "", HOME: casa },
      timeout: 90_000,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
    );

  it("imprime el diff y la verificación, y no escribe nada", async () => {
    const r = await init(["--stack", "sdk", "--provider", "anthropic", "--compaction", "on"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\+\+\+ b\/savings\.js/);
    expect(r.stdout).toMatch(/Verify it: node bivelio-verify-compaction\.mjs/);
    expect(r.stdout).toMatch(/--compaction on --write\./);
    expect(existsSync(join(proyecto, "savings.js"))).toBe(false);
  }, 120_000);

  it("--write --yes crea el cableado CON la opción, la comprobación y la verificación; nada más", async () => {
    const r = await init(["--stack", "sdk", "--provider", "anthropic", "--compaction", "on", "--write", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/created savings\.js\ncreated bivelio-check\.mjs\ncreated bivelio-verify-compaction\.mjs/);
    expect(readFileSync(join(proyecto, "savings.js"), "utf8")).toContain('toolOutputCompaction: { profile: "lossless-data" },');
    expect(readFileSync(join(proyecto, "bivelio-verify-compaction.mjs"), "utf8")).toBe(verificacionDeCompactacion("on"));
  }, 120_000);
});
