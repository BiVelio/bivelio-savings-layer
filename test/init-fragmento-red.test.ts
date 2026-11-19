import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conFicheros, detectar, planear, type SondaDeProyecto } from "../gateway/init.js";

/**
 * A2-27 · EL FICHERO QUE ESCRIBE `bvsala init`, EJECUTADO, Y LA RED QUE ABRE.
 *
 * `init` es el paso 3 recomendado del panel. Con las dos claves de BiVelio
 * exportadas, decía «set» y generaba un savings.js con `licenseServerUrl` y
 * `serviceAccountKey` COMENTADAS: la app funcionaba pero no mandaba nada a
 * BiVelio — el panel de quien paga, vacío para siempre, y la licencia sin
 * renovarse sola. Las tres líneas van ahora activas y leídas del entorno.
 *
 * Aquí se ejecuta ese fichero de verdad (contra el paquete compilado, como lo
 * instalaría el cliente) con `fetch` interceptado: el proveedor es falso y TODA
 * petición queda anotada. Lo prometido:
 *   · sin ninguna clave: cero peticiones a BiVelio (cero telemetría);
 *   · con BIVELIO_SERVICE_KEY: el uso SÍ llega (POST /api/metering/usage).
 * Las claves son inventadas y nada sale de este proceso: el fetch falso contesta
 * a todo sin tocar la red.
 */
const RAIZ = join(__dirname, "..");

/** Un proyecto JavaScript (ESM) con el SDK de OpenAI, en memoria, como lo vería init. */
function savingsJsDeInit(dir: string): string {
  const pkg = { type: "module", dependencies: { openai: "^6.0.0" } };
  const sonda: SondaDeProyecto = {
    leer: (ruta) => (ruta === join(dir, "package.json") ? JSON.stringify(pkg) : undefined),
    existe: (ruta) => ruta === join(dir, "package.json"),
  };
  const d = detectar(dir, sonda);
  if (!d.ok) throw new Error(d.mensaje);
  const p = planear(d.valor, { capa: "sdk", proveedor: "openai" }, { node: "22.14.0", env: () => true });
  if (!p.ok) throw new Error(p.mensaje);
  const plan = conFicheros(p.valor, sonda);
  const cableado = plan.ficheros.find((f) => f.proposito === "wiring");
  if (!cableado) throw new Error("init no generó el cableado");
  expect(cableado.ruta).toBe("savings.js");
  return cableado.contenido;
}

const EJECUTOR = `
const pedidas = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const metodo = String(init.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  pedidas.push(metodo + " " + url);
  const u = new URL(url);
  if (u.hostname === "api.openai.com") {
    return new Response(JSON.stringify({
      id: "chatcmpl-falso", object: "chat.completion", model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "Waves fold in silence" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
};
const { layer } = await import("./savings.js");
for (let i = 0; i < 3; i++) {
  await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Write a haiku about the sea, take " + i }] });
}
await layer.close();
process.stdout.write(JSON.stringify(pedidas));
`;

describe("A2-27 · el savings.js de `bvsala init`: cero red a BiVelio sin claves, uso enviado con la clave de servicio", () => {
  let dir = "";
  let fuente = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bvsala-init-red-"));
    fuente = savingsJsDeInit(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "savings.js"), fuente);
    writeFileSync(join(dir, "ejecutar.mjs"), EJECUTOR);
    // El paquete compilado, como lo dejaría `npm install` (su package.json apunta a dist/).
    mkdirSync(join(dir, "node_modules", "@bivelio"), { recursive: true });
    symlinkSync(RAIZ, join(dir, "node_modules", "@bivelio", "savings-layer"), "dir");
    readFileSync(join(RAIZ, "dist", "index.js")); // sin build, falla aquí con un error claro
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Entorno desde cero: nada del desarrollador (ni su clave de servicio) se cuela. */
  const correr = (claves: Record<string, string>): string[] => {
    const r = spawnSync(process.execPath, ["ejecutar.mjs"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, OPENAI_API_KEY: "sk-inventada-para-la-prueba", ...claves },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as string[];
  };

  it("las tres líneas van activas y leídas del entorno", () => {
    expect(fuente).toContain("licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,");
    expect(fuente).toMatch(/^\s+licenseServerUrl: "https:\/\/savings\.bivelio\.com",$/m);
    expect(fuente).toContain("serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,");
    expect(fuente).not.toMatch(/\/\/\s*(licenseServerUrl|serviceAccountKey):/);
  });

  it("sin ninguna clave: solo el proveedor, ni una petición a BiVelio", () => {
    const pedidas = correr({});
    expect(pedidas.filter((p) => p.includes("api.openai.com")).length).toBeGreaterThan(0);
    expect(pedidas.filter((p) => !p.includes("api.openai.com"))).toEqual([]);
  });

  it("con BIVELIO_SERVICE_KEY: el uso llega a savings.bivelio.com", () => {
    const pedidas = correr({ BIVELIO_SERVICE_KEY: "bvk_inventada_para_la_prueba" });
    expect(pedidas).toContain("POST https://savings.bivelio.com/api/metering/usage");
    // Y nada fuera del proveedor y de BiVelio.
    expect(pedidas.filter((p) => !/https:\/\/(api\.openai\.com|savings\.bivelio\.com)\//.test(p))).toEqual([]);
  });
});
