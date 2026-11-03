import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

/**
 * `npx @bivelio/savings-layer init`, DESDE EL ARTEFACTO QUE SE PUBLICA.
 *
 * `init-ejemplos.test.ts` corre init y sus ejemplos desde el fuente, con la puerta
 * de desarrollo abierta. Lo que ve un cliente es otra cosa: el `bin` minificado del
 * tarball y un SDK sin modo sin licencia. Este test hace el camino del cliente de
 * punta a punta, sin red y sin registro: `npm pack` → extraer como lo dejaría
 * `npm install` (el paquete no tiene `dependencies`; mismo razonamiento que
 * `sala-limpia-del-tarball`) → `bin init --write --yes` en un proyecto limpio →
 * ejecutar la comprobación que acaba de escribir, sin clave.
 *
 * Lo que tiene que pasar es exactamente lo que promete la cabecera de la
 * comprobación: sin licencia dice «not ok», con el arreglo (dónde se saca la clave),
 * sale con 1 y el modelo no se llama. Y el mensaje NO puede recomendar la puerta de
 * desarrollo, que en el paquete publicado no existe.
 */

const RAIZ = new URL("..", import.meta.url).pathname;
const SIN_RED = join(RAIZ, "test/ayudas-init/sin-red.mjs");

let dir = "";
let proyecto = "";
let bin = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bvsala-init-tarball-"));
  const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: RAIZ, encoding: "utf8" }).trim();
  execFileSync("tar", ["xzf", join(dir, tgz)], { cwd: dir });
  proyecto = join(dir, "proyecto");
  const instalado = join(proyecto, "node_modules", "@bivelio", "savings-layer");
  mkdirSync(instalado, { recursive: true });
  cpSync(join(dir, "package"), instalado, { recursive: true });
  // Un proyecto sin framework ni SDK de LLM: init propone el SDK a secas, que es
  // lo único que se puede ejecutar aquí sin instalar nada del registro.
  writeFileSync(join(proyecto, "package.json"), JSON.stringify({ name: "cliente", private: true, type: "module", dependencies: { "@bivelio/savings-layer": "*" } }));
  const pkg = JSON.parse(readFileSync(join(instalado, "package.json"), "utf8")) as { bin: Record<string, string> };
  // El único bin: el que ejecuta `npx @bivelio/savings-layer`.
  const bins = Object.values(pkg.bin);
  expect(bins).toHaveLength(1);
  bin = join(instalado, bins[0]!);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Entorno desde cero: ni la puerta de desarrollo ni claves de quien corre los tests. */
const ENTORNO = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", HOME: dir });

describe("init desde el tarball, como lo corre el cliente", () => {
  it("imprime el plan con la versión del paquete y sin escribir nada", () => {
    const r = spawnSync(process.execPath, [bin, "init"], { cwd: proyecto, env: ENTORNO(), encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const version = (JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { version: string }).version;
    expect(r.stdout).toContain(`bvsala init · BiVelio Savings Layer ${version}`);
    expect(r.stdout).toMatch(/LLM calls:  the SDK directly \(no framework\) with OpenAI models → @bivelio\/savings-layer/);
    // Ya es dependencia: solo falta el tokenizador exacto.
    expect(r.stdout).toMatch(/npm i gpt-tokenizer/);
    expect(existsSync(join(proyecto, "bivelio-check.mjs"))).toBe(false);
  });

  it("--write --yes escribe la comprobación, y ejecutada sin clave sale «ok» (modo Community), sin llamar a nadie", () => {
    const w = spawnSync(process.execPath, [bin, "init", "--write", "--yes"], { cwd: proyecto, env: ENTORNO(), encoding: "utf8", timeout: 30_000 });
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout).toMatch(/created savings\.js\ncreated bivelio-check\.mjs/);

    const c = spawnSync(process.execPath, ["--import", SIN_RED, "bivelio-check.mjs"], { cwd: proyecto, env: ENTORNO(), encoding: "utf8", timeout: 30_000 });
    expect(c.status).toBe(0);
    expect(c.stdout.trim()).toMatch(/^ok: the layer answered "8" on this machine without calling the model/);
    // Open core: sin clave no hay error, y el modo sin licencia ya no existe como puerta.
    expect(c.stdout).not.toMatch(/devUnlicensed|BVSALA_DEV_OPEN|license required/);
  });
});
