import { dirname, join, posix } from "node:path";

import {
  CAPAS,
  LINEAS_DE_COMPACTACION,
  MODOS_DE_COMPACTACION,
  MODULO_DE_CAPA,
  NOMBRE_DE_CAPA,
  PROVEEDORES_DE,
  admiteCompactacion,
  cableado,
  comprobacionRuta,
  comprobacionScript,
  medicionDeCompactacion,
  verificacionDeCompactacion,
  paquetesDeLaPila,
  usoExpress,
  usoNext,
  type Capa,
  type ModoDeCompactacion,
  type Proveedor,
} from "./init-fragmentos.js";

/**
 * `bvsala init` (también `npx @bivelio/savings-layer init`): mira el proyecto e
 * imprime, para SU pila, la línea de instalación, las claves que faltan, el
 * cableado con su adaptador y una comprobación gratuita.
 *
 * Lo que puede y no puede hacer, que es lo que un comando que toca el proyecto de
 * otro tiene que dejar claro antes que nada:
 *
 *  · LEE solo `package.json` (el del proyecto y los de `node_modules/<paquete>`,
 *    para la versión instalada). Del resto mira EXISTENCIA: lockfiles, `app/`,
 *    `src/`, `tsconfig.json`, `.env*`. Jamás abre un `.env` ni imprime el valor de
 *    una variable: de las claves dice «puesta» o «no puesta» y nada más.
 *  · No toca la red, no instala nada y no ejecuta nada del proyecto.
 *  · Por defecto NO ESCRIBE. Con `--write` crea ficheros NUEVOS (nunca pisa uno que
 *    exista, ni siquiera si aparece entre la pregunta y la escritura: `wx`) y solo
 *    tras un «sí» explícito en la terminal, o `--yes` si no hay terminal.
 *  · `--compaction measure|on` (D11, opt-in; sin él, la salida es la de siempre):
 *    `on` añade al cableado UNA opción, `toolOutputCompaction: { profile:
 *    "lossless-data" }`, solo donde la pila la admite, y la enseña como un diff que
 *    se revisa y se deshace borrando esas líneas; donde no la admite dice por qué y
 *    no cambia nada. `measure` no toca la inferencia: añade un módulo que mide.
 *    Con cualquiera de los dos, el plan trae `bivelio-verify-compaction.mjs`: UNA
 *    llamada local y acotada a un modelo falso que vive en el script, que imprime
 *    el recibo (aplicado o desviado y por qué) y la COBERTURA, sin red y sin
 *    prometer un ahorro (la muestra no es el tráfico del cliente). Es un script
 *    que se corre con `node`, como la comprobación: init sigue sin ejecutar nada.
 *
 * Todo lo que decide es puro y se prueba aquí (test/init-*.test.ts): la sonda del
 * sistema de ficheros se inyecta. bin.ts solo conecta la sonda real y la pregunta.
 */

/** Lo que `init` puede preguntarle al sistema de ficheros. Rutas absolutas. */
export interface SondaDeProyecto {
  /** El texto de un fichero, o `undefined` si no existe o no se puede leer. */
  leer(ruta: string): string | undefined;
  /** ¿Existe esa ruta (fichero o directorio)? */
  existe(ruta: string): boolean;
}

export type Gestor = "npm" | "pnpm" | "yarn" | "bun";
export type Anfitrion = "next" | "express" | "node";

export interface OpcionesDeInit {
  cwd: string;
  escribir: boolean;
  si: boolean;
  json: boolean;
  capa?: Capa;
  proveedor?: Proveedor;
  /** `--compaction`. Ausente = `off`: init hace lo de siempre. */
  compactacion?: ModoDeCompactacion;
}

export interface Deteccion {
  dir: string;
  gestor: Gestor;
  ts: boolean;
  esm: boolean;
  anfitrion: Anfitrion;
  /** La versión de Next.js o Express, si se sabe. */
  versionDelAnfitrion?: string;
  /** `app` o `src/app` en Next.js con App Router. */
  appDir?: string;
  src: boolean;
  /** Las capas que el proyecto usa, en orden de preferencia. */
  capas: Capa[];
  /** Las dependencias declaradas (dependencies + devDependencies), con su versión conocida. */
  deps: Record<string, string | undefined>;
  /** `@bivelio/savings-layer` ya está entre las dependencias. */
  yaInstalado?: string;
  monorepo: boolean;
  /** Ficheros `.env*` que existen (solo el nombre). */
  ficherosEnv: string[];
  /** ¿Declara `scripts.dev`? */
  scriptDev: boolean;
}

export interface FicheroNuevo {
  ruta: string;
  proposito: "wiring" | "check" | "measure" | "verify";
  contenido: string;
  existe: boolean;
}

export interface Fragmento {
  titulo: string;
  /** Dónde iría, relativo al proyecto: el ejemplo lo pone ahí. */
  ruta: string;
  contenido: string;
}

export interface Plan {
  deteccion: Deteccion;
  capa: Capa;
  proveedor: Proveedor;
  /** Otras capas que el proyecto también usa. */
  alternativas: Capa[];
  instalar: string[];
  comandoDeInstalacion?: string;
  claves: Array<{ nombre: string; puesta: boolean; para: string }>;
  dondeVanLasClaves: string;
  ficheros: FicheroNuevo[];
  usos: Fragmento[];
  comoComprobar: string[];
  avisos: string[];
  /** Solo con `--compaction measure|on`: qué se pidió, qué se hace y por qué. */
  compactacion?: CompactacionDelPlan;
}

/** La compactación de tool outputs en el plan (D11). */
export interface CompactacionDelPlan {
  pedido: Exclude<ModoDeCompactacion, "off">;
  /** Lo que de verdad se hace: `off` cuando se pidió `on` y la pila no lo admite. */
  efectivo: ModoDeCompactacion;
  /** ¿Admite la pila encenderla (`on`)? */
  admite: boolean;
  /** Por qué no, cuando no. */
  motivo?: string;
  /** Con `on` admitido: el diff unificado del cambio en el cableado, para revisarlo. */
  diff?: string;
}

export type Resultado<T> = { ok: true; valor: T } | { ok: false; mensaje: string };

// ── Argumentos ─────────────────────────────────────────────────────────────

const USO =
  "usage: bvsala init [--write [--yes]] [--json] [--stack ai-sdk|mastra|langchain|anthropic-sdk|sdk] " +
  "[--provider openai|anthropic] [--compaction off|measure|on] [--cwd <dir>]";

/** `resto` es lo que va detrás de `init`. `-h`/`--help` ya lo resolvió argumentos.ts. */
export function leerArgumentosDeInit(resto: readonly string[], cwd: string): Resultado<OpcionesDeInit> {
  const o: OpcionesDeInit = { cwd, escribir: false, si: false, json: false };
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i]!;
    const valor = (): string | undefined => {
      const v = resto[i + 1];
      if (v === undefined || v.startsWith("-")) return undefined;
      i++;
      return v;
    };
    if (a === "--write") o.escribir = true;
    else if (a === "--yes" || a === "-y") o.si = true;
    else if (a === "--json") o.json = true;
    else if (a === "--stack") {
      const v = valor();
      if (!v || !(CAPAS as readonly string[]).includes(v)) {
        return { ok: false, mensaje: `--stack needs one of: ${CAPAS.join(", ")}.\n${USO}` };
      }
      o.capa = v as Capa;
    } else if (a === "--provider") {
      const v = valor();
      if (v !== "openai" && v !== "anthropic") return { ok: false, mensaje: `--provider needs openai or anthropic.\n${USO}` };
      o.proveedor = v;
    } else if (a === "--compaction") {
      const v = valor();
      if (!v || !(MODOS_DE_COMPACTACION as readonly string[]).includes(v)) {
        return { ok: false, mensaje: `--compaction needs one of: ${MODOS_DE_COMPACTACION.join(", ")}.\n${USO}` };
      }
      o.compactacion = v as ModoDeCompactacion;
    } else if (a === "--cwd") {
      const v = valor();
      if (!v) return { ok: false, mensaje: `--cwd needs a directory.\n${USO}` };
      o.cwd = v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) ? v : join(cwd, v);
    } else {
      return { ok: false, mensaje: `unknown option: ${a}\n${USO}` };
    }
  }
  if (o.json && o.escribir) return { ok: false, mensaje: "--json prints the plan and --write applies it: use one of them." };
  if (o.si && !o.escribir) return { ok: false, mensaje: "--yes only confirms --write: add --write, or drop --yes." };
  if (o.capa && o.proveedor && !PROVEEDORES_DE[o.capa].includes(o.proveedor)) {
    return { ok: false, mensaje: `--stack ${o.capa} only works with --provider ${PROVEEDORES_DE[o.capa].join(" or ")}.` };
  }
  return { ok: true, valor: o };
}

// ── Detección ──────────────────────────────────────────────────────────────

interface PackageJson {
  name?: unknown;
  scripts?: unknown;
  type?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

/** Los lockfiles, en el orden en que se prueban en cada directorio. */
const LOCKFILES: ReadonlyArray<[string, Gestor]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

function gestorDe(pkg: PackageJson, dir: string, sonda: SondaDeProyecto): Gestor {
  if (typeof pkg.packageManager === "string") {
    const nombre = pkg.packageManager.split("@")[0];
    if (nombre === "pnpm" || nombre === "yarn" || nombre === "bun" || nombre === "npm") return nombre;
  }
  // El lockfile de un monorepo vive en la raíz: se sube hasta encontrarlo.
  for (let d = dir, i = 0; i < 20; i++) {
    for (const [fichero, gestor] of LOCKFILES) if (sonda.existe(join(d, fichero))) return gestor;
    const padre = dirname(d);
    if (padre === d) break;
    d = padre;
  }
  return "npm";
}

function mapaDeDeps(pkg: PackageJson): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bloque of [pkg.devDependencies, pkg.dependencies]) {
    if (bloque && typeof bloque === "object") {
      for (const [k, v] of Object.entries(bloque as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * La versión que de verdad se usa: la instalada si hay `node_modules`, si no la
 * mínima del rango declarado. `undefined` si no se puede saber («latest», «*»,
 * «workspace:*», «catalog:»…).
 */
function versionConocida(nombre: string, rango: string, dir: string, sonda: SondaDeProyecto): string | undefined {
  const instalado = sonda.leer(join(dir, "node_modules", ...nombre.split("/"), "package.json"));
  if (instalado) {
    try {
      const v = (JSON.parse(instalado) as { version?: unknown }).version;
      if (typeof v === "string") return v;
    } catch {
      // Un package.json roto en node_modules no es asunto nuestro: se usa el rango.
    }
  }
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(rango.replace(/^npm:[^@]+@/, ""));
  if (!m || /^(workspace|catalog|link|file|git|github):/.test(rango)) return undefined;
  return `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`;
}

function partes(v: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = v.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  return [a, b, c];
}

/** a >= b */
function mayorOIgual(a: string, b: string): boolean {
  const x = partes(a);
  const y = partes(b);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  return true;
}

/** Lo que admite cada adaptador (README, «Requirements»; peerDependencies del paquete). */
const SOPORTE: ReadonlyArray<{ paquete: string; capa: Capa; desde: string; hasta: string; texto: string }> = [
  { paquete: "ai", capa: "ai-sdk", desde: "6.0.0", hasta: "8.0.0", texto: "ai 6 or 7" },
  { paquete: "@mastra/core", capa: "mastra", desde: "1.68.0", hasta: "2.0.0", texto: "@mastra/core ≥ 1.68 < 2" },
  { paquete: "langchain", capa: "langchain", desde: "1.1.0", hasta: "2.0.0", texto: "langchain ≥ 1.1 < 2" },
  { paquete: "@langchain/core", capa: "langchain", desde: "1.1.0", hasta: "2.0.0", texto: "@langchain/core ≥ 1.1 < 2" },
  { paquete: "@anthropic-ai/sdk", capa: "anthropic-sdk", desde: "0.103.0", hasta: "1.0.0", texto: "@anthropic-ai/sdk ≥ 0.103 < 1" },
];

/** El paquete que delata cada capa, en orden de preferencia cuando hay varias. */
const PAQUETE_DE_CAPA: ReadonlyArray<[string, Capa]> = [
  ["@mastra/core", "mastra"],
  ["langchain", "langchain"],
  ["ai", "ai-sdk"],
  ["@anthropic-ai/sdk", "anthropic-sdk"],
  ["openai", "sdk"],
];

export function detectar(dir: string, sonda: SondaDeProyecto): Resultado<Deteccion> {
  const texto = sonda.leer(join(dir, "package.json"));
  if (texto === undefined) {
    const python = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].find((f) => sonda.existe(join(dir, f)));
    if (python) {
      return {
        ok: false,
        mensaje:
          `no package.json in ${dir}, and ${python} says this is Python. The SDK is TypeScript; for Python ` +
          "(or any language), run the local gateway and point your client's base URL at it: " +
          "`bvsala gateway --upstream openai --port 8403`, then OpenAI(base_url=\"http://127.0.0.1:8403/v1\"). " +
          "It measures; the saving levers are TypeScript. `bvsala doctor` prints the recipe for each SDK.",
      };
    }
    return {
      ok: false,
      mensaje: `no package.json in ${dir}. Run this from your project's root, or pass --cwd <dir>.`,
    };
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(texto) as PackageJson;
  } catch (err) {
    return {
      ok: false,
      mensaje: `${join(dir, "package.json")} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix it and run init again.`,
    };
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { ok: false, mensaje: `${join(dir, "package.json")} is not a JSON object. Fix it and run init again.` };
  }

  const declaradas = mapaDeDeps(pkg);
  const deps: Record<string, string | undefined> = {};
  for (const [k, rango] of Object.entries(declaradas)) deps[k] = versionConocida(k, rango, dir, sonda);

  const appDir = ["app", "src/app"].find((d) => sonda.existe(join(dir, ...d.split("/"))));
  const anfitrion: Anfitrion = "next" in deps ? "next" : "express" in deps ? "express" : "node";
  const capas = PAQUETE_DE_CAPA.filter(([p]) => p in deps).map(([, c]) => c);
  const deteccion: Deteccion = {
    dir,
    gestor: gestorDe(pkg, dir, sonda),
    ts: "typescript" in deps || sonda.existe(join(dir, "tsconfig.json")),
    esm: pkg.type === "module",
    anfitrion,
    src: sonda.existe(join(dir, "src")),
    capas,
    deps,
    monorepo: pkg.workspaces !== undefined || sonda.existe(join(dir, "pnpm-workspace.yaml")),
    ficherosEnv: [".env", ".env.local"].filter((f) => sonda.existe(join(dir, f))),
    scriptDev: typeof (pkg.scripts as Record<string, unknown> | undefined)?.dev === "string",
  };
  const versionAnfitrion = anfitrion === "node" ? undefined : deps[anfitrion];
  if (versionAnfitrion) deteccion.versionDelAnfitrion = versionAnfitrion;
  if (anfitrion === "next" && appDir) deteccion.appDir = appDir;
  if ("@bivelio/savings-layer" in declaradas) deteccion.yaInstalado = deps["@bivelio/savings-layer"] ?? declaradas["@bivelio/savings-layer"];
  return { ok: true, valor: deteccion };
}

// ── El plan ────────────────────────────────────────────────────────────────

const HAY_SENAL = (d: Deteccion, paquetes: readonly string[]) => paquetes.some((p) => p in d.deps);
const SENAL_OPENAI = ["openai", "@ai-sdk/openai", "@langchain/openai"];
const SENAL_ANTHROPIC = ["@anthropic-ai/sdk", "@ai-sdk/anthropic", "@langchain/anthropic"];

function proveedorPara(capa: Capa, d: Deteccion): Proveedor {
  if (capa === "anthropic-sdk") return "anthropic";
  if (capa === "ai-sdk") {
    if ("@ai-sdk/openai" in d.deps) return "openai";
    if ("@ai-sdk/anthropic" in d.deps) return "anthropic";
  }
  if (capa === "langchain") {
    if ("@langchain/openai" in d.deps) return "openai";
    if ("@langchain/anthropic" in d.deps) return "anthropic";
  }
  return HAY_SENAL(d, SENAL_ANTHROPIC) && !HAY_SENAL(d, SENAL_OPENAI) ? "anthropic" : "openai";
}

/** Por qué una capa detectada no sirve con la versión que hay, o `undefined` si sirve. */
function versionNoAdmitida(capa: Capa, d: Deteccion): string | undefined {
  for (const s of SOPORTE) {
    if (s.capa !== capa) continue;
    const v = d.deps[s.paquete];
    if (v === undefined) continue;
    if (!mayorOIgual(v, s.desde) || mayorOIgual(v, s.hasta)) return `${s.paquete} ${v} is outside what the adapter supports (${s.texto})`;
  }
  return undefined;
}

const COMANDO_ANADIR: Readonly<Record<Gestor, string>> = { npm: "npm i", pnpm: "pnpm add", yarn: "yarn add", bun: "bun add" };

/**
 * `node` en su versión mínima para `--env-file` (20.6). Por debajo de 20 el
 * paquete no arranca (engines), y eso ya lo corta `planear`.
 */
function comandoDelScript(d: Deteccion): string {
  const env = d.ficherosEnv[0];
  return env ? `node --env-file=${env} bivelio-check.mjs` : "node bivelio-check.mjs";
}

export function planear(
  d: Deteccion,
  o: Pick<OpcionesDeInit, "capa" | "proveedor" | "compactacion">,
  entorno: { node: string; env: (nombre: string) => boolean },
): Resultado<Plan> {
  const [mayorNode = 0] = partes(entorno.node);
  if (mayorNode < 20) {
    return { ok: false, mensaje: `Node ${entorno.node} is too old: @bivelio/savings-layer needs Node ≥ 20. Upgrade Node and run init again.` };
  }
  const avisos: string[] = [];

  // La capa: la pedida, o la primera detectada cuya versión admita su adaptador.
  let capa: Capa | undefined = o.capa;
  const descartadas: Array<{ capa: Capa; motivo: string }> = [];
  if (capa) {
    const motivo = versionNoAdmitida(capa, d);
    if (motivo) avisos.push(`${motivo}: the snippets below will not work until you upgrade it.`);
  } else {
    for (const c of d.capas) {
      const motivo = versionNoAdmitida(c, d);
      if (!motivo) {
        capa = c;
        break;
      }
      descartadas.push({ capa: c, motivo });
    }
  }
  if (!capa) {
    capa = "sdk";
    if (d.capas.length === 0) {
      avisos.push(
        d.monorepo
          ? "No LLM library in this package.json, and it looks like a monorepo root: run init inside the package that calls the LLM (--cwd <path>)."
          : "No LLM library found (ai, @mastra/core, langchain, @anthropic-ai/sdk or openai): showing the SDK on its own. If you call the LLM from another language, see `bvsala doctor`.",
      );
    }
  }
  for (const x of descartadas) {
    const paquete = SOPORTE.find((s) => s.capa === x.capa && x.motivo.startsWith(`${s.paquete} `))?.paquete ?? "";
    avisos.push(
      `${x.motivo}: showing ${NOMBRE_DE_CAPA[capa]} instead. ` +
        `To use the ${NOMBRE_DE_CAPA[x.capa]} adapter, upgrade it: ${COMANDO_ANADIR[d.gestor]} ${paquete}@latest`,
    );
  }
  const proveedor = o.proveedor ?? proveedorPara(capa, d);
  if (!PROVEEDORES_DE[capa].includes(proveedor)) {
    return { ok: false, mensaje: `--stack ${capa} only works with --provider ${PROVEEDORES_DE[capa].join(" or ")}.` };
  }

  // Lo que hay que instalar: el paquete, lo que importan los fragmentos y el tokenizador exacto.
  const instalar: string[] = [];
  if (!d.yaInstalado) instalar.push("@bivelio/savings-layer");
  for (const p of paquetesDeLaPila(capa, proveedor)) if (!(p in d.deps)) instalar.push(p);
  if (proveedor === "openai" && !("gpt-tokenizer" in d.deps)) instalar.push("gpt-tokenizer");
  const instalada = d.deps["@bivelio/savings-layer"];
  if (d.yaInstalado && capa !== "sdk" && instalada && !mayorOIgual(instalada, "0.4.25")) {
    avisos.push(
      `@bivelio/savings-layer ${instalada} has no framework adapters (they arrived in 0.4.25): ${COMANDO_ANADIR[d.gestor]} @bivelio/savings-layer@latest`,
    );
  }
  if (mayorNode < 22 && (capa === "mastra" || (capa === "ai-sdk" && (d.deps.ai ?? "7").startsWith("7")))) {
    avisos.push(`Node ${entorno.node}: ${capa === "mastra" ? "@mastra/core" : "ai 7"} declares Node ≥ 22 in its own engines.`);
  }
  if (!d.ts && !d.esm && d.anfitrion !== "next") {
    avisos.push(
      'Your package.json has no "type": "module" and the package is ESM-only. The check is a .mjs file and runs as is; ' +
        "from your own CommonJS files, load it with `await import(…)`, or with require() on Node ≥ 22.",
    );
  }

  const claves: Plan["claves"] = [
    {
      nombre: "BIVELIO_LICENSE_KEY",
      puesta: entorno.env("BIVELIO_LICENSE_KEY"),
      para: "OPTIONAL (open core): without it the layer runs in COMMUNITY mode with every local lever on; a key adds cloud dashboard + team metering",
    },
    { nombre: "BIVELIO_SERVICE_KEY", puesta: entorno.env("BIVELIO_SERVICE_KEY"), para: "OPTIONAL: seat metering, license auto-renewal and the cloud dashboard" },
  ];
  if (capa === "anthropic-sdk") {
    claves.push({
      nombre: "ANTHROPIC_API_KEY",
      puesta: entorno.env("ANTHROPIC_API_KEY") || entorno.env("ANTHROPIC_AUTH_TOKEN"),
      para: "needed even by the free check: the Anthropic SDK builds no request without credentials",
    });
  } else {
    const nombre = proveedor === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    // Mastra resuelve la clave del proveedor al preparar la llamada y, sin ella,
    // imprime un aviso con traza aunque la capa conteste (medido con 1.71.0).
    const para =
      capa === "mastra"
        ? "your provider key; the free check works without it, but Mastra logs a warning with a stack trace"
        : "your provider key; the free check does not need it";
    claves.push({ nombre, puesta: entorno.env(nombre), para });
  }
  const dondeVanLasClaves =
    d.anfitrion === "next"
      ? "Put them in .env.local (Next.js loads it) or in your host's environment settings."
      : d.ficherosEnv.length > 0
        ? `Export them, or keep them in ${d.ficherosEnv[0]} and pass it to node with --env-file (Node ≥ 20.6).`
        : "Export them in your shell, or keep them in a .env file and pass it to node with --env-file (Node ≥ 20.6).";

  const plan: Plan = {
    deteccion: d,
    capa,
    proveedor,
    alternativas: d.capas.filter((c) => c !== capa),
    instalar,
    claves,
    dondeVanLasClaves,
    ficheros: [],
    usos: [],
    comoComprobar: [],
    avisos,
  };
  if (instalar.length > 0) plan.comandoDeInstalacion = `${COMANDO_ANADIR[d.gestor]} ${instalar.join(" ")}`;
  const pedido = o.compactacion ?? "off";
  if (pedido !== "off") {
    const soporte = admiteCompactacion(capa, proveedor);
    plan.compactacion = {
      pedido,
      // `measure` no toca la inferencia: vale en cualquier pila. `on` solo donde se admite.
      efectivo: pedido === "on" && !soporte.admite ? "off" : pedido,
      admite: soporte.admite,
      ...(soporte.admite ? {} : { motivo: soporte.motivo }),
    };
  }
  return { ok: true, valor: plan };
}

/**
 * Completa el plan con los ficheros (el contenido depende de la pila; la existencia,
 * del disco). Separado de `planear` para que el plan sea puro frente a la sonda.
 */
export function conFicheros(plan: Plan, sonda: SondaDeProyecto): Plan {
  const d = plan.deteccion;
  const { capa, proveedor } = plan;
  const ext = d.ts ? "ts" : d.esm || d.anfitrion === "next" ? "js" : "mjs";
  const existe = (rel: string) => sonda.existe(join(d.dir, ...rel.split("/")));
  const ficheros: FicheroNuevo[] = [];
  const usos: Fragmento[] = [];
  const comoComprobar: string[] = [];

  const rutaDelCableado =
    d.anfitrion === "next" ? `${d.appDir?.startsWith("src/") ? "src/" : ""}lib/savings.${ext}` : `${d.src ? "src/" : ""}savings.${ext}`;
  // `--compaction on` admitido: las líneas van DENTRO de las opciones de la capa.
  const encendida = plan.compactacion?.efectivo === "on";
  const extra = encendida ? LINEAS_DE_COMPACTACION : [];

  if (d.anfitrion === "next" && d.appDir) {
    ficheros.push({ ruta: rutaDelCableado, proposito: "wiring", contenido: cableado(capa, proveedor, extra), existe: existe(rutaDelCableado) });
    const rutaDeUso = `${d.appDir}/api/chat/route.${ext}`;
    const importe = posix.relative(posix.dirname(rutaDeUso), rutaDelCableado.replace(/\.[^.]+$/, ""));
    usos.push({
      titulo: `Use it in a route handler (example: ${rutaDeUso})`,
      ruta: rutaDeUso,
      contenido: usoNext(capa, proveedor, { ts: d.ts, importeDelCableado: importe.startsWith(".") ? importe : `./${importe}` }),
    });
    const rutaDeComprobacion = `${d.appDir}/api/bivelio-check/route.${ext}`;
    ficheros.push({ ruta: rutaDeComprobacion, proposito: "check", contenido: comprobacionRuta(capa, proveedor), existe: existe(rutaDeComprobacion) });
    const dev = d.scriptDev ? (d.gestor === "npm" ? "npm run dev" : `${d.gestor} dev`) : "next dev";
    comoComprobar.push(
      `Start your dev server (${dev}) and open http://localhost:3000/api/bivelio-check (or your dev port).`,
      'It answers {"ok":true,…} when the layer is in place, and a message that says what to fix when it is not.',
    );
  } else {
    if (d.anfitrion === "express") {
      usos.push({
        titulo: "In your Express server: the layer is created once at startup, then used by the route",
        ruta: `server.${ext}`,
        contenido: usoExpress(capa, proveedor, extra),
      });
    } else {
      ficheros.push({ ruta: rutaDelCableado, proposito: "wiring", contenido: cableado(capa, proveedor, extra), existe: existe(rutaDelCableado) });
    }
    ficheros.push({ ruta: "bivelio-check.mjs", proposito: "check", contenido: comprobacionScript(capa, proveedor), existe: existe("bivelio-check.mjs") });
    comoComprobar.push(`Run it: ${comandoDelScript(d)}`, 'It prints "ok: …" and exits 0 when the layer is in place, or "not ok: …" with what to fix and exits 1.');
  }
  // Una copia: el plan de entrada no se toca (llamar dos veces no duplica el aviso).
  const avisos = [...plan.avisos];
  if (d.anfitrion === "next" && !d.appDir) {
    avisos.push("No app/ directory (Pages Router?): the check is a script instead of a route. The wiring works the same from an API route.");
  }
  comoComprobar.push(
    "The question (2 + 2 * 3) is answered on your machine: with the layer in place the model is not called, so your provider bills nothing for it,",
    "and the saving is `estimated`, which is never billed. Delete the check once it says ok.",
  );
  let compactacion = plan.compactacion;
  if (compactacion?.efectivo === "measure") {
    const base = d.anfitrion === "next" ? `${d.appDir?.startsWith("src/") ? "src/" : ""}lib/` : d.src ? "src/" : "";
    const ruta = `${base}measure-tool-outputs.${ext}`;
    ficheros.push({ ruta, proposito: "measure", contenido: medicionDeCompactacion(), existe: existe(ruta) });
  }
  if (compactacion) {
    // La verificación: con `on` admitido, la de `on`; si no, la de medir (que no cambia nada).
    const ruta = "bivelio-verify-compaction.mjs";
    const modo = compactacion.efectivo === "on" ? "on" : "measure";
    ficheros.push({ ruta, proposito: "verify", contenido: verificacionDeCompactacion(modo), existe: existe(ruta) });
  }
  if (encendida && compactacion) {
    // El diff, sobre el fichero que lleva la capa: el cableado o, en Express, el servidor.
    const enExpress = d.anfitrion === "express";
    const ruta = enExpress ? `server.${ext}` : rutaDelCableado;
    const antes = enExpress ? usoExpress(capa, proveedor) : cableado(capa, proveedor);
    const despues = enExpress ? usoExpress(capa, proveedor, extra) : cableado(capa, proveedor, extra);
    compactacion = { ...compactacion, diff: diffUnificado(ruta, antes, despues) };
  }
  return { ...plan, ficheros, usos, comoComprobar, avisos, ...(compactacion ? { compactacion } : {}) };
}

/**
 * Un diff unificado de UN trozo (lo que cambia entre el prefijo y el sufijo
 * comunes), con tres líneas de contexto: el formato que `git apply` y cualquier
 * revisor entienden. Basta para lo que init propone, que es insertar unas líneas.
 */
export function diffUnificado(ruta: string, antes: string, despues: string, contexto = 3): string {
  // Las LÍNEAS, sin el salto final ("x\n" es una línea, no dos). La última de un
  // texto que NO acaba en salto lleva una marca, para que «tres» y «tres\n»
  // cuenten como distintas, que es lo que son para diff.
  const SIN_EOL = "\u0000";
  const lineasDe = (t: string): string[] => {
    if (t === "") return [];
    if (t.endsWith("\n")) return t.slice(0, -1).split("\n");
    const ls = t.split("\n");
    ls[ls.length - 1] += SIN_EOL;
    return ls;
  };
  const a = lineasDe(antes);
  const b = lineasDe(despues);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length;
  let sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
    sa--;
    sb--;
  }
  if (p === a.length && p === b.length) return "";
  const desde = Math.max(0, p - contexto);
  const hastaA = Math.min(a.length, sa + contexto);
  const hastaB = Math.min(b.length, sb + contexto);
  const linea = (signo: string) => (l: string) =>
    l.endsWith(SIN_EOL) ? [`${signo}${l.slice(0, -1)}`, "\\ No newline at end of file"] : [`${signo}${l}`];
  // Un lado vacío se numera desde 0, como lo hace diff.
  const rango = (n: number) => `${n === 0 ? desde : desde + 1},${n}`;
  const lineas = [
    `--- a/${ruta}`,
    `+++ b/${ruta}`,
    `@@ -${rango(hastaA - desde)} +${rango(hastaB - desde)} @@`,
    ...a.slice(desde, p).flatMap(linea(" ")),
    ...a.slice(p, sa).flatMap(linea("-")),
    ...b.slice(p, sb).flatMap(linea("+")),
    ...a.slice(sa, hastaA).flatMap(linea(" ")),
  ];
  return `${lineas.join("\n")}\n`;
}

// ── La salida ──────────────────────────────────────────────────────────────

function bloque(titulo: string, contenido: string): string {
  const raya = "-".repeat(Math.max(8, Math.min(72, titulo.length + 12)));
  return `----- ${titulo} -----\n${contenido.replace(/\n$/, "")}\n${raya}`;
}

function describirAnfitrion(d: Deteccion): string {
  const piezas: string[] = [];
  if (d.anfitrion === "next") piezas.push(`Next.js${d.versionDelAnfitrion ? ` ${d.versionDelAnfitrion}` : ""}${d.appDir ? `, App Router in ${d.appDir}` : ""}`);
  else if (d.anfitrion === "express") piezas.push(`Express${d.versionDelAnfitrion ? ` ${d.versionDelAnfitrion}` : ""}`);
  else piezas.push("Node.js");
  piezas.push(d.ts ? "TypeScript" : d.esm ? "JavaScript (ESM)" : "JavaScript (CommonJS)");
  piezas.push(d.gestor);
  return piezas.join(", ");
}

function describirCapa(plan: Plan): string {
  const d = plan.deteccion;
  const paquete = PAQUETE_DE_CAPA.find(([, c]) => c === plan.capa)?.[0];
  const v = paquete ? d.deps[paquete] : undefined;
  const detectada = d.capas.includes(plan.capa);
  const nombre = `${NOMBRE_DE_CAPA[plan.capa]}${detectada && v && plan.capa !== "sdk" ? ` ${v}` : ""}`;
  // La capa «sdk» es el propio paquete: no hay framework que instalar.
  return `${nombre}${detectada || plan.capa === "sdk" ? "" : " (not installed yet)"} with ${plan.proveedor === "openai" ? "OpenAI" : "Anthropic"} models → ${MODULO_DE_CAPA[plan.capa]}`;
}

/**
 * El plan como texto para la terminal. `invocacion` es cómo se volvería a llamar a
 * init; con `escribira`, la escritura viene justo detrás y no se dice «Nothing was
 * written» antes de preguntar.
 */
export function textoDelPlan(plan: Plan, cabecera: string, invocacion: string, opciones: { escribira?: boolean } = {}): string {
  const d = plan.deteccion;
  const out: string[] = [cabecera, "", `Detected in ${d.dir}`, `  app:        ${describirAnfitrion(d)}`, `  LLM calls:  ${describirCapa(plan)}`];
  if (plan.alternativas.length > 0) {
    out.push(`  also found: ${plan.alternativas.map((c) => `${NOMBRE_DE_CAPA[c]} (${invocacion} --stack ${c})`).join(", ")}`);
  }
  if (d.yaInstalado) {
    const v = d.deps["@bivelio/savings-layer"];
    out.push(`  installed:  @bivelio/savings-layer ${v ?? `(declared as "${d.yaInstalado}")`}`);
  }
  for (const a of plan.avisos) out.push("", `note: ${a}`);

  let paso = 1;
  out.push("", `${paso++} · Install`);
  out.push(plan.comandoDeInstalacion ? `  ${plan.comandoDeInstalacion}` : "  nothing to install: every package the snippets import is already a dependency.");

  out.push("", `${paso++} · Keys (checked by name in this shell; values are never read or shown)`);
  const ancho = Math.max(...plan.claves.map((k) => k.nombre.length));
  for (const k of plan.claves) out.push(`  ${k.nombre.padEnd(ancho)}  ${k.puesta ? "set    " : "not set"}  ${k.para}`);
  out.push(
    "  OPEN CORE: no keys are required — without them the layer runs in COMMUNITY mode with every local lever on",
    "  and nothing sent to BiVelio. The BiVelio keys (https://savings.bivelio.com/dashboard/install) add the cloud",
    "  dashboard, team metering and license auto-renewal.",
    `  ${plan.dondeVanLasClaves}`,
  );

  const cableadoNuevo = plan.ficheros.find((f) => f.proposito === "wiring");
  out.push("", `${paso++} · Wire it`);
  if (cableadoNuevo) out.push(bloque(`${cableadoNuevo.ruta} (new file${cableadoNuevo.existe ? "; it already exists, compare it" : ""})`, cableadoNuevo.contenido));
  for (const u of plan.usos) out.push(bloque(u.titulo, u.contenido));

  const comprobacion = plan.ficheros.find((f) => f.proposito === "check");
  out.push("", `${paso++} · Check it, for free`);
  if (comprobacion) out.push(bloque(`${comprobacion.ruta} (new file${comprobacion.existe ? "; it already exists, compare it" : ""})`, comprobacion.contenido));
  for (const l of plan.comoComprobar) out.push(`  ${l}`);

  if (plan.compactacion) out.push("", `${paso++} · Tool-output compaction (opt-in, lossless)`, ...textoDeCompactacion(plan, invocacion));

  const nuevos = plan.ficheros.filter((f) => !f.existe);
  if (opciones.escribira) return out.join("\n");
  out.push("");
  if (nuevos.length > 0) {
    out.push(
      `Nothing was written. To create ${nuevos.length === 1 ? "the new file" : `the ${nuevos.length} new files`} above (${nuevos.map((f) => f.ruta).join(", ")}): ` +
        `${invocacion}${plan.compactacion ? ` --compaction ${plan.compactacion.pedido}` : ""} --write. It asks first and never overwrites; nothing else is touched.`,
    );
  } else {
    out.push("Nothing was written: the files above already exist in your project.");
  }
  return out.join("\n");
}

function textoDeCompactacion(plan: Plan, invocacion: string): string[] {
  const c = plan.compactacion!;
  const out: string[] = [];
  if (c.efectivo === "on") {
    out.push(
      "  ON in the wiring above. This is the whole change, as a diff to review:",
      bloque("diff", c.diff ?? ""),
      "  To revert: delete those lines (or pass savings: { toolOutputCompaction: false } on one request).",
      "  Only strict-JSON tool outputs change, and only their whitespace; system, user and assistant text,",
      "  tool ids and arguments are never touched. Each request's report says, per tool output, applied or",
      "  bypassed and why (report.toolOutputCompaction). Token counts there are estimates, not a saving.",
    );
    if (plan.deteccion.anfitrion === "express" || plan.ficheros.some((f) => f.proposito === "wiring" && f.existe)) {
      out.push("  If you already have this file, add only the + lines to your createSavingsLayer options.");
    }
  } else if (c.efectivo === "measure") {
    const f = plan.ficheros.find((x) => x.proposito === "measure")!;
    out.push(
      "  MEASURE ONLY: nothing sent to the model changes, and the wiring above is the usual one.",
      bloque(`${f.ruta} (new file${f.existe ? "; it already exists, compare it" : ""})`, f.contenido),
      "  Pass each tool output through measureToolOutput() where it is produced; it returns it unchanged.",
      "  measuredSummary() prints the coverage first: how many outputs would be compacted, and why the others not.",
      c.admite
        ? `  When the coverage justifies it, ${invocacion} --compaction on adds the one option that turns it on.`
        : `  Turning it on is not available for this stack: ${c.motivo}.`,
    );
  } else {
    out.push(`  NOT turned on: ${c.motivo}.`, "  Nothing in the wiring above changed.", `  You can still measure it without changing anything: ${invocacion} --compaction measure`);
  }
  const v = plan.ficheros.find((x) => x.proposito === "verify");
  if (v) {
    const env = plan.deteccion.ficherosEnv[0];
    out.push(
      bloque(`${v.ruta} (new file${v.existe ? "; it already exists, compare it" : ""})`, v.contenido),
      `  Verify it: ${env ? `node --env-file=${env} ${v.ruta}` : `node ${v.ruta}`}`,
      "  ONE call to a fake model inside that file: no network, nothing billed. It prints the receipt",
      "  (applied, or bypassed and why) and the coverage of a built-in sample, which is not your traffic.",
    );
  }
  return out;
}

/** El plan como JSON, para un agente de código o un script. */
export function jsonDelPlan(plan: Plan, version: string): string {
  const d = plan.deteccion;
  return JSON.stringify(
    {
      version,
      dir: d.dir,
      detected: {
        host: d.anfitrion,
        hostVersion: d.versionDelAnfitrion ?? null,
        appDir: d.appDir ?? null,
        typescript: d.ts,
        esm: d.esm,
        packageManager: d.gestor,
        stacks: d.capas,
        installed: d.yaInstalado ? (d.deps["@bivelio/savings-layer"] ?? d.yaInstalado) : null,
      },
      stack: plan.capa,
      provider: plan.proveedor,
      adapter: MODULO_DE_CAPA[plan.capa],
      install: plan.comandoDeInstalacion ?? null,
      keys: plan.claves.map((k) => ({ name: k.nombre, set: k.puesta, purpose: k.para })),
      files: plan.ficheros.map((f) => ({ path: f.ruta, purpose: f.proposito, exists: f.existe, content: f.contenido })),
      snippets: plan.usos.map((u) => ({ title: u.titulo, content: u.contenido })),
      check: plan.comoComprobar,
      notes: plan.avisos,
      // Solo con `--compaction`: sin él, el JSON es el de siempre.
      ...(plan.compactacion
        ? {
            toolOutputCompaction: {
              requested: plan.compactacion.pedido,
              effective: plan.compactacion.efectivo,
              supported: plan.compactacion.admite,
              reason: plan.compactacion.motivo ?? null,
              diff: plan.compactacion.diff ?? null,
            },
          }
        : {}),
    },
    null,
    2,
  );
}

// ── La escritura, con permiso ──────────────────────────────────────────────

export interface EscrituraOpciones {
  /** `--yes`: el permiso ya está dado. */
  si: boolean;
  /** ¿Hay una persona al otro lado (stdin es una terminal)? */
  esTerminal: boolean;
  /** Hace la pregunta y devuelve la respuesta tal cual. */
  preguntar: (pregunta: string) => Promise<string>;
  /** Crea el directorio (recursivo). */
  crearDir: (ruta: string) => void;
  /** Crea el fichero SOLO si no existe (`wx`); lanza EEXIST si existe. */
  crearExclusivo: (ruta: string, contenido: string) => void;
}

export interface EscrituraResultado {
  /** 0 hecho o rechazado por la persona; 1 si no se pudo pedir permiso o falló. */
  salida: 0 | 1;
  lineas: string[];
  creados: string[];
}

/**
 * Escribe los ficheros NUEVOS del plan, con permiso. Nunca pisa: los que ya
 * existen se nombran y se dejan; uno que aparece entre la pregunta y la escritura
 * también se deja (`wx`). Sin terminal y sin `--yes`, no escribe nada.
 */
export async function escribirConPermiso(plan: Plan, o: EscrituraOpciones): Promise<EscrituraResultado> {
  const lineas: string[] = [];
  const creados: string[] = [];
  const nuevos = plan.ficheros.filter((f) => !f.existe);
  for (const f of plan.ficheros.filter((x) => x.existe)) lineas.push(`left as is: ${f.ruta} already exists (compare it with the code above).`);
  if (nuevos.length === 0) {
    lineas.push("Nothing to write.");
    return { salida: 0, lineas, creados };
  }
  lineas.push(`About to create ${nuevos.length === 1 ? "1 new file" : `${nuevos.length} new files`} in ${plan.deteccion.dir}:`);
  for (const f of nuevos) lineas.push(`  ${f.ruta}`);
  lineas.push("No existing file is changed, nothing is installed and nothing is run.");

  let permiso = o.si;
  if (!permiso) {
    if (!o.esTerminal) {
      lineas.push("Not writing: this is not an interactive terminal and --yes was not given. Re-run with --write --yes, or copy the code above by hand.");
      return { salida: 1, lineas, creados };
    }
    const respuesta = await o.preguntar("Create them? [y/N] ");
    permiso = /^(y|yes)$/i.test(respuesta.trim());
    if (!permiso) {
      lineas.push("Nothing written.");
      return { salida: 0, lineas, creados };
    }
  }

  let salida: 0 | 1 = 0;
  for (const f of nuevos) {
    const ruta = join(plan.deteccion.dir, ...f.ruta.split("/"));
    try {
      o.crearDir(dirname(ruta));
      o.crearExclusivo(ruta, f.contenido);
      creados.push(f.ruta);
      lineas.push(`created ${f.ruta}`);
    } catch (err) {
      const codigo = (err as { code?: unknown }).code;
      if (codigo === "EEXIST") {
        lineas.push(`left as is: ${f.ruta} appeared while we asked; it was not overwritten.`);
      } else {
        salida = 1;
        lineas.push(`could not create ${f.ruta}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { salida, lineas, creados };
}
