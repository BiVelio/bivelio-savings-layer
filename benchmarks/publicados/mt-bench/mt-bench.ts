/**
 * MT-Bench A/B — batería pública (LMSYS/FastChat, 80 preguntas de 2 turnos).
 * ---------------------------------------------------------------------------
 * Brazo A: la conversación directa contra el API del proveedor, sin la capa.
 * Brazo B: la MISMA conversación a través de `@bivelio/savings-layer` 0.4.31.
 *   · Por defecto, TAL COMO SE INSTALA DE NPM (versión e integridad fijadas
 *     abajo), con la licencia del cliente (`BIVELIO_LICENSE_KEY`): el paquete
 *     publicado es fail-closed.
 *   · Con `--fuente`, el FUENTE de la etiqueta v0.4.31 con la licencia de
 *     desarrollo abierta (`BVSALA_DEV_OPEN=1` / `devUnlicensed: true`), como
 *     `pnpm ab`. Antes de cargar nada se comprueba que (1) el árbol que se
 *     carga es byte a byte `src/` y `packages/` de la etiqueta (equivale a un
 *     `git diff v0.4.31 -- src/ packages/` vacío), (2) la etiqueta apunta al
 *     commit de la release, y (3) `pnpm build` de ese árbol da un
 *     `dist/index.js` con el MISMO sha256 que el del tarball de npm 0.4.31
 *     (descargado con `npm pack` y comprobado contra su integrity). Si algo
 *     no cuadra, no se corre.
 * Los dos brazos se miden con el `usage` real que devuelve el proveedor, leído
 * por el MISMO transporte (un `fetch` envuelto) y el MISMO lector. El informe
 * de la capa se guarda aparte, para comparar lo que ELLA dice haber ahorrado
 * con lo que se midió.
 *
 * Tope de salida: el NATIVO de la capa (0.4.31, #381): el brazo B pasa
 * `maxOutputTokens` y la capa manda `max_completion_tokens` a OpenAI y
 * `max_tokens` a Anthropic; el brazo A manda el mismo campo con el mismo valor.
 * El transporte ya no inyecta nada, y NO envía una petición sin tope.
 *
 * Guarda de hosts: en toda la tirada `fetch` (el global y el de los brazos)
 * solo puede salir a api.anthropic.com, api.openai.com, ai-gateway.vercel.sh
 * (juez) y raw.githubusercontent.com (dataset). Nada de medición ni licencias.
 * Se registran los hosts vistos (solo el host).
 *
 * Calidad: juez de pares de MT-Bench (gpt-4o), las dos posiciones, con la
 * respuesta de referencia en math/reasoning/coding (prompts de FastChat tal
 * cual, del mismo commit fijado).
 *
 * Uso:
 *   pnpm bench:mt-bench --mock                 # sin red: valida el arnés (brazo B = STUB)
 *   pnpm bench:mt-bench --mock --fuente        # sin red de proveedor: la capa REAL del fuente verificado
 *   pnpm bench:mt-bench --fuente               # LIVE con el fuente de la etiqueta
 *   … --modelos=gpt-4o-mini --max-preguntas=8 --sin-juez
 *   … --modelos=claude-haiku-4-5,claude-sonnet-5 --sufijo=claude   # informe aparte: mt-bench-0431-claude.*
 *   pnpm bench:mt-bench --desde-crudo          # recarga la tirada LIVE, completa el juicio con lo
 *                                              # que quede del tope del juez; NO llama a los proveedores
 *
 * Presupuesto DURO (en código): 0,80 $ por modelo de OpenAI y 1,25 $ por modelo
 * de Anthropic (A+B juntos), y 0,50 $ de juez en total. Cada llamada reserva su
 * peor coste antes de salir y no sale si no cabe; ver `Tope` en nucleo.ts.
 *
 * Credenciales: solo por `--env-file` (el script de package.json lee
 * `.env.bench`). Nada de este fichero imprime, guarda ni vuelca una clave: los
 * errores pasan por `redactar` y los cuerpos que se guardan son de petición,
 * nunca cabeceras.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrapMeanCI, bootstrapRatioCI, bootstrapRatioCIEstratificado, wilcoxonSignedRankP, type CI } from "../../stats.js";
import {
  CATEGORIAS,
  CATEGORIAS_CON_REFERENCIA,
  DATASET,
  MODELOS_POR_DEFECTO,
  PresupuestoAgotado,
  SEMILLA_DE_MUESTRA,
  TEMPERATURA_FASTCHAT,
  HOSTS_PERMITIDOS,
  TOPE_DEL_JUEZ_USD,
  TOPE_POR_FAMILIA_USD,
  Tope,
  atribucionDelAhorro,
  claseDelAhorro,
  combinarPartidas,
  costeDeUso,
  conRespuestasDe,
  diferenciasDeArbol,
  diferenciasDeCuerpo,
  fmtUsd,
  hostDe,
  hostPermitido,
  idCualificado,
  leerVeredicto,
  ordenEstratificado,
  parsearPreguntas,
  parsearPromptsDelJuez,
  parsearReferencias,
  parteDelJuez,
  percentil,
  peorCosteDeLlamada,
  peorCosteDePregunta,
  primaDeEscritura,
  promptDelJuez,
  puntuacionDeB,
  redactar,
  sumarUsos,
  topeDelCuerpo,
  topePorModelo,
  urlDeFichero,
  usoDeAnthropic,
  usoDeOpenAI,
  type Categoria,
  type Atribucion,
  type ClaseDelAhorro,
  type ConversacionDeDosTurnos,
  type Familia,
  type Ganador,
  type ModeloDeLaBateria,
  type NombreDeFichero,
  type Precio,
  type Pregunta,
  type PromptDelJuez,
  type Referencia,
  type UsoMedido,
} from "./nucleo.js";

// ── Fijaciones del paquete ──────────────────────────────────────────────────

/** `npm view @bivelio/savings-layer@0.4.31 dist.integrity dist.shasum` (2026-09-28). */
export const PAQUETE = {
  nombre: "@bivelio/savings-layer",
  version: "0.4.31",
  integrity: "sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==",
  shasum: "7873565508afb4f01c77e84007e0619b51b64ba4",
  /** El peer que el README pide para modelos de OpenAI (conteo exacto). */
  tokenizador: "gpt-tokenizer@3.4.0",
  origen: "npm registry (no el tarball local)",
} as const;

/** El fuente que se carga con `--fuente`: la etiqueta de la release, verificada contra npm. */
export const FUENTE = {
  etiqueta: "v0.4.31",
  commit: "00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c",
  rutas: ["src", "packages"],
  /** Lo que el build necesita además de las rutas verificadas (se extrae de la misma etiqueta). */
  rutasDelBuild: ["gateway", "tsup.config.ts", "tsconfig.json", "package.json"],
  brazoB: "v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical)",
} as const;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..", "..", "..");
const DIR_TRABAJO = join(RAIZ, "benchmarks", "out", "mt-bench");
const DIR_SDK = join(DIR_TRABAJO, "sdk");
const DIR_DATOS = join(DIR_TRABAJO, "datos");
const FECHA = "2026-09-28";
/**
 * El gasto LIVE acumulado de esta batería, por modelo y por juez, ENTRE
 * tiradas. Sin él, correr un modelo dos veces (o de uno en uno) daría a cada
 * tirada el tope entero: el tope es de la batería, no de la invocación.
 */
const libroDeGasto = (sufijo: string): string =>
  join(DIR_TRABAJO, `gasto-live-${PAQUETE.version}${sufijo ? `-${sufijo}` : ""}.json`);
/**
 * El árbol de la etiqueta, extraído con `git archive`. Empieza por punto a
 * propósito: los globs de tsconfig (`benchmarks/**`) no entran en carpetas con
 * punto, así que esta copia del fuente no se typechequea dos veces.
 */
const DIR_FUENTE = join(DIR_TRABAJO, `.fuente-${FUENTE.etiqueta}`);
const DIR_NPM = join(DIR_TRABAJO, `npm-${PAQUETE.version}`);

interface LibroDeGasto {
  generacion: Record<string, number>;
  juez: Record<string, number>;
}

function leerLibro(sufijo: string): LibroDeGasto {
  const f = libroDeGasto(sufijo);
  if (!existsSync(f)) return { generacion: {}, juez: {} };
  return JSON.parse(readFileSync(f, "utf8")) as LibroDeGasto;
}

function guardarLibro(l: LibroDeGasto, sufijo: string): void {
  mkdirSync(DIR_TRABAJO, { recursive: true });
  writeFileSync(libroDeGasto(sufijo), JSON.stringify(l, null, 2) + "\n");
}
const DIR_PUBLICADO = join(RAIZ, "docs", "benchmarks", FECHA);

// ── Argumentos ──────────────────────────────────────────────────────────────

interface Opciones {
  mock: boolean;
  /** Brazo B = el fuente de la etiqueta verificado contra npm, con la licencia de desarrollo abierta. */
  fuente: boolean;
  /** Solo `--mock`: la comprobación gratuita de Anthropic devuelve 401 (valida esa rama). */
  mockAnthropic401: boolean;
  /**
   * LIVE: no genera nada. Recarga la tirada LIVE anterior (informe publicado +
   * respuestas crudas), completa el juicio con lo que QUEDE del tope del juez y
   * vuelve a escribir el informe. Nunca vuelve a llamar a los proveedores.
   */
  desdeCrudo: boolean;
  modelos: ModeloDeLaBateria[];
  maxPreguntas: number;
  juez: boolean;
  concurrenciaPreguntas: number;
  /**
   * Sufijo del informe y del libro de gasto (`--sufijo=claude` →
   * `mt-bench-0431-claude.{json,md}`): otra tirada de la MISMA batería no pisa
   * los ficheros publicados de la anterior, y su tope es el suyo.
   */
  sufijo: string;
  /**
   * `--fuente-de-main` (banco semanal, benchmarks/banco-semanal): el brazo B es el
   * fuente de ESTE árbol, sea la versión que sea (lo que main lleva hoy, no una
   * release), con `BVSALA_DEV_OPEN=1`. Sin verificación contra etiqueta ni npm.
   */
  fuenteDeMain: boolean;
  /** `--tope=USD`: tope de generación por modelo; solo BAJA `topePorModelo`. */
  tope?: number;
  /** `--tope-juez=USD`: tope del juez para esta invocación; solo BAJA `TOPE_DEL_JUEZ_USD`. */
  topeJuez?: number;
  /** `--salida=DIR`: dónde se escriben el .json y el .md (por defecto, los de siempre). */
  salida?: string;
}

function leerOpciones(argv: string[]): Opciones {
  const valor = (n: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const ids = valor("modelos")?.split(",").map((s) => s.trim()).filter(Boolean);
  const modelos = ids
    ? ids.map((id) => {
        const m = MODELOS_POR_DEFECTO.find((x) => x.id === id);
        if (!m) throw new Error(`modelo no previsto en la batería: ${id} (${MODELOS_POR_DEFECTO.map((x) => x.id).join(", ")})`);
        return m;
      })
    : MODELOS_POR_DEFECTO;
  const max = Number(valor("max-preguntas") ?? 80);
  const usd = (n: string): number | undefined => {
    const v = valor(n);
    if (v === undefined) return undefined;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new Error(`--${n} inválido: ${v}`);
    return x;
  };
  const tope = usd("tope");
  const topeJuez = usd("tope-juez");
  const salida = valor("salida");
  return {
    fuenteDeMain: argv.includes("--fuente-de-main"),
    ...(tope !== undefined ? { tope } : {}),
    ...(topeJuez !== undefined ? { topeJuez } : {}),
    ...(salida ? { salida } : {}),
    mock: argv.includes("--mock"),
    fuente: argv.includes("--fuente"),
    mockAnthropic401: argv.includes("--mock-anthropic-401"),
    desdeCrudo: argv.includes("--desde-crudo"),
    modelos,
    maxPreguntas: Number.isFinite(max) && max > 0 ? Math.min(80, Math.floor(max)) : 80,
    juez: !argv.includes("--sin-juez"),
    // 2 preguntas a la vez × 2 brazos = ≤ 4 peticiones simultáneas por proveedor.
    concurrenciaPreguntas: 2,
    sufijo: (valor("sufijo") ?? "").replace(/[^a-z0-9-]/gi, ""),
  };
}

// ── Secretos: solo para taparlos ────────────────────────────────────────────

function secretos(): (string | undefined)[] {
  return Object.entries(process.env)
    .filter(([k]) => /API_KEY|SERVICE_KEY|LICENSE_KEY|TOKEN|SECRET/i.test(k))
    .map(([, v]) => v);
}
const tapar = (s: string): string => redactar(s, secretos());

// ── Dataset ─────────────────────────────────────────────────────────────────

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

async function ficheroDelDataset(nombre: NombreDeFichero, conRed: boolean): Promise<string | null> {
  const f = DATASET.ficheros[nombre];
  const local = join(DIR_DATOS, DATASET.commit, f.path.split("/").pop()!);
  if (existsSync(local)) {
    const t = readFileSync(local, "utf8");
    if (sha256(t) === f.sha256) return t;
    throw new Error(`MT-Bench: ${local} en caché no coincide con el sha256 fijado; bórralo`);
  }
  if (!conRed) return null;
  const res = await fetch(urlDeFichero(nombre));
  if (!res.ok) throw new Error(`MT-Bench: HTTP ${res.status} descargando ${f.path}`);
  const t = await res.text();
  const h = sha256(t);
  if (h !== f.sha256) throw new Error(`MT-Bench: sha256 de ${f.path} = ${h}, esperado ${f.sha256}. No es el benchmark fijado.`);
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, t);
  return t;
}

interface Dataset {
  origen: "fastchat-fijado" | "sintetico-mock";
  preguntas: Pregunta[];
  referencias: Map<number, Referencia>;
  prompts: Map<string, PromptDelJuez>;
}

async function cargarDataset(conRed: boolean): Promise<Dataset> {
  const [q, r, j] = await Promise.all([
    ficheroDelDataset("preguntas", conRed),
    ficheroDelDataset("referencias", conRed),
    ficheroDelDataset("promptsDelJuez", conRed),
  ]);
  if (q && r && j) {
    const preguntas = parsearPreguntas(q);
    if (preguntas.length !== 80) throw new Error(`MT-Bench: ${preguntas.length} preguntas, esperadas 80`);
    return { origen: "fastchat-fijado", preguntas, referencias: parsearReferencias(r), prompts: parsearPromptsDelJuez(j) };
  }
  return datasetSintetico();
}

/** Solo para `--mock` sin la caché del dataset: 2 preguntas por categoría y prompts con la misma forma. */
function datasetSintetico(): Dataset {
  const preguntas: Pregunta[] = [];
  let id = 1;
  for (const c of CATEGORIAS) {
    for (let k = 0; k < 2; k++, id++) preguntas.push({ id, categoria: c, turnos: [`[${c}] pregunta ${id}`, `[${c}] seguimiento ${id}`] });
  }
  const referencias = new Map<number, Referencia>();
  for (const p of preguntas) if (CATEGORIAS_CON_REFERENCIA.includes(p.categoria)) referencias.set(p.id, { id: p.id, turnos: ["ref 1", "ref 2"] });
  const sys = 'Juzga. Veredicto: "[[A]]", "[[B]]" o "[[C]]".';
  const t1 = "[User Question]\n{question}\n[A]\n{answer_a}\n[B]\n{answer_b}";
  const t2 = "{question_1}\n{answer_a_1}\n{question_2}\n{answer_a_2}\n---\n{answer_b_1}\n{answer_b_2}";
  const prompts = new Map<string, PromptDelJuez>();
  for (const [name, tpl] of [
    ["pair-v2", t1],
    ["pair-v2-multi-turn", t2],
    ["pair-math-v1", "{ref_answer_1}\n" + t1],
    ["pair-math-v1-multi-turn", "{ref_answer_1}\n{ref_answer_2}\n" + t2],
  ] as const) {
    prompts.set(name, { name, type: "pairwise", system_prompt: sys, prompt_template: tpl, output_format: "[[A]]" });
  }
  return { origen: "sintetico-mock", preguntas, referencias, prompts };
}

// ── El paquete, tal como se instala ─────────────────────────────────────────

/** La parte de la API pública de 0.4.31 que usa la batería (tipada a mano: se carga en tiempo de ejecución). */
interface InformeDeLaCapa {
  model: string;
  calls: { baselineLlm: number; actualLlm: number; avoidedLlm: number; retries: number };
  tokens: { baselineInput: number; actualInput: number; baselineOutput: number; actualOutput: number; providerCachedInput?: number; eliminatedInput: number; compressedInput: number };
  cache: { result: string };
  routing: { executionClass: string; reason?: string };
  cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
  qualityStatus?: string;
  latencyMs: { total: number; preprocessing: number; provider: number };
  traces: { stage: string; outcome: string }[];
}
interface ResultadoDeLaCapa {
  text: string;
  finishReason?: string;
  report: InformeDeLaCapa;
}
interface CapaCargada {
  generate(req: { model: string; messages: { role: string; content: string }[]; temperature?: number; maxOutputTokens?: number }): Promise<ResultadoDeLaCapa>;
  close(): void;
}
interface ModuloDelPaquete {
  BV_SALA_VERSION: string;
  CATALOGO: Readonly<Record<string, Precio>>;
  createSavingsLayer(cfg: Record<string, unknown>): CapaCargada;
  AnthropicProvider: new (o: Record<string, unknown>) => unknown;
  OpenAICompatibleProvider: new (o: Record<string, unknown>) => unknown;
}

function asegurarPaquete(): { dir: string; integrityInstalada: string } {
  const pj = join(DIR_SDK, "node_modules", "@bivelio", "savings-layer", "package.json");
  const lock = join(DIR_SDK, "package-lock.json");
  const instalada = (): string | null => {
    if (!existsSync(pj) || !existsSync(lock)) return null;
    const v = (JSON.parse(readFileSync(pj, "utf8")) as { version: string }).version;
    const l = JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, { integrity?: string }> };
    const integ = l.packages?.["node_modules/@bivelio/savings-layer"]?.integrity ?? "";
    return v === PAQUETE.version && integ === PAQUETE.integrity ? integ : null;
  };
  let integ = instalada();
  if (!integ) {
    mkdirSync(DIR_SDK, { recursive: true });
    writeFileSync(join(DIR_SDK, "package.json"), JSON.stringify({ name: "mt-bench-sdk", private: true }) + "\n");
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", `${PAQUETE.nombre}@${PAQUETE.version}`, PAQUETE.tokenizador],
      { cwd: DIR_SDK, stdio: "inherit" },
    );
    integ = instalada();
    if (!integ) throw new Error(`MT-Bench: el paquete instalado no es ${PAQUETE.nombre}@${PAQUETE.version} con la integridad fijada`);
  }
  return { dir: DIR_SDK, integrityInstalada: integ };
}

async function cargarPaquete(): Promise<{ mod: ModuloDelPaquete; integrity: string }> {
  const { dir, integrityInstalada } = asegurarPaquete();
  const entrada = join(dir, "node_modules", "@bivelio", "savings-layer", "dist", "index.js");
  const mod = (await import(pathToFileURL(entrada).href)) as ModuloDelPaquete;
  if ((mod.BV_SALA_VERSION as string) !== PAQUETE.version) {
    throw new Error(`MT-Bench: el paquete cargado dice ser ${mod.BV_SALA_VERSION}, esperado ${PAQUETE.version}`);
  }
  return { mod, integrity: integrityInstalada };
}

// ── El fuente de la etiqueta, verificado contra npm ─────────────────────────

export interface VerificacionDelFuente {
  etiqueta: string;
  commit: string;
  fetchDeEtiquetas: string;
  /** `git diff --name-status v0.4.31 -- src/ packages/` en el árbol de trabajo del repo (informativo). */
  diffDelRepo: string[];
  /** Qué árbol se carga y su diferencia con la etiqueta (tiene que ser vacía). */
  arbolCargado: string;
  ficherosVerificados: number;
  diffDelArbolCargado: string[];
  npm: { tarball: string; integrity: string; sha256DistIndex: string };
  build: { sha256DistIndex: string };
  distIdentico: boolean;
  versionCargada: string;
}

function git(args: string[], cwd = RAIZ): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}

const blobDeGit = (b: Buffer): string => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

function listadoDeLaEtiqueta(): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of git(["ls-tree", "-r", FUENTE.etiqueta, "--", ...FUENTE.rutas]).split("\n")) {
    const t = l.indexOf("\t");
    if (t < 0) continue;
    const [, tipo, h] = l.slice(0, t).split(" ");
    if (tipo === "blob") m.set(l.slice(t + 1), h!);
  }
  return m;
}

function listadoDelArbol(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const recorrer = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.isFile()) m.set(relative(dir, p).split("\\").join("/"), blobDeGit(readFileSync(p)));
    }
  };
  for (const r of FUENTE.rutas) if (existsSync(join(dir, r))) recorrer(join(dir, r));
  return m;
}

const sha256DeFichero = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

/**
 * Deja listo y VERIFICADO el fuente de la etiqueta. Aborta (lanza) si la
 * etiqueta no es el commit de la release, si el árbol extraído no es el de la
 * etiqueta, si el tarball de npm no tiene la integrity fijada, o si el build del
 * fuente no da el mismo `dist/index.js` que el tarball.
 */
function verificarFuente(): VerificacionDelFuente {
  let fetchDeEtiquetas = "ok";
  try {
    execFileSync("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: RAIZ, stdio: "ignore" });
  } catch (e) {
    fetchDeEtiquetas = `falló (${tapar(String((e as Error).message)).slice(0, 120)}); se usa la etiqueta local`;
  }
  const commit = git(["rev-parse", `${FUENTE.etiqueta}^{commit}`]).trim();
  if (commit !== FUENTE.commit) throw new Error(`--fuente: ${FUENTE.etiqueta} apunta a ${commit}, esperado ${FUENTE.commit}`);
  const diffDelRepo = git(["diff", "--name-status", FUENTE.etiqueta, "--", ...FUENTE.rutas.map((r) => `${r}/`)])
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  // El árbol que se carga: SIEMPRE el de la etiqueta, extraído con `git archive`.
  // Así el `git diff` que importa (el del árbol cargado) es vacío por
  // construcción, y se comprueba igualmente fichero a fichero.
  const etiqueta = listadoDeLaEtiqueta();
  let diffDelArbol = existsSync(DIR_FUENTE) ? diferenciasDeArbol(etiqueta, listadoDelArbol(DIR_FUENTE)) : ["(no extraído)"];
  if (diffDelArbol.length) {
    rmSync(DIR_FUENTE, { recursive: true, force: true });
    mkdirSync(DIR_FUENTE, { recursive: true });
    const tar = execFileSync("git", ["archive", "--format=tar", FUENTE.etiqueta, ...FUENTE.rutas, ...FUENTE.rutasDelBuild], { cwd: RAIZ, maxBuffer: 256 << 20 });
    execFileSync("tar", ["-x", "-C", DIR_FUENTE], { input: tar });
    diffDelArbol = diferenciasDeArbol(etiqueta, listadoDelArbol(DIR_FUENTE));
  }
  if (diffDelArbol.length) throw new Error(`--fuente: el árbol extraído difiere de ${FUENTE.etiqueta}: ${diffDelArbol.slice(0, 10).join(", ")}`);
  if (!existsSync(join(DIR_FUENTE, "node_modules"))) symlinkSync(join(RAIZ, "node_modules"), join(DIR_FUENTE, "node_modules"), "dir");
  // La clave PÚBLICA de licencias que el build embebe (no está en git; es pública
  // y va dentro del bundle de npm). Sin ella el sha256 no puede coincidir.
  const pub = join(RAIZ, "keys", "license.pub.pem");
  if (!existsSync(pub)) throw new Error("--fuente: falta keys/license.pub.pem (la clave pública que embebe el build)");
  mkdirSync(join(DIR_FUENTE, "keys"), { recursive: true });
  copyFileSync(pub, join(DIR_FUENTE, "keys", "license.pub.pem"));

  // El tarball de npm, comprobado contra la integrity fijada.
  mkdirSync(DIR_NPM, { recursive: true });
  const tgz = join(DIR_NPM, `bivelio-savings-layer-${PAQUETE.version}.tgz`);
  if (!existsSync(tgz)) execFileSync("npm", ["pack", `${PAQUETE.nombre}@${PAQUETE.version}`, "--silent"], { cwd: DIR_NPM, stdio: "ignore" });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
  if (integrity !== PAQUETE.integrity) throw new Error(`--fuente: el tarball de npm tiene integrity ${integrity}, esperada ${PAQUETE.integrity}`);
  execFileSync("tar", ["-xzf", tgz, "-C", DIR_NPM, "package/dist/index.js"]);
  const shaNpm = sha256DeFichero(join(DIR_NPM, "package", "dist", "index.js"));

  // El build del fuente, en SU carpeta (no toca dist/ ni apps/web/public/vendor del repo).
  execFileSync("pnpm", ["build"], { cwd: DIR_FUENTE, stdio: "ignore" });
  const shaBuild = sha256DeFichero(join(DIR_FUENTE, "dist", "index.js"));
  if (shaBuild !== shaNpm) {
    throw new Error(`--fuente: el build de ${FUENTE.etiqueta} da dist/index.js ${shaBuild}, el tarball de npm ${shaNpm}. No es el mismo paquete: no se corre.`);
  }
  return {
    etiqueta: FUENTE.etiqueta,
    commit,
    fetchDeEtiquetas,
    diffDelRepo,
    arbolCargado: `${relative(RAIZ, DIR_FUENTE)} (git archive ${FUENTE.etiqueta})`,
    ficherosVerificados: etiqueta.size,
    diffDelArbolCargado: diffDelArbol,
    npm: { tarball: `${PAQUETE.nombre}@${PAQUETE.version} (npm pack)`, integrity, sha256DistIndex: shaNpm },
    build: { sha256DistIndex: shaBuild },
    distIdentico: true,
    versionCargada: "",
  };
}

async function cargarFuente(): Promise<{ mod: ModuloDelPaquete; verificacion: VerificacionDelFuente }> {
  const verificacion = verificarFuente();
  // La licencia de desarrollo abierta, como `pnpm ab` (autorizado por el dueño
  // para esta batería: el paquete de npm exige licencia y no hay una de pruebas).
  process.env.BVSALA_DEV_OPEN = "1";
  const mod = (await import(pathToFileURL(join(DIR_FUENTE, "src", "index.ts")).href)) as ModuloDelPaquete;
  if (mod.BV_SALA_VERSION !== PAQUETE.version) {
    throw new Error(`--fuente: el fuente cargado dice ser ${mod.BV_SALA_VERSION}, esperado ${PAQUETE.version}`);
  }
  verificacion.versionCargada = mod.BV_SALA_VERSION;
  return { mod, verificacion };
}

/** `--fuente-de-main`: el fuente de este árbol, sin etiqueta ni npm (banco semanal). */
async function cargarArbol(): Promise<ModuloDelPaquete> {
  process.env.BVSALA_DEV_OPEN = "1";
  return (await import(pathToFileURL(join(RAIZ, "src", "index.ts")).href)) as ModuloDelPaquete;
}

// ── La guarda de hosts ──────────────────────────────────────────────────────

const hostsVistos = new Map<string, number>();
const hostsBloqueados = new Map<string, number>();

function urlDe(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
}

/** Envuelve un `fetch`: solo deja salir a `HOSTS_PERMITIDOS` y apunta el host (nada más). */
function conGuardaDeHosts(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlDe(input);
    const h = hostDe(url);
    if (!hostPermitido(url)) {
      hostsBloqueados.set(h, (hostsBloqueados.get(h) ?? 0) + 1);
      throw new Error(`guarda de hosts: ${h} no está entre los permitidos (${HOSTS_PERMITIDOS.join(", ")})`);
    }
    hostsVistos.set(h, (hostsVistos.get(h) ?? 0) + 1);
    return base(input, init);
  }) as typeof fetch;
}

// ── Transporte medido (el mismo para los dos brazos) ────────────────────────

type Brazo = "A" | "B";

interface LlamadaMedida {
  brazo: Brazo;
  turno: 1 | 2;
  status: number;
  uso: UsoMedido | null;
  coste: number;
  latenciaMs: number;
  reintentos: number;
  modeloServido: string | null;
  finDeGeneracion: string | null;
  /** Cuerpo de la PETICIÓN (sin cabeceras): lo que salió por el cable. */
  cuerpo: unknown;
  error?: string;
}

interface ContextoDeTransporte {
  familia: Familia;
  precio: Precio;
  tope: Tope;
  maxSalida: number;
  brazo: Brazo;
  turno: 1 | 2;
  registro: LlamadaMedida[];
  base: typeof fetch;
}

const REINTENTABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Un `fetch` que: (1) NO envía una petición sin tope de salida (`max_tokens` o
 * `max_completion_tokens`): sin él no hay peor caso y el tope de gasto dejaría
 * de serlo; el banco no lo inyecta, lo pone quien llama; (2) reserva el peor coste en el tope ANTES
 * de enviar; (3) reintenta 429/5xx con backoff exponencial y `retry-after`; (4)
 * lee el `usage` de la respuesta con el lector de la familia y cierra la
 * reserva con el coste real. La respuesta que recibe el llamante (la capa o el
 * brazo A) es la misma, intacta.
 */
function fetchMedido(ctx: ContextoDeTransporte): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let cuerpo: Record<string, unknown> = {};
    const texto = typeof init?.body === "string" ? init.body : "";
    if (texto) cuerpo = JSON.parse(texto) as Record<string, unknown>;
    const maxSalida = topeDelCuerpo(cuerpo);
    if (maxSalida === null) {
      const err = "petición sin tope de salida (ni max_tokens ni max_completion_tokens): no se envía";
      ctx.registro.push({ brazo: ctx.brazo, turno: ctx.turno, status: 0, uso: null, coste: 0, latenciaMs: 0, reintentos: 0, modeloServido: null, finDeGeneracion: null, cuerpo, error: err });
      throw new Error(`transporte: ${err}`);
    }
    const reserva = ctx.tope.reservar(
      peorCosteDeLlamada(ctx.precio, primaDeEscritura(ctx.familia), JSON.stringify(cuerpo["messages"] ?? cuerpo).length + JSON.stringify(cuerpo["system"] ?? "").length, maxSalida, 256),
    );
    const t0 = performance.now();
    let reintentos = 0;
    let res: Response | null = null;
    let ultimoError: unknown = null;
    for (let intento = 0; intento < 7; intento++) {
      try {
        res = await ctx.base(input, init);
        if (!REINTENTABLE.has(res.status) || intento === 6) break;
        const ra = Number(res.headers.get("retry-after"));
        await res.text().catch(() => "");
        reintentos++;
        await esperar(Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** intento) + Math.random() * 500));
      } catch (e) {
        ultimoError = e;
        res = null;
        if (intento === 6) break;
        reintentos++;
        await esperar(Math.min(60_000, 2000 * 2 ** intento));
      }
    }
    const latenciaMs = performance.now() - t0;
    if (!res) {
      ctx.tope.cerrar(reserva, 0);
      const err = tapar(String((ultimoError as Error)?.message ?? ultimoError));
      ctx.registro.push({ brazo: ctx.brazo, turno: ctx.turno, status: 0, uso: null, coste: 0, latenciaMs, reintentos, modeloServido: null, finDeGeneracion: null, cuerpo, error: err });
      throw new Error(`transporte: ${err}`);
    }
    const crudo = await res.clone().text();
    let json: unknown = null;
    try {
      json = JSON.parse(crudo);
    } catch {
      /* se registra abajo como error */
    }
    if (!res.ok) {
      // Un 4xx/5xx no se factura: se cierra la reserva a 0 y se registra, tapado.
      ctx.tope.cerrar(reserva, 0);
      ctx.registro.push({ brazo: ctx.brazo, turno: ctx.turno, status: res.status, uso: null, coste: 0, latenciaMs, reintentos, modeloServido: null, finDeGeneracion: null, cuerpo, error: tapar(crudo.slice(0, 600)) });
      return res;
    }
    let uso: UsoMedido | null = null;
    let coste = 0;
    try {
      uso = ctx.familia === "anthropic" ? usoDeAnthropic(json) : usoDeOpenAI(json);
      coste = costeDeUso(ctx.precio, primaDeEscritura(ctx.familia), uso);
    } catch (e) {
      // Sin usage no hay medida: se cobra la reserva entera (peor caso) para que el tope siga siendo un tope.
      coste = reserva;
      ctx.registro.push({ brazo: ctx.brazo, turno: ctx.turno, status: res.status, uso: null, coste, latenciaMs, reintentos, modeloServido: null, finDeGeneracion: null, cuerpo, error: tapar(String((e as Error).message)) });
      ctx.tope.cerrar(reserva, coste);
      return res;
    }
    ctx.tope.cerrar(reserva, coste);
    const j = json as { model?: string; stop_reason?: string; choices?: { finish_reason?: string }[] };
    ctx.registro.push({
      brazo: ctx.brazo,
      turno: ctx.turno,
      status: res.status,
      uso,
      coste,
      latenciaMs,
      reintentos,
      modeloServido: j.model ?? null,
      finDeGeneracion: j.stop_reason ?? j.choices?.[0]?.finish_reason ?? null,
      cuerpo,
    });
    return res;
  }) as typeof fetch;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

function baseV1(v: string | undefined, porDefecto: string): string {
  let b = (v ?? porDefecto).trim();
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  b = b.replace(/\/+$/, "");
  if (!/\/v1$/.test(b)) b = `${b}/v1`;
  return b;
}

interface Credenciales {
  anthropic: { base: string; clave: string | undefined };
  openai: { base: string; clave: string | undefined };
  juez: { base: string; clave: string | undefined; modelo: string };
  licencia: string | undefined;
}

function credenciales(): Credenciales {
  const e = process.env;
  return {
    anthropic: { base: baseV1(e.BVSALA_DEMO_ANTHROPIC_BASE_URL, "api.anthropic.com"), clave: e.BVSALA_DEMO_ANTHROPIC_API_KEY },
    openai: { base: baseV1(e.BVSALA_DEMO_BASE_URL, "api.openai.com"), clave: e.BVSALA_DEMO_API_KEY },
    juez: { base: baseV1(e.BVSALA_JUDGE_BASE_URL, "ai-gateway.vercel.sh"), clave: e.BVSALA_JUDGE_API_KEY, modelo: e.BVSALA_JUDGE_MODEL ?? "openai/gpt-4o" },
    licencia: e.BIVELIO_LICENSE_KEY,
  };
}

// ── Brazo A: la llamada directa ─────────────────────────────────────────────

interface Respuesta {
  texto: string;
  fin: string | null;
  latenciaMs: number;
}

type Mensaje = { role: "user" | "assistant"; content: string };

async function llamarDirecto(
  m: ModeloDeLaBateria,
  cred: Credenciales,
  mensajes: Mensaje[],
  temperatura: number | undefined,
  f: typeof fetch,
): Promise<Respuesta> {
  const t0 = performance.now();
  if (m.familia === "anthropic") {
    const body: Record<string, unknown> = { model: m.id, max_tokens: m.maxSalida, messages: mensajes };
    if (temperatura !== undefined) body["temperature"] = temperatura;
    const res = await f(`${cred.anthropic.base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cred.anthropic.clave ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`brazo A ${m.id}: HTTP ${res.status}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    const texto = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { texto, fin: j.stop_reason ?? null, latenciaMs: performance.now() - t0 };
  }
  const body: Record<string, unknown> = { model: m.id, messages: mensajes, max_completion_tokens: m.maxSalida };
  if (temperatura !== undefined) body["temperature"] = temperatura;
  const res = await f(`${cred.openai.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cred.openai.clave ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`brazo A ${m.id}: HTTP ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  return { texto: j.choices?.[0]?.message?.content ?? "", fin: j.choices?.[0]?.finish_reason ?? null, latenciaMs: performance.now() - t0 };
}

// ── Brazo B: la capa ────────────────────────────────────────────────────────

interface FabricaDeCapa {
  descripcion: string;
  crear(m: ModeloDeLaBateria, f: typeof fetch): CapaCargada;
}

function fabricaReal(
  mod: ModuloDelPaquete,
  cred: Credenciales,
  origen: { tipo: "npm" } | { tipo: "fuente"; descripcion?: string },
): FabricaDeCapa {
  return {
    descripcion:
      origen.tipo === "fuente"
        ? (origen.descripcion ?? FUENTE.brazoB)
        : `${PAQUETE.nombre}@${mod.BV_SALA_VERSION} de npm, licenseKey del cliente, sin licenseServerUrl (ruta offline: sin metering ni llamada a casa)`,
    crear(m, f) {
      // Sin `defaultMaxOutputTokens`: el tope va POR PETICIÓN (`maxOutputTokens`),
      // que es la palanca nativa de la 0.4.31 en las dos familias.
      const provider =
        m.familia === "anthropic"
          ? new mod.AnthropicProvider({ apiKey: cred.anthropic.clave, baseUrl: cred.anthropic.base, fetchImpl: f })
          : new mod.OpenAICompatibleProvider({ apiKey: cred.openai.clave, baseUrl: cred.openai.base, fetchImpl: f });
      const precio = mod.CATALOGO[m.id];
      return mod.createSavingsLayer({
        provider,
        ...(origen.tipo === "fuente" ? { devUnlicensed: true } : { licenseKey: cred.licencia }),
        ...(precio ? { defaultCostModel: precio } : {}),
      });
    },
  };
}

/**
 * SOLO `--mock`: un doble de la capa que manda la misma petición que el brazo A
 * por el transporte medido. Valida la fontanería (transporte, tope, juez,
 * estadística, informe), NO la capa: el informe lo declara `STUB`.
 */
function fabricaStub(cred: Credenciales): FabricaDeCapa {
  return {
    descripcion: "STUB de --mock (no es la capa: pasa la petición tal cual)",
    crear(m, f) {
      return {
        async generate(req) {
          const r = await llamarDirecto({ ...m, maxSalida: req.maxOutputTokens ?? m.maxSalida }, cred, req.messages as Mensaje[], req.temperature, f);
          return {
            text: r.texto,
            ...(r.fin ? { finishReason: r.fin } : {}),
            report: {
              model: req.model,
              calls: { baselineLlm: 1, actualLlm: 1, avoidedLlm: 0, retries: 0 },
              tokens: { baselineInput: 0, actualInput: 0, baselineOutput: 0, actualOutput: 0, eliminatedInput: 0, compressedInput: 0 },
              cache: { result: "miss" },
              routing: { executionClass: "stub" },
              cost: { baselineEstimate: 0, actual: 0, netSavings: 0, basis: "estimated" },
              latencyMs: { total: r.latenciaMs, preprocessing: 0, provider: r.latenciaMs },
              traces: [],
            },
          };
        },
        close() {},
      };
    },
  };
}

// ── Mock de red ─────────────────────────────────────────────────────────────

/** Un proveedor falso determinista: respuestas y usage con la forma de cada API. */
function fetchFalso(anthropic401 = false): typeof fetch {
  let n = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlDe(input);
    if ((init?.method ?? "GET") === "GET" && /\/models(\?|$)/.test(url)) {
      return anthropic401 && url.includes("anthropic")
        ? new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 })
        : new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: unknown }[]; model?: string };
    const chars = JSON.stringify(body.messages ?? []).length;
    n++;
    const esJuez = url.includes("ai-gateway") || String(body.model).startsWith("openai/gpt-4o");
    const texto = esJuez ? `Explicación simulada. [[${["A", "B", "C"][n % 3]}]]` : `Respuesta simulada ${n % 5} de ${body.model}.`;
    const salida = 40 + (n % 17);
    if (url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({ model: body.model, content: [{ type: "text", text: texto }], stop_reason: "end_turn", usage: { input_tokens: Math.ceil(chars / 4), output_tokens: salida, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: texto }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(chars / 4), completion_tokens: salida, prompt_tokens_details: { cached_tokens: 0 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

// ── Una pregunta, dos brazos, dos turnos ────────────────────────────────────

interface TurnoDeBrazo {
  texto: string;
  fin: string | null;
  latenciaMs: number;
  informe?: Pick<InformeDeLaCapa, "calls" | "tokens" | "cache" | "routing" | "cost" | "qualityStatus" | "latencyMs"> & { etapas: string[] };
}

interface ResultadoDePregunta {
  id: number;
  categoria: Categoria;
  temperatura: number | null;
  A: TurnoDeBrazo[];
  B: TurnoDeBrazo[];
  llamadas: LlamadaMedida[];
  error?: string;
}

async function correrPregunta(
  p: Pregunta,
  m: ModeloDeLaBateria,
  cred: Credenciales,
  fabrica: FabricaDeCapa,
  tope: Tope,
  precio: Precio,
  base: typeof fetch,
): Promise<ResultadoDePregunta> {
  const temperatura = m.temperatura ? TEMPERATURA_FASTCHAT[p.categoria] : undefined;
  const registro: LlamadaMedida[] = [];
  const ctxA: ContextoDeTransporte = { familia: m.familia, precio, tope, maxSalida: m.maxSalida, brazo: "A", turno: 1, registro, base };
  const ctxB: ContextoDeTransporte = { ...ctxA, brazo: "B" };
  const fA = fetchMedido(ctxA);
  const fB = fetchMedido(ctxB);
  // Una capa NUEVA por pregunta: caché y memoria frías, como el titular de ab-live.
  const capa = fabrica.crear(m, fB);
  const histA: Mensaje[] = [];
  const histB: Mensaje[] = [];
  const out: ResultadoDePregunta = { id: p.id, categoria: p.categoria, temperatura: temperatura ?? null, A: [], B: [], llamadas: registro };
  try {
    for (const turno of [1, 2] as const) {
      ctxA.turno = turno;
      ctxB.turno = turno;
      histA.push({ role: "user", content: p.turnos[turno - 1]! });
      histB.push({ role: "user", content: p.turnos[turno - 1]! });
      const [ra, rb] = await Promise.all([
        llamarDirecto(m, cred, [...histA], temperatura, fA),
        (async () => {
          const t0 = performance.now();
          const r = await capa.generate({
            model: idCualificado(m),
            messages: [...histB],
            maxOutputTokens: m.maxSalida,
            ...(temperatura !== undefined ? { temperature: temperatura } : {}),
          });
          return { r, latenciaMs: performance.now() - t0 };
        })(),
      ]);
      out.A.push({ texto: ra.texto, fin: ra.fin, latenciaMs: ra.latenciaMs });
      const inf = rb.r.report;
      out.B.push({
        texto: rb.r.text ?? "",
        fin: rb.r.finishReason ?? null,
        latenciaMs: rb.latenciaMs,
        informe: {
          calls: inf.calls,
          tokens: inf.tokens,
          cache: inf.cache,
          routing: inf.routing,
          cost: inf.cost,
          ...(inf.qualityStatus ? { qualityStatus: inf.qualityStatus } : {}),
          latencyMs: inf.latencyMs,
          etapas: (inf.traces ?? []).map((t) => `${t.stage}:${t.outcome}`),
        },
      });
      histA.push({ role: "assistant", content: ra.texto });
      histB.push({ role: "assistant", content: rb.r.text ?? "" });
    }
  } catch (e) {
    out.error = tapar(String((e as Error)?.message ?? e));
    if (e instanceof PresupuestoAgotado) throw Object.assign(e, { parcial: out });
  } finally {
    capa.close();
  }
  return out;
}

// ── El juez ─────────────────────────────────────────────────────────────────

interface JuicioDeTurno {
  turno: 1 | 2;
  prompt: string;
  partida1: Ganador | "idéntica";
  partida2: Ganador | "idéntica";
  ganador: "A" | "B" | "empate" | "error";
  inconsistente: boolean;
  identicas: boolean;
  /** Una de sus partidas no cupo en el tope del juez: el turno queda sin juzgar (no es un error de lectura). */
  sinPresupuesto?: boolean;
  /** Partidas que salieron de verdad hacia el juez (0-2). */
  partidas?: number;
}

async function juzgarPregunta(
  r: ResultadoDePregunta,
  p: Pregunta,
  ds: Dataset,
  cred: Credenciales,
  tope: Tope,
  precioJuez: Precio,
  base: typeof fetch,
): Promise<JuicioDeTurno[]> {
  const convA: ConversacionDeDosTurnos = { preguntas: p.turnos, respuestas: [r.A[0]!.texto, r.A[1]!.texto] };
  const convB: ConversacionDeDosTurnos = { preguntas: p.turnos, respuestas: [r.B[0]!.texto, r.B[1]!.texto] };
  const ref = CATEGORIAS_CON_REFERENCIA.includes(p.categoria) ? ds.referencias.get(p.id) : undefined;
  const registro: LlamadaMedida[] = [];
  const ctx: ContextoDeTransporte = { familia: "openai", precio: precioJuez, tope, maxSalida: 2048, brazo: "A", turno: 1, registro, base };
  const f = fetchMedido(ctx);
  const partida = async (sys: string, user: string): Promise<Ganador | "sin presupuesto"> => {
    let res: Response;
    try {
      res = await enviar(sys, user);
    } catch (e) {
      // El tope del juez se comprueba POR LLAMADA: si esta no cabe, el turno se
      // queda sin juzgar y los demás que ya salieron siguen su curso.
      if (e instanceof PresupuestoAgotado) return "sin presupuesto";
      throw e;
    }
    if (!res.ok) return "error";
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return leerVeredicto(j.choices?.[0]?.message?.content ?? "");
  };
  const enviar = (sys: string, user: string): Promise<Response> =>
    f(`${cred.juez.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cred.juez.clave ?? ""}` },
      // FastChat: temperature 0, max_tokens 2048.
      body: JSON.stringify({ model: cred.juez.modelo, temperature: 0, max_tokens: 2048, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
  const turnos = await Promise.all(
    ([1, 2] as const).map(async (turno): Promise<JuicioDeTurno> => {
      const identicas = turno === 1 ? convA.respuestas[0] === convB.respuestas[0] : convA.respuestas.every((t, i) => t === convB.respuestas[i]);
      const p1 = promptDelJuez(ds.prompts, turno, convA, convB, ref);
      if (identicas) {
        return { turno, prompt: p1.nombre, partida1: "idéntica", partida2: "idéntica", ganador: "empate", inconsistente: false, identicas: true, partidas: 0 };
      }
      const p2 = promptDelJuez(ds.prompts, turno, convB, convA, ref);
      const [r1, r2] = await Promise.all([partida(p1.system, p1.user), partida(p2.system, p2.user)]);
      const sinPresupuesto = r1 === "sin presupuesto" || r2 === "sin presupuesto";
      const g1: Ganador = r1 === "sin presupuesto" ? "error" : r1;
      const g2: Ganador = r2 === "sin presupuesto" ? "error" : r2;
      const c = combinarPartidas(g1, g2);
      return { turno, prompt: p1.nombre, partida1: g1, partida2: g2, ganador: c.ganador, inconsistente: c.inconsistente, identicas: false, partidas: [r1, r2].filter((r) => r !== "sin presupuesto").length, ...(sinPresupuesto ? { sinPresupuesto: true } : {}) };
    }),
  );
  return turnos;
}

/**
 * Juzga las preguntas completas que aún no tienen juicio, en el orden
 * estratificado (cualquier prefijo está equilibrado), hasta que el tope del juez
 * no deja salir una partida. El tope es POR LLAMADA (cada partida reserva su
 * peor caso); no hay una comprobación previa por pregunta que tire presupuesto.
 */
async function juzgarHastaElTope(
  resultados: ResultadoDePregunta[],
  juicios: Map<number, JuicioDeTurno[]>,
  ds: Dataset,
  cred: Credenciales,
  topeJuez: Tope,
  precioJuez: Precio,
  base: typeof fetch,
): Promise<{ llamadas: number; corte: boolean }> {
  let llamadas = 0;
  for (const r of resultados) {
    if (juicios.has(r.id) || r.error || r.A.length !== 2 || r.B.length !== 2) continue;
    const p = ds.preguntas.find((q) => q.id === r.id)!;
    const j = await juzgarPregunta(r, p, ds, cred, topeJuez, precioJuez, base);
    llamadas += j.reduce((s, x) => s + (x.partidas ?? 0), 0);
    if (j.some((x) => x.sinPresupuesto)) {
      // Se guardan los turnos que sí se juzgaron; el resto queda fuera.
      if (j.some((x) => !x.sinPresupuesto)) juicios.set(r.id, j);
      return { llamadas, corte: true };
    }
    juicios.set(r.id, j);
  }
  return { llamadas, corte: false };
}

// ── Pool con concurrencia acotada ───────────────────────────────────────────

async function enPool<T, R>(items: T[], n: number, f: (x: T) => Promise<R | "parar">): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  let parar = false;
  const trabajador = async () => {
    while (!parar && i < items.length) {
      const x = items[i++]!;
      const r = await f(x);
      if (r === "parar") parar = true;
      else out.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, trabajador));
  return out;
}

// ── Resumen por modelo ──────────────────────────────────────────────────────

function ci(c: CI | null, pct = true): string {
  if (!c) return "—";
  const f = (x: number) => (pct ? `${(x * 100).toFixed(1)} %` : x.toFixed(3));
  return `${f(c.point)} [${f(c.lower)}, ${f(c.upper)}]`;
}

interface ResumenDeModelo {
  modelo: string;
  idCualificado: string;
  familia: Familia;
  maxSalida: number;
  temperatura: string;
  precio: Precio | null;
  precioConocido: boolean;
  preguntas: { planificadas: number; completas: number; conError: number; porCategoria: Record<string, number>; cortePorPresupuesto: boolean; motivoDelCorte?: string };
  gasto: { generacionA: number; generacionB: number; total: number; tope: number; excesosDeReserva: number; juez: number; topeJuez: number };
  coste: {
    A: number;
    B: number;
    ahorroPooled: CI | null;
    ahorroEstratificadoPorCategoria: CI | null;
    /** Lo que se puede afirmar con el IC95 estratificado. */
    clase: ClaseDelAhorro;
    /** ¿Se le puede atribuir a la capa? (ver `atribucionDelAhorro`). */
    atribucion: Atribucion;
    /**
     * Control A/A: el turno 1 de las preguntas cuyo cuerpo salió IDÉNTICO en A y
     * B. Ahí la capa no cambió nada, así que su «ahorro» mide solo el ruido de
     * muestreo de este banco con este modelo.
     */
    controlAA: { preguntas: number; ahorro: CI | null; clase: ClaseDelAhorro };
    deltaMedioPorPreguntaUsd: CI | null;
    wilcoxonP: number | null;
  };
  tokens: { A: UsoMedido; B: UsoMedido };
  cacheDePrefijo: {
    llamadasConLecturaA: number;
    llamadasConLecturaB: number;
    llamadasConEscrituraA: number;
    llamadasConEscrituraB: number;
    llamadas: number;
    /** Llamadas cuyo cuerpo llevaba alguna marca `cache_control` (lo que se pidió, no lo que se escribió). */
    llamadasConMarcaA: number;
    llamadasConMarcaB: number;
    /**
     * Lo que costó la PRIMA de escritura (la parte por encima del precio normal
     * de entrada) en cada brazo. Sin lecturas que la amorticen, es el
     * sobrecoste directo de haber marcado.
     */
    primaDeEscrituraUsdA: number;
    primaDeEscrituraUsdB: number;
    /** Lo que se ahorraron las lecturas frente a pagar esos tokens a precio normal. */
    ahorroPorLecturasUsdA: number;
    ahorroPorLecturasUsdB: number;
  };
  latencia: { A: { p50: number | null; p95: number | null }; B: { p50: number | null; p95: number | null }; deltaMedioMs: CI | null; llamadasSinReintento: number };
  truncadas: { A: number; B: number };
  cable: { turnos: number; identicos: number; diferencias: Record<string, number>; modelosServidosB: string[]; modelosServidosA: string[] };
  capa: {
    basis: Record<string, number>;
    /** Σ (baselineEstimate − actual) de los informes de la capa, en dólares. */
    ahorroDeclaradoUsd: number;
    turnosConAhorroDeclaradoDistintoDe0: number;
    ahorroDeclaradoPorBasis: Record<string, number>;
    costeDeclaradoUsd: number;
    costeMedidoB: number;
    tokensQueNoCuadran: number;
    cacheResult: Record<string, number>;
    executionClass: Record<string, number>;
    llamadasExtraAlProveedor: number;
    etapas: Record<string, number>;
  };
  calidad: {
    juzgada: boolean;
    turnosJuzgados: number;
    victoriasB: number;
    victoriasA: number;
    empates: number;
    inconsistentes: number;
    identicas: number;
    errores: number;
    /** Turnos que se quedaron sin juzgar porque una partida no cupo en el tope del juez. */
    turnosSinPresupuesto: number;
    tasaDeVictoriaB: CI | null;
    porCategoria: Record<string, { n: number; B: number; A: number; empate: number }>;
    llamadasAlJuez: number;
    preguntasJuzgadas: number;
    cortePorPresupuesto: boolean;
  };
  respuestasIdenticasPorTurno: number;
  errores: string[];
}

function contar(xs: string[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const x of xs) r[x] = (r[x] ?? 0) + 1;
  return r;
}

function resumir(
  m: ModeloDeLaBateria,
  precio: Precio | null,
  planificadas: number,
  resultados: ResultadoDePregunta[],
  tope: Tope,
  corte: string | undefined,
  juicios: Map<number, JuicioDeTurno[]>,
  topeJuez: Tope | null,
  llamadasJuez: number,
  corteJuez: boolean,
): ResumenDeModelo {
  const completas = resultados.filter((r) => !r.error && r.A.length === 2 && r.B.length === 2);
  const llamadas = completas.flatMap((r) => r.llamadas);
  const todas = resultados.flatMap((r) => r.llamadas);
  const costeDe = (r: ResultadoDePregunta, b: Brazo) => r.llamadas.filter((l) => l.brazo === b).reduce((s, l) => s + l.coste, 0);
  const cA = completas.map((r) => costeDe(r, "A"));
  const cB = completas.map((r) => costeDe(r, "B"));
  const estratos = CATEGORIAS.map((c) => {
    const rs = completas.filter((r) => r.categoria === c);
    return { costA: rs.map((r) => costeDe(r, "A")), costB: rs.map((r) => costeDe(r, "B")) };
  });
  const deltas = cA.map((a, i) => a - cB[i]!);
  const uso = (b: Brazo) => sumarUsos(llamadas.filter((l) => l.brazo === b && l.uso).map((l) => l.uso!));
  const lat = (b: Brazo) => llamadas.filter((l) => l.brazo === b && l.reintentos === 0).map((l) => l.latenciaMs);
  const latTurno = (b: Brazo) => completas.flatMap((r) => r[b].map((t) => t.latenciaMs));
  const latA = latTurno("A");
  const latB = latTurno("B");
  const ahorroEstratificado = completas.length ? bootstrapRatioCIEstratificado(estratos, { seed: SEMILLA_DE_MUESTRA }) : null;

  // El cable: la PRIMERA llamada de cada brazo en cada turno (la que responde).
  let turnos = 0;
  let identicos = 0;
  const difs: string[] = [];
  for (const r of completas) {
    for (const t of [1, 2] as const) {
      const a = r.llamadas.find((l) => l.brazo === "A" && l.turno === t);
      const b = r.llamadas.find((l) => l.brazo === "B" && l.turno === t);
      if (!a || !b) continue;
      turnos++;
      // Turno 2: la historia de A lleva SU respuesta; se compara con la de B puesta en su sitio.
      const d = diferenciasDeCuerpo(t === 2 ? conRespuestasDe(a.cuerpo, [r.B[0]!.texto]) : a.cuerpo, b.cuerpo);
      if (d.length === 0) identicos++;
      difs.push(...d);
    }
  }
  const informes = completas.flatMap((r) => r.B.map((t) => t.informe).filter((x): x is NonNullable<typeof x> => !!x));
  const ahorroPorBasis: Record<string, number> = {};
  // OJO: `cost.netSavings` de la capa es una RAZÓN (1 − actual/baseline), no
  // dólares. El ahorro declarado en dólares es baseline − actual, turno a turno.
  const ahorroUsd = (i: (typeof informes)[number]) => i.cost.baselineEstimate - i.cost.actual;
  for (const i of informes) ahorroPorBasis[i.cost.basis] = (ahorroPorBasis[i.cost.basis] ?? 0) + ahorroUsd(i);
  // ¿Cuadran los tokens que la capa dice haber mandado con los que el proveedor facturó?
  let noCuadran = 0;
  for (const r of completas) {
    for (const t of [1, 2] as const) {
      const inf = r.B[t - 1]?.informe;
      const ls = r.llamadas.filter((l) => l.brazo === "B" && l.turno === t && l.uso);
      if (!inf || ls.length === 0) continue;
      const u = sumarUsos(ls.map((l) => l.uso!));
      const entrada = u.entrada + u.cacheLeida + u.cacheEscrita;
      if (inf.tokens.actualInput !== entrada || inf.tokens.actualOutput !== u.salida) noCuadran++;
    }
  }
  const llamadasB = llamadas.filter((l) => l.brazo === "B").length;

  // Control A/A: turno 1 con cuerpo idéntico en los dos brazos.
  const aaA: number[] = [];
  const aaB: number[] = [];
  for (const r of completas) {
    const a = r.llamadas.filter((l) => l.brazo === "A" && l.turno === 1);
    const b = r.llamadas.filter((l) => l.brazo === "B" && l.turno === 1);
    if (a.length !== 1 || b.length !== 1 || diferenciasDeCuerpo(a[0]!.cuerpo, b[0]!.cuerpo).length) continue;
    aaA.push(a[0]!.coste);
    aaB.push(b[0]!.coste);
  }
  const aaCI = aaA.length ? bootstrapRatioCI(aaA, aaB, { seed: SEMILLA_DE_MUESTRA }) : null;
  const lecturasA = llamadas.filter((l) => l.brazo === "A" && (l.uso?.cacheLeida ?? 0) > 0).length;
  const lecturasB = llamadas.filter((l) => l.brazo === "B" && (l.uso?.cacheLeida ?? 0) > 0).length;

  // Calidad.
  const js = completas.flatMap((r) => (juicios.get(r.id) ?? []).map((j) => ({ ...j, categoria: r.categoria, id: r.id })));
  const validos = js.filter((j) => j.ganador !== "error");
  const porPregunta = new Map<number, number[]>();
  for (const j of validos) {
    const arr = porPregunta.get(j.id) ?? [];
    arr.push(puntuacionDeB(j.ganador as "A" | "B" | "empate"));
    porPregunta.set(j.id, arr);
  }
  const medias = [...porPregunta.values()].map((xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
  const porCat: Record<string, { n: number; B: number; A: number; empate: number }> = {};
  for (const j of validos) {
    const c = (porCat[j.categoria] ??= { n: 0, B: 0, A: 0, empate: 0 });
    c.n++;
    if (j.ganador === "B") c.B++;
    else if (j.ganador === "A") c.A++;
    else c.empate++;
  }

  return {
    modelo: m.id,
    idCualificado: idCualificado(m),
    familia: m.familia,
    maxSalida: m.maxSalida,
    temperatura: m.temperatura ? "FastChat por categoría (igual en A y B)" : "no se envía (modelo de razonamiento), en ningún brazo",
    precio,
    precioConocido: precio !== null,
    preguntas: {
      planificadas,
      completas: completas.length,
      conError: resultados.length - completas.length,
      porCategoria: contar(completas.map((r) => r.categoria)),
      cortePorPresupuesto: corte !== undefined,
      ...(corte ? { motivoDelCorte: corte } : {}),
    },
    gasto: {
      generacionA: todas.filter((l) => l.brazo === "A").reduce((s, l) => s + l.coste, 0),
      generacionB: todas.filter((l) => l.brazo === "B").reduce((s, l) => s + l.coste, 0),
      total: tope.gastado,
      tope: tope.limiteUsd,
      excesosDeReserva: tope.excesos,
      juez: topeJuez?.gastado ?? 0,
      topeJuez: topeJuez?.limiteUsd ?? 0,
    },
    coste: {
      A: cA.reduce((s, x) => s + x, 0),
      B: cB.reduce((s, x) => s + x, 0),
      ahorroPooled: completas.length ? bootstrapRatioCI(cA, cB, { seed: SEMILLA_DE_MUESTRA }) : null,
      ahorroEstratificadoPorCategoria: ahorroEstratificado,
      clase: claseDelAhorro(ahorroEstratificado, completas.length),
      atribucion: atribucionDelAhorro({
        clase: claseDelAhorro(ahorroEstratificado, completas.length),
        diferenciasDelCable: contar(difs),
        lecturasDeCacheA: lecturasA,
        lecturasDeCacheB: lecturasB,
        ahorroDeclaradoUsd: informes.reduce((s, i) => s + ahorroUsd(i), 0),
        tokensEscritosEnCacheB: uso("B").cacheEscrita,
      }),
      controlAA: { preguntas: aaA.length, ahorro: aaCI, clase: claseDelAhorro(aaCI, aaA.length) },
      deltaMedioPorPreguntaUsd: completas.length ? bootstrapMeanCI(deltas, { seed: SEMILLA_DE_MUESTRA }) : null,
      wilcoxonP: deltas.length >= 2 ? wilcoxonSignedRankP(deltas) : null,
    },
    tokens: { A: uso("A"), B: uso("B") },
    cacheDePrefijo: {
      llamadas: llamadas.length,
      llamadasConLecturaA: llamadas.filter((l) => l.brazo === "A" && (l.uso?.cacheLeida ?? 0) > 0).length,
      llamadasConLecturaB: llamadas.filter((l) => l.brazo === "B" && (l.uso?.cacheLeida ?? 0) > 0).length,
      llamadasConEscrituraA: llamadas.filter((l) => l.brazo === "A" && (l.uso?.cacheEscrita ?? 0) > 0).length,
      llamadasConEscrituraB: llamadas.filter((l) => l.brazo === "B" && (l.uso?.cacheEscrita ?? 0) > 0).length,
      llamadasConMarcaA: llamadas.filter((l) => l.brazo === "A" && JSON.stringify(l.cuerpo).includes('"cache_control"')).length,
      llamadasConMarcaB: llamadas.filter((l) => l.brazo === "B" && JSON.stringify(l.cuerpo).includes('"cache_control"')).length,
      primaDeEscrituraUsdA: precio ? (uso("A").cacheEscrita / 1000) * precio.inputPer1k * (primaDeEscritura(m.familia) - 1) : 0,
      primaDeEscrituraUsdB: precio ? (uso("B").cacheEscrita / 1000) * precio.inputPer1k * (primaDeEscritura(m.familia) - 1) : 0,
      ahorroPorLecturasUsdA: precio ? (uso("A").cacheLeida / 1000) * (precio.inputPer1k - (precio.cachedInputPer1k ?? precio.inputPer1k)) : 0,
      ahorroPorLecturasUsdB: precio ? (uso("B").cacheLeida / 1000) * (precio.inputPer1k - (precio.cachedInputPer1k ?? precio.inputPer1k)) : 0,
    },
    latencia: {
      A: { p50: percentil(latA, 0.5), p95: percentil(latA, 0.95) },
      B: { p50: percentil(latB, 0.5), p95: percentil(latB, 0.95) },
      deltaMedioMs: latA.length ? bootstrapMeanCI(latB.map((b, i) => b - latA[i]!), { seed: SEMILLA_DE_MUESTRA }) : null,
      llamadasSinReintento: lat("A").length + lat("B").length,
    },
    truncadas: {
      A: completas.flatMap((r) => r.A).filter((t) => t.fin === "max_tokens" || t.fin === "length").length,
      B: completas.flatMap((r) => r.B).filter((t) => t.fin === "max_tokens" || t.fin === "length").length,
    },
    cable: {
      turnos,
      identicos,
      diferencias: contar(difs),
      modelosServidosA: [...new Set(llamadas.filter((l) => l.brazo === "A").map((l) => l.modeloServido ?? "?"))],
      modelosServidosB: [...new Set(llamadas.filter((l) => l.brazo === "B").map((l) => l.modeloServido ?? "?"))],
    },
    capa: {
      basis: contar(informes.map((i) => i.cost.basis)),
      ahorroDeclaradoUsd: informes.reduce((s, i) => s + ahorroUsd(i), 0),
      turnosConAhorroDeclaradoDistintoDe0: informes.filter((i) => Math.abs(i.cost.netSavings) >= 1e-9).length,
      ahorroDeclaradoPorBasis: ahorroPorBasis,
      costeDeclaradoUsd: informes.reduce((s, i) => s + i.cost.actual, 0),
      costeMedidoB: cB.reduce((s, x) => s + x, 0),
      tokensQueNoCuadran: noCuadran,
      cacheResult: contar(informes.map((i) => i.cache.result)),
      executionClass: contar(informes.map((i) => i.routing.executionClass)),
      llamadasExtraAlProveedor: llamadasB - 2 * completas.length,
      etapas: contar(informes.flatMap((i) => i.etapas)),
    },
    calidad: {
      juzgada: topeJuez !== null,
      turnosJuzgados: validos.length,
      victoriasB: validos.filter((j) => j.ganador === "B").length,
      victoriasA: validos.filter((j) => j.ganador === "A").length,
      empates: validos.filter((j) => j.ganador === "empate").length,
      inconsistentes: validos.filter((j) => j.inconsistente).length,
      identicas: validos.filter((j) => j.identicas).length,
      errores: js.filter((j) => j.ganador === "error" && !j.sinPresupuesto).length,
      turnosSinPresupuesto: js.filter((j) => j.sinPresupuesto).length,
      tasaDeVictoriaB: medias.length ? bootstrapMeanCI(medias, { seed: SEMILLA_DE_MUESTRA }) : null,
      porCategoria: porCat,
      llamadasAlJuez: llamadasJuez,
      preguntasJuzgadas: porPregunta.size,
      cortePorPresupuesto: corteJuez,
    },
    respuestasIdenticasPorTurno: completas.reduce((s, r) => s + [0, 1].filter((i) => r.A[i]!.texto === r.B[i]!.texto).length, 0),
    errores: [...new Set(resultados.map((r) => r.error).filter((e): e is string => !!e).concat(todas.filter((l) => l.error).map((l) => `${l.brazo} t${l.turno} HTTP ${l.status}: ${l.error}`)))].slice(0, 20),
  };
}

// ── Informe Markdown ────────────────────────────────────────────────────────

function markdown(inf: InformeCompleto): string {
  const L: string[] = [];
  const usd = (x: number) => fmtUsd(x);
  L.push(`# MT-Bench A/B — capa ${PAQUETE.nombre} ${inf.paquete.version} (${FECHA})`);
  L.push("");
  if (inf.modo !== "LIVE") {
    L.push(`> **${inf.modo}: NINGUNA cifra de este fichero es una medida.** El brazo B es ${inf.brazoB}. Solo valida el arnés.`);
    L.push("");
  }
  L.push(`- **Modo:** ${inf.modo}. **Brazo A:** llamada directa al API del proveedor. **Brazo B:** ${inf.brazoB}.`);
  L.push(`- **Paquete:** \`${PAQUETE.nombre}@${inf.paquete.version}\` — ${inf.paquete.origen}; integrity \`${inf.paquete.integrity}\`.`);
  const v = inf.verificacionDelFuente;
  if (v) {
    L.push(
      `- **Verificación del fuente:** etiqueta \`${v.etiqueta}\` = commit \`${v.commit}\` (fetch de etiquetas: ${v.fetchDeEtiquetas}). Árbol cargado: \`${v.arbolCargado}\`; ${v.ficherosVerificados} ficheros de \`src/\` + \`packages/\` comparados blob a blob con la etiqueta → diferencias: ${v.diffDelArbolCargado.length ? v.diffDelArbolCargado.join(", ") : "**ninguna**"}. \`pnpm build\` de ese árbol → \`dist/index.js\` sha256 \`${v.build.sha256DistIndex}\`; tarball de npm (\`npm pack\`, integrity comprobada) → \`${v.npm.sha256DistIndex}\`: **${v.distIdentico ? "idénticos" : "DISTINTOS"}**. Versión cargada: ${v.versionCargada}.` +
        (v.diffDelRepo.length
          ? ` Nota: el árbol de trabajo del repo (main) ya difiere de la etiqueta en ${v.diffDelRepo.map((d) => `\`${d}\``).join(", ")} (commits posteriores a la release); por eso se carga la etiqueta extraída y no \`src/\` del repo.`
          : ""),
    );
  }
  L.push(`- **Dataset:** ${inf.dataset.origen} — \`${DATASET.repo}@${DATASET.commit}\` (${DATASET.license}); sha256 verificados: question.jsonl \`${DATASET.ficheros.preguntas.sha256.slice(0, 16)}…\`, reference_answer/gpt-4.jsonl \`${DATASET.ficheros.referencias.sha256.slice(0, 16)}…\`, judge_prompts.jsonl \`${DATASET.ficheros.promptsDelJuez.sha256.slice(0, 16)}…\`. No se versiona: se descarga y se comprueba en cada tirada.`);
  L.push(`- **Subconjunto:** orden estratificado por categoría con semilla ${SEMILLA_DE_MUESTRA}; cualquier prefijo queda equilibrado (±1 por categoría). Se corta cuando el peor coste de la siguiente pregunta ya no cabe en el tope.`);
  L.push(`- **Juez:** \`${inf.juez.modelo}\` por pasarela, prompts de pares de FastChat (\`pair-v2\`, \`pair-v2-multi-turn\`, y \`pair-math-v1*\` con referencia en math/reasoning/coding), posiciones intercambiadas; si las dos partidas discrepan, empate. Turnos con respuestas byte-idénticas en A y B = empate sin juez (declarado aparte).`);
  L.push(`- **Topes duros (en código):** ${usd(inf.topes.porFamiliaUsd.openai)} por modelo de OpenAI y ${usd(inf.topes.porFamiliaUsd.anthropic)} por modelo de Anthropic (A+B), ${usd(inf.topes.juezTotalUsd)} de juez en total. Cada llamada reserva su peor caso antes de salir.`);
  L.push(`- **Gasto real total:** generación ${usd(inf.gastoTotal.generacion)} + juez ${usd(inf.gastoTotal.juez)} = **${usd(inf.gastoTotal.generacion + inf.gastoTotal.juez)}**.`);
  const libroTotal = (x: Record<string, number>) => Object.values(x).reduce((s, v) => s + v, 0);
  L.push(`- **Gasto acumulado de la batería** (libro de gasto LIVE de la 0.4.31: todas las tiradas, incluida la de humo de 1 pregunta y la recarga que completa el juicio): generación ${Object.entries(inf.gastoAcumuladoEntreTiradas.generacion).map(([k, v]) => `${k} ${usd(v)}`).join(", ")} = ${usd(libroTotal(inf.gastoAcumuladoEntreTiradas.generacion))}; juez ${usd(libroTotal(inf.gastoAcumuladoEntreTiradas.juez))} de ${usd(inf.topes.juezTotalUsd)}.`);
  L.push(`- **Hosts vistos** (guarda de \`fetch\`; solo se permiten ${inf.hosts.permitidos.map((h) => `\`${h}\``).join(", ")}): ${Object.entries(inf.hosts.vistos).map(([h, n]) => `\`${h}\` ×${n}`).join(", ") || "ninguno"}. Bloqueados: ${Object.entries(inf.hosts.bloqueados).map(([h, n]) => `\`${h}\` ×${n}`).join(", ") || "**ninguno**"}.`);
  if (inf.modelosFallidos.length) L.push(`- **No medidos:** ${inf.modelosFallidos.map((f) => `\`${f.modelo}\` — ${f.error}`).join("; ")}.`);
  L.push("");
  L.push("## Tabla por modelo");
  L.push("");
  L.push("| modelo | preguntas | coste A | coste B | ahorro B vs A (IC95 estratificado) | clase del ahorro | ¿atribuible a la capa? | control A/A: turno 1 con cuerpo idéntico (IC95) | caché de prefijo leída A/B (llamadas) | p50 A / B (ms) | p95 A / B (ms) | B gana / A gana / empate (turnos) | tasa de victoria B (IC95) | gasto real (gen + juez) |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of inf.modelos) {
    const lat = (x: number | null) => (x === null ? "—" : Math.round(x).toString());
    L.push(
      `| \`${r.modelo}\` | ${r.preguntas.completas}/${r.preguntas.planificadas}${r.preguntas.cortePorPresupuesto ? " ✂" : ""} | ${usd(r.coste.A)} | ${usd(r.coste.B)} | ${ci(r.coste.ahorroEstratificadoPorCategoria)} | ${r.coste.clase} | ${r.coste.atribucion.atribuible === null ? "—" : r.coste.atribucion.atribuible ? "posible" : "**no**"} | ${ci(r.coste.controlAA.ahorro)} (n=${r.coste.controlAA.preguntas}, ${r.coste.controlAA.clase}) | ${r.cacheDePrefijo.llamadasConLecturaA}/${r.cacheDePrefijo.llamadasConLecturaB} de ${r.cacheDePrefijo.llamadas / 2} | ${lat(r.latencia.A.p50)} / ${lat(r.latencia.B.p50)} | ${lat(r.latencia.A.p95)} / ${lat(r.latencia.B.p95)} | ${r.calidad.victoriasB} / ${r.calidad.victoriasA} / ${r.calidad.empates} | ${ci(r.calidad.tasaDeVictoriaB)} | ${usd(r.gasto.total)} + ${usd(r.gasto.juez)} |`,
    );
  }
  for (const f of inf.modelosFallidos) L.push(`| \`${f.modelo}\` | — | — | — | — | — | — | — | — | — | — | — | — | 0 $ — ${f.error} |`);
  L.push("");
  L.push("✂ = subconjunto por presupuesto. La tasa de victoria de B cuenta el empate como ½: 50 % = sin diferencia. «Clase del ahorro»: *ahorro* solo si el IC95 entero está por encima de 0, *sobrecoste* si está entero por debajo; si contiene el 0, *indistinguible de 0*. «¿Atribuible?»: *no* cuando el cable de B solo difiere del de A en campos sin efecto directo en coste (\`prompt_cache_key\`, o marcas \`cache_control\` que el proveedor ignoró porque no escribieron ni leyeron un token), B no leyó de caché más que A y la capa declara 0 $: la diferencia es muestreo de la salida. El control A/A mide ese ruido donde la capa no tocó nada.");
  L.push("");
  L.push("## Qué es medido y qué es modelado");
  L.push("");
  L.push("- **Medido:** tokens de ambos brazos (el `usage` de la respuesta del proveedor, leído por el mismo transporte), latencia de pared por turno (el brazo B incluye el preproceso de la capa), aciertos/escrituras de caché de prefijo (`cache_read_input_tokens` / `cached_tokens`), el cuerpo exacto que cada brazo mandó, y el informe que la capa devolvió.");
  L.push("- **Modelado:** el dinero = tokens medidos × precio de lista del catálogo del propio paquete (`CATALOGO`), con la escritura de caché de Anthropic a 1,25×. No es la factura.");
  L.push("- **Juicio:** la calidad es la opinión de un juez LLM (gpt-4o), no una verdad de referencia; en math/reasoning/coding el juez ve la respuesta de referencia de GPT-4 de FastChat.");
  L.push("- **Intervalos:** bootstrap percentil con semilla (10 000 remuestreos): el ahorro, estratificado por categoría (cada categoría pesa igual) y también agrupado; la tasa de victoria, sobre la media por pregunta.");
  L.push("");
  for (const r of inf.modelos) {
    L.push(`## \`${r.modelo}\``);
    L.push("");
    L.push(`- Preguntas: ${r.preguntas.completas} completas de ${r.preguntas.planificadas} planificadas (${Object.entries(r.preguntas.porCategoria).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}).${r.preguntas.motivoDelCorte ? ` Corte: ${r.preguntas.motivoDelCorte}.` : ""}`);
    L.push(`- Tope de salida por llamada: ${r.maxSalida} (igual en A y B; en B, el \`maxOutputTokens\` nativo de la capa). Temperatura: ${r.temperatura}. Precio: ${r.precio ? `${r.precio.inputPer1k}/${r.precio.outputPer1k} $ por 1k (cacheada ${r.precio.cachedInputPer1k ?? "—"})` : "SIN FILA EN EL CATÁLOGO"}.`);
    L.push(`- Coste A ${usd(r.coste.A)} · B ${usd(r.coste.B)} · ahorro agrupado ${ci(r.coste.ahorroPooled)} · estratificado ${ci(r.coste.ahorroEstratificadoPorCategoria)} (**${r.coste.clase}**) · Δ medio por pregunta ${r.coste.deltaMedioPorPreguntaUsd ? `${(r.coste.deltaMedioPorPreguntaUsd.point * 1e6).toFixed(1)} µ$ [${(r.coste.deltaMedioPorPreguntaUsd.lower * 1e6).toFixed(1)}, ${(r.coste.deltaMedioPorPreguntaUsd.upper * 1e6).toFixed(1)}]` : "—"} · Wilcoxon p ${r.coste.wilcoxonP?.toFixed(3) ?? "—"}.`);
    L.push(`- Tokens A: entrada ${r.tokens.A.entrada}, caché leída ${r.tokens.A.cacheLeida}, escrita ${r.tokens.A.cacheEscrita}, salida ${r.tokens.A.salida} (razonamiento ${r.tokens.A.razonamiento}). B: ${r.tokens.B.entrada} / ${r.tokens.B.cacheLeida} / ${r.tokens.B.cacheEscrita} / ${r.tokens.B.salida} (${r.tokens.B.razonamiento}).`);
    {
      const c = r.cacheDePrefijo;
      L.push(
        `- Caché de prefijo: cuerpos con \`cache_control\` A ${c.llamadasConMarcaA ?? 0} / B ${c.llamadasConMarcaB ?? 0} de ${c.llamadas / 2} llamadas por brazo; llamadas que ESCRIBIERON A ${c.llamadasConEscrituraA} / B ${c.llamadasConEscrituraB} (tokens ${r.tokens.A.cacheEscrita} / ${r.tokens.B.cacheEscrita}); que LEYERON A ${c.llamadasConLecturaA} / B ${c.llamadasConLecturaB} (tokens ${r.tokens.A.cacheLeida} / ${r.tokens.B.cacheLeida}). Prima de escritura pagada A ${usd(c.primaDeEscrituraUsdA ?? 0)} / B ${usd(c.primaDeEscrituraUsdB ?? 0)}; ahorro por lecturas A ${usd(c.ahorroPorLecturasUsdA ?? 0)} / B ${usd(c.ahorroPorLecturasUsdB ?? 0)}; neto de la caché en B ${usd((c.ahorroPorLecturasUsdB ?? 0) - (c.primaDeEscrituraUsdB ?? 0))} (${r.coste.B > 0 ? (((c.ahorroPorLecturasUsdB ?? 0) - (c.primaDeEscrituraUsdB ?? 0)) / r.coste.B * 100).toFixed(2) : "—"} % del coste de B).`,
      );
    }
    L.push(`- Atribución: ${r.coste.atribucion.motivo}. Control A/A (turno 1, cuerpo idéntico en ${r.coste.controlAA.preguntas} preguntas): «ahorro» ${ci(r.coste.controlAA.ahorro)} → ${r.coste.controlAA.clase}.`);
    L.push(`- Truncadas por el tope: A ${r.truncadas.A}, B ${r.truncadas.B}. Respuestas byte-idénticas A=B: ${r.respuestasIdenticasPorTurno} turnos.`);
    L.push(`- Cable: ${r.cable.identicos}/${r.cable.turnos} turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: ${Object.entries(r.cable.diferencias).map(([k, v]) => `\`${k}\` ×${v}`).join(", ") || "ninguno"}. Modelo servido A: ${r.cable.modelosServidosA.join(", ")}; B: ${r.cable.modelosServidosB.join(", ")}.`);
    L.push(`- Lo que dice la capa: basis ${JSON.stringify(r.capa.basis)}, ahorro declarado (Σ baseline − actual) ${usd(r.capa.ahorroDeclaradoUsd)} en ${r.capa.turnosConAhorroDeclaradoDistintoDe0 ?? "?"} turnos distintos de 0 (${JSON.stringify(Object.fromEntries(Object.entries(r.capa.ahorroDeclaradoPorBasis).map(([k, v]) => [k, Number(v.toFixed(6))])))}), coste declarado ${usd(r.capa.costeDeclaradoUsd)} frente a ${usd(r.capa.costeMedidoB)} medido; turnos cuyo conteo de tokens no cuadra con el proveedor: ${r.capa.tokensQueNoCuadran}; llamadas extra al proveedor: ${r.capa.llamadasExtraAlProveedor}; caché ${JSON.stringify(r.capa.cacheResult)}; ruta ${JSON.stringify(r.capa.executionClass)}.`);
    L.push(`- Calidad: ${r.calidad.juzgada ? `${r.calidad.turnosJuzgados} turnos de ${r.calidad.preguntasJuzgadas} preguntas (${r.calidad.llamadasAlJuez} llamadas al juez${r.calidad.cortePorPresupuesto ? ", cortado por el tope del juez" : ""}); B gana ${r.calidad.victoriasB}, A gana ${r.calidad.victoriasA}, empate ${r.calidad.empates} (de ellos ${r.calidad.inconsistentes} por partidas discrepantes y ${r.calidad.identicas} por respuestas idénticas); errores de lectura ${r.calidad.errores}; turnos sin juzgar por el tope ${r.calidad.turnosSinPresupuesto}; tasa de victoria B ${ci(r.calidad.tasaDeVictoriaB)}. Por categoría: ${Object.entries(r.calidad.porCategoria).map(([k, v]) => `${k} ${v.B}/${v.A}/${v.empate}`).join(", ") || "—"}.` : "no juzgada (--sin-juez)."}`);
    L.push(`- Gasto real: A ${usd(r.gasto.generacionA)} + B ${usd(r.gasto.generacionB)} = ${usd(r.gasto.total)} de ${usd(r.gasto.tope)}; juez ${usd(r.gasto.juez)} de ${usd(r.gasto.topeJuez)}. Reservas superadas: ${r.gasto.excesosDeReserva}.`);
    if (r.errores.length) L.push(`- Errores: ${r.errores.map((e) => `\`${e.replace(/`/g, "'").slice(0, 200)}\``).join("; ")}`);
    L.push("");
  }
  L.push("## Limitaciones");
  L.push("");
  for (const l of inf.limitaciones) L.push(`- ${l}`);
  L.push("");
  return L.join("\n");
}

interface InformeCompleto {
  bateria: "mt-bench";
  fecha: string;
  modo: "LIVE" | "MOCK";
  commitDelRepo: string;
  paquete: { nombre: string; version: string; integrity: string; origen: string };
  brazoB: string;
  verificacionDelFuente: VerificacionDelFuente | null;
  dataset: { origen: string; repo: string; commit: string; license: string; ficheros: typeof DATASET.ficheros };
  juez: { modelo: string; topeUsd: number };
  topes: { porFamiliaUsd: Record<Familia, number>; juezTotalUsd: number };
  semilla: number;
  gastoTotal: { generacion: number; juez: number };
  gastoAcumuladoEntreTiradas: LibroDeGasto;
  hosts: { permitidos: readonly string[]; vistos: Record<string, number>; bloqueados: Record<string, number> };
  modelos: ResumenDeModelo[];
  modelosFallidos: { modelo: string; error: string }[];
  limitaciones: string[];
}

/** GET /v1/models de Anthropic: no se factura. Dice si la clave vale antes de gastar un céntimo. */
async function comprobarAnthropic(cred: Credenciales, f: typeof fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await f(`${cred.anthropic.base}/models?limit=1`, {
      method: "GET",
      headers: { "x-api-key": cred.anthropic.clave ?? "", "anthropic-version": "2023-06-01" },
    });
    await res.text().catch(() => "");
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Recargar una tirada LIVE ────────────────────────────────────────────────

interface EstadoPrevio {
  resultados: ResultadoDePregunta[];
  juicios: [number, JuicioDeTurno[]][];
  llamadasJuez: number;
  gastoGeneracion: number;
  excesos: number;
  corte?: string;
  juezPrevio: number;
  corteJuez: boolean;
}

interface PreguntaCruda {
  id: number;
  categoria: Categoria;
  error?: string;
  A: TurnoDeBrazo[];
  B: TurnoDeBrazo[];
  llamadas: LlamadaMedida[];
  juicio: JuicioDeTurno[] | null;
}

function cargarTiradaAnterior(nombre: string, libro: LibroDeGasto): { informe: InformeCompleto; porModelo: Map<string, EstadoPrevio> } {
  const fj = join(DIR_PUBLICADO, `${nombre}.json`);
  const fc = join(DIR_TRABAJO, `${nombre}-respuestas.jsonl`);
  if (!existsSync(fj) || !existsSync(fc)) throw new Error(`--desde-crudo: faltan ${fj} o ${fc}`);
  const informe = JSON.parse(readFileSync(fj, "utf8")) as InformeCompleto;
  if (informe.modo !== "LIVE") throw new Error("--desde-crudo: la tirada anterior no es LIVE");
  const crudo = readFileSync(fc, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { modelo: string; preguntas: PreguntaCruda[] });
  const porModelo = new Map<string, EstadoPrevio>();
  for (const r of informe.modelos) {
    const c = crudo.find((x) => x.modelo === r.modelo);
    if (!c) throw new Error(`--desde-crudo: ${r.modelo} está en el informe pero no en las respuestas crudas`);
    const m = MODELOS_POR_DEFECTO.find((x) => x.id === r.modelo)!;
    porModelo.set(r.modelo, {
      resultados: c.preguntas.map((q) => ({
        id: q.id,
        categoria: q.categoria,
        temperatura: m.temperatura ? TEMPERATURA_FASTCHAT[q.categoria] : null,
        A: q.A,
        B: q.B,
        llamadas: q.llamadas,
        ...(q.error ? { error: q.error } : {}),
      })),
      juicios: c.preguntas.filter((q) => q.juicio).map((q) => [q.id, q.juicio!]),
      llamadasJuez: r.calidad.llamadasAlJuez,
      gastoGeneracion: r.gasto.total,
      excesos: r.gasto.excesosDeReserva,
      ...(r.preguntas.motivoDelCorte ? { corte: r.preguntas.motivoDelCorte } : {}),
      juezPrevio: libro.juez[r.modelo] ?? 0,
      corteJuez: r.calidad.cortePorPresupuesto,
    });
  }
  return { informe, porModelo };
}

// ── Principal ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const op = leerOpciones(process.argv.slice(2));
  const cred = credenciales();

  // La guarda de hosts, ANTES de cualquier red: el `fetch` global (lo que la capa
  // o cualquier dependencia usen por su cuenta) y el de los brazos pasan por ella.
  // En --mock el global no tiene red: cualquier salida real es un fallo.
  const fetchGlobal = globalThis.fetch;
  globalThis.fetch = conGuardaDeHosts(
    op.mock
      ? ((async () => {
          throw new Error("--mock: el fetch global no tiene red");
        }) as unknown as typeof fetch)
      : fetchGlobal,
  );
  const base: typeof fetch = op.mock ? conGuardaDeHosts(fetchFalso(op.mockAnthropic401)) : globalThis.fetch;
  const ds = await cargarDataset(!op.mock);
  const nombre = `mt-bench-${PAQUETE.version.replace(/\./g, "")}${op.sufijo ? `-${op.sufijo}` : ""}${op.mock ? "-mock" : ""}`;
  if (op.desdeCrudo && op.mock) throw new Error("--desde-crudo es para una tirada LIVE");
  const libroInicial: LibroDeGasto = op.mock ? { generacion: {}, juez: {} } : leerLibro(op.sufijo);
  const anterior = op.desdeCrudo ? cargarTiradaAnterior(nombre, libroInicial) : null;
  const desdeCrudo = anterior?.porModelo ?? null;

  let fabrica: FabricaDeCapa;
  let catalogo: Readonly<Record<string, Precio>>;
  let integrity = "—";
  let version: string = PAQUETE.version;
  let origenDelPaquete: string = PAQUETE.origen;
  let verificacion: VerificacionDelFuente | null = null;

  const faltan = op.mock || anterior
    ? [
        ...(anterior && op.juez && !cred.juez.clave ? ["BVSALA_JUDGE_API_KEY"] : []),
      ]
    : [
        !op.fuente && !op.fuenteDeMain && !cred.licencia && "BIVELIO_LICENSE_KEY (el paquete publicado es fail-closed: sin licencia el brazo B no existe; o --fuente)",
        op.modelos.some((m) => m.familia === "anthropic") && !cred.anthropic.clave && "BVSALA_DEMO_ANTHROPIC_API_KEY",
        op.modelos.some((m) => m.familia === "openai") && !cred.openai.clave && "BVSALA_DEMO_API_KEY",
        op.juez && !cred.juez.clave && "BVSALA_JUDGE_API_KEY",
      ].filter(Boolean);
  if (faltan.length) {
    console.error(`MT-Bench LIVE: faltan variables (solo nombres): ${faltan.join(", ")}. No se ha hecho ninguna llamada de pago.`);
    process.exit(2);
  }

  if (anterior) {
    // Nada se genera: el brazo B, el paquete y su verificación son los de la tirada que se recarga.
    fabrica = {
      descripcion: anterior.informe.brazoB,
      crear() {
        throw new Error("--desde-crudo no genera");
      },
    };
    // El catálogo de src/ de este árbol: `git diff v0.4.31 -- src/` solo toca src/version.ts.
    catalogo = (await import("../../../src/pricing/catalogo.js")).CATALOGO as Readonly<Record<string, Precio>>;
    integrity = anterior.informe.paquete.integrity;
    version = anterior.informe.paquete.version;
    origenDelPaquete = anterior.informe.paquete.origen;
    verificacion = anterior.informe.verificacionDelFuente;
    for (const [h, n] of Object.entries(anterior.informe.hosts.vistos)) hostsVistos.set(h, (hostsVistos.get(h) ?? 0) + n);
    for (const [h, n] of Object.entries(anterior.informe.hosts.bloqueados)) hostsBloqueados.set(h, (hostsBloqueados.get(h) ?? 0) + n);
  } else if (op.fuenteDeMain) {
    const mod = await cargarArbol();
    let commitDelArbol = "?";
    try {
      commitDelArbol = git(["rev-parse", "--short", "HEAD"]).trim();
    } catch {
      /* sin git */
    }
    const descripcion = `${mod.BV_SALA_VERSION} at ${commitDelArbol} (working-tree source, BVSALA_DEV_OPEN=1; weekly bench, not a release)${op.mock ? " — con un proveedor FALSO (--mock)" : ""}`;
    fabrica = fabricaReal(mod, cred, { tipo: "fuente", descripcion });
    catalogo = mod.CATALOGO;
    version = mod.BV_SALA_VERSION;
    origenDelPaquete = `fuente del árbol de trabajo (${commitDelArbol}), BVSALA_DEV_OPEN=1`;
  } else if (op.fuente) {
    const f = await cargarFuente();
    verificacion = f.verificacion;
    fabrica = fabricaReal(f.mod, cred, { tipo: "fuente" });
    catalogo = f.mod.CATALOGO;
    integrity = `${PAQUETE.integrity} (tarball de npm; dist/index.js sha256 ${f.verificacion.npm.sha256DistIndex} = build del fuente)`;
    version = f.mod.BV_SALA_VERSION;
    origenDelPaquete = `fuente de ${FUENTE.etiqueta} (${FUENTE.commit}), verificado idéntico al tarball de npm`;
    console.log(
      `Fuente ${FUENTE.etiqueta} verificado: ${f.verificacion.ficherosVerificados} ficheros de src/+packages/ idénticos a la etiqueta; dist/index.js ${f.verificacion.build.sha256DistIndex.slice(0, 16)}… = npm.` +
        (f.verificacion.diffDelRepo.length ? ` (El árbol de trabajo del repo difiere de la etiqueta en: ${f.verificacion.diffDelRepo.join(", ")}; no se carga.)` : ""),
    );
  } else if (op.mock) {
    fabrica = fabricaStub(cred);
    // El catálogo del fuente de este commit; en LIVE se usa el del paquete de npm.
    catalogo = (await import("../../../src/pricing/catalogo.js")).CATALOGO as Readonly<Record<string, Precio>>;
    version = `${PAQUETE.version} (no cargado: --mock)`;
    origenDelPaquete = "no cargado (--mock)";
  } else {
    const p = await cargarPaquete();
    fabrica = fabricaReal(p.mod, cred, { tipo: "npm" });
    catalogo = p.mod.CATALOGO;
    integrity = p.integrity;
    version = p.mod.BV_SALA_VERSION;
  }

  const orden = ordenEstratificado(ds.preguntas).slice(0, op.maxPreguntas);
  const precioJuez = catalogo[cred.juez.modelo.replace(/^[^/]+\//, "")] ?? null;
  if (op.juez && !precioJuez) throw new Error(`MT-Bench: el juez ${cred.juez.modelo} no tiene precio en el catálogo; no se puede acotar su gasto`);
  const libro: LibroDeGasto = libroInicial;

  const resumenes: ResumenDeModelo[] = [];
  const fallidos: { modelo: string; error: string }[] = [];

  // Anthropic: comprobación GRATUITA de la clave antes de gastar. 401 → no medibles.
  let modelos = anterior ? MODELOS_POR_DEFECTO.filter((m) => desdeCrudo!.has(m.id)) : op.modelos;
  if (anterior) fallidos.push(...anterior.informe.modelosFallidos);
  else if (modelos.some((m) => m.familia === "anthropic")) {
    const c = await comprobarAnthropic(cred, base);
    if (!c.ok) {
      const motivo =
        c.status === 401
          ? "no medible: clave inválida (GET /v1/models → 401; comprobación gratuita, 0 $ gastados)"
          : `no medible: GET /v1/models → ${c.status === 0 ? "sin respuesta" : `HTTP ${c.status}`} (comprobación gratuita, 0 $ gastados)`;
      for (const m of modelos.filter((x) => x.familia === "anthropic")) fallidos.push({ modelo: m.id, error: motivo });
      modelos = modelos.filter((m) => m.familia !== "anthropic");
      console.log(`Anthropic: ${motivo}`);
    }
  }

  const juezPrevio = Object.values(libro.juez).reduce((s, x) => s + x, 0);
  console.log(`MT-Bench ${op.mock ? "MOCK" : "LIVE"} · ${ds.origen} · ${orden.length} preguntas en orden estratificado · modelos: ${modelos.map((m) => m.id).join(", ") || "ninguno"}`);
  console.log(
    `Topes duros: ${fmtUsd(TOPE_POR_FAMILIA_USD.openai)} por modelo de OpenAI, ${fmtUsd(TOPE_POR_FAMILIA_USD.anthropic)} por modelo de Anthropic (A+B) · juez ${fmtUsd(TOPE_DEL_JUEZ_USD)} en total` +
      (juezPrevio > 0 ? ` (ya gastados ${fmtUsd(juezPrevio)} en tiradas anteriores)` : ""),
  );

  const crudo: unknown[] = [];
  let gastoGen = 0;
  let gastoJuez = 0;

  for (const [indice, m] of modelos.entries()) {
    const precio = catalogo[m.id] ?? null;
    if (!precio) {
      fallidos.push({ modelo: m.id, error: "sin fila en el catálogo de precios del paquete: el tope no se puede calcular, no se corre" });
      continue;
    }
    const prima = primaDeEscritura(m.familia);
    const previoGen = libro.generacion[m.id] ?? 0;
    if (previoGen > 0) console.log(`  ${m.id}: tiradas LIVE anteriores ya gastaron ${fmtUsd(previoGen)}; queda lo que falta hasta el tope`);
    const anotar = (tipo: keyof LibroDeGasto) => (usd: number) => {
      if (op.mock) return;
      libro[tipo][m.id] = (libro[tipo][m.id] ?? 0) + usd;
      guardarLibro(libro, op.sufijo);
    };
    const previo = desdeCrudo?.get(m.id) ?? null;
    const topeDelModelo = Math.min(topePorModelo(m), op.tope ?? Infinity);
    const tope = new Tope(`generación ${m.id}`, previo ? topeDelModelo : Math.max(0, topeDelModelo - previoGen), anotar("generacion"));
    let corte: string | undefined;
    const t0 = Date.now();
    let resultados: ResultadoDePregunta[];
    if (previo) {
      // --desde-crudo: la generación YA se hizo y se pagó; no se vuelve a llamar al proveedor.
      resultados = previo.resultados;
      tope.gastado = previo.gastoGeneracion;
      tope.excesos = previo.excesos;
      corte = previo.corte;
    } else {
      resultados = await enPool(orden, op.concurrenciaPreguntas, async (p) => {
        const peor = peorCosteDePregunta(precio, prima, p, m.maxSalida);
        if (!tope.cabe(peor)) {
          corte ??= `el peor coste de la pregunta siguiente (${fmtUsd(peor)}) no cabía: gastado ${fmtUsd(tope.gastado)} de ${fmtUsd(tope.limiteUsd)}`;
          return "parar" as const;
        }
        try {
          const r = await correrPregunta(p, m, cred, fabrica, tope, precio, base);
          process.stdout.write(r.error ? "x" : ".");
          return r;
        } catch (e) {
          if (e instanceof PresupuestoAgotado) {
            corte ??= e.message;
            return ((e as unknown as { parcial?: ResultadoDePregunta }).parcial ?? "parar") as ResultadoDePregunta | "parar";
          }
          throw e;
        }
      });
      process.stdout.write("\n");
    }
    if (resultados.length > 0 && resultados.every((r) => r.error)) {
      fallidos.push({ modelo: m.id, error: resultados[0]!.error ?? "?" });
    }
    const ordenIds = new Map(orden.map((p, i) => [p.id, i]));
    resultados.sort((a, b) => ordenIds.get(a.id)! - ordenIds.get(b.id)!);

    const juicios = new Map<number, JuicioDeTurno[]>(previo?.juicios ?? []);
    let topeJuez: Tope | null = null;
    let corteJuez = false;
    let llamadasJuez = previo?.llamadasJuez ?? 0;
    // En una recarga, lo ya juzgado cuenta aunque ahora no se juzgue más (--sin-juez).
    const previoJuez = previo ? (libro.juez[m.id] ?? 0) : 0;
    if ((op.juez || previo) && precioJuez) {
      const juezGastadoHastaAhora = Object.values(libro.juez).reduce((s, x) => s + x, 0) + (op.mock ? gastoJuez : 0);
      const parte = op.juez ? parteDelJuez(Math.min(TOPE_DEL_JUEZ_USD, op.topeJuez ?? Infinity), juezGastadoHastaAhora, modelos.length - indice) : 0;
      // El tope de ESTE modelo = lo que ya gastó en tiradas anteriores + su parte de lo que queda.
      topeJuez = new Tope(`juez ${m.id}`, previoJuez + parte, anotar("juez"));
      topeJuez.gastado = previoJuez;
      if (op.juez) {
        const j = await juzgarHastaElTope(resultados, juicios, ds, cred, topeJuez, precioJuez, base);
        llamadasJuez += j.llamadas;
        corteJuez = j.corte;
      } else {
        corteJuez = previo?.corteJuez ?? false;
      }
    }
    const res = resumir(m, precio, orden.length, resultados, tope, corte, juicios, topeJuez, llamadasJuez, corteJuez);
    resumenes.push(res);
    gastoGen += previo ? 0 : tope.gastado;
    gastoJuez += topeJuez ? topeJuez.gastado - previoJuez : 0;

    console.log(
      `  ${m.id}: ${res.preguntas.completas}/${orden.length} preguntas en ${((Date.now() - t0) / 1000).toFixed(0)} s · A ${fmtUsd(res.coste.A)} B ${fmtUsd(res.coste.B)} · ahorro ${ci(res.coste.ahorroEstratificadoPorCategoria)} (${res.coste.clase}) · gasto ${fmtUsd(tope.gastado)} + juez ${fmtUsd(topeJuez?.gastado ?? 0)} · B gana/A gana/empate ${res.calidad.victoriasB}/${res.calidad.victoriasA}/${res.calidad.empates}`,
    );
    crudo.push({
      modelo: m.id,
      preguntas: resultados.map((r) => ({
        id: r.id,
        categoria: r.categoria,
        error: r.error,
        A: r.A.map((t) => ({ fin: t.fin, latenciaMs: Math.round(t.latenciaMs), texto: t.texto })),
        B: r.B.map((t) => ({ fin: t.fin, latenciaMs: Math.round(t.latenciaMs), texto: t.texto, informe: t.informe })),
        llamadas: r.llamadas.map((l) => ({ ...l, latenciaMs: Math.round(l.latenciaMs) })),
        juicio: juicios.get(r.id) ?? null,
      })),
    });
  }

  let commit = "?";
  try {
    commit = git(["rev-parse", "HEAD"]).trim();
  } catch {
    /* sin git */
  }

  const informe: InformeCompleto = {
    bateria: "mt-bench",
    fecha: FECHA,
    modo: op.mock ? "MOCK" : "LIVE",
    commitDelRepo: commit,
    paquete: { nombre: PAQUETE.nombre, version, integrity, origen: origenDelPaquete },
    brazoB: op.mock && !op.fuente ? fabrica.descripcion : op.mock ? `${fabrica.descripcion} — con un proveedor FALSO (--mock)` : fabrica.descripcion,
    verificacionDelFuente: verificacion,
    dataset: { origen: ds.origen, repo: DATASET.repo, commit: DATASET.commit, license: DATASET.license, ficheros: DATASET.ficheros },
    juez: { modelo: cred.juez.modelo, topeUsd: TOPE_DEL_JUEZ_USD },
    topes: { porFamiliaUsd: { ...TOPE_POR_FAMILIA_USD }, juezTotalUsd: TOPE_DEL_JUEZ_USD },
    semilla: SEMILLA_DE_MUESTRA,
    gastoTotal: anterior
      ? { generacion: anterior.informe.gastoTotal.generacion + gastoGen, juez: anterior.informe.gastoTotal.juez + gastoJuez }
      : { generacion: gastoGen, juez: gastoJuez },
    gastoAcumuladoEntreTiradas: libro,
    hosts: { permitidos: HOSTS_PERMITIDOS, vistos: Object.fromEntries(hostsVistos), bloqueados: Object.fromEntries(hostsBloqueados) },
    modelos: resumenes,
    modelosFallidos: fallidos,
    limitaciones: [
      "MT-Bench es conversación de 2 turnos, prompts cortos (cientos de tokens) y sin herramientas ni contrato de salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché de prefijo del proveedor no llega al mínimo de tramo (1024 tokens en OpenAI y en claude-sonnet-5, 4096 en claude-haiku-4-5) en la mayoría de turnos. Este banco mide sobre todo que la capa NO empeore (coste, latencia, calidad) en tráfico de chat, no cuánto ahorra en tráfico agéntico.",
      "Una capa NUEVA por pregunta (caché y memoria frías): no hay repeticiones entre preguntas, así que la caché exacta/semántica de la capa no tiene ocasión de acertar. Es a propósito: el tráfico repetido va en otra batería.",
      `Subconjunto estratificado con semilla cuando las 80 preguntas no caben en el tope por modelo (${fmtUsd(TOPE_POR_FAMILIA_USD.openai)} OpenAI / ${fmtUsd(TOPE_POR_FAMILIA_USD.anthropic)} Anthropic); la calidad, además, solo se juzga en las preguntas que caben en ${fmtUsd(TOPE_DEL_JUEZ_USD)} de juez EN TOTAL (repartidos entre los modelos medidos), así que su intervalo es ancho.`,
      "El juez es gpt-4o por Vercel AI Gateway: sesgos conocidos de juez LLM (verbosidad, autopreferencia de familia OpenAI). Las posiciones intercambiadas controlan el sesgo de posición, no los demás.",
      "Temperatura de FastChat por categoría (0,7 en writing/roleplay): parte de las diferencias de calidad entre A y B en esas categorías es muestreo, no la capa. Los dos brazos muestrean igual; gpt-5.4-mini y claude-sonnet-5 no aceptan temperature y no se manda en ningún brazo.",
      "El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete. Descuentos negociados, batch o niveles no entran.",
      "Tope de salida NATIVO de la 0.4.31 en el brazo B (`maxOutputTokens` → `max_completion_tokens` en OpenAI, `max_tokens` en Anthropic) y el mismo campo y valor en el brazo A. gpt-5.4-mini y claude-sonnet-5 llevan 4096 (su razonamiento —en Sonnet 5, el pensamiento adaptativo que corre por defecto sin `thinking`— cuenta dentro); FastChat usa 1024.",
      ...(modelos.some((m) => m.familia === "anthropic")
        ? [
            "Anthropic: una capa nueva por pregunta y solo 2 turnos. La capa marca `cache_control` en el turno 2 (fin del prefijo estable = la respuesta del turno 1), pero no hay turno 3 que lea esa escritura: en este banco la marca solo puede costar (prima 1,25× sobre el tramo escrito) y nunca amortizarse. En una conversación larga, esa misma marca es la que haría que el turno siguiente leyera a 0,1×; este banco no mide ese caso.",
            "claude-sonnet-5 piensa (adaptativo) por defecto y el pensamiento se omite en la respuesta (`display: omitted`) pero se factura dentro de `output_tokens`; el juez solo ve el texto. Los dos brazos lo hacen igual (ninguno manda `thinking`).",
          ]
        : []),
      ...(op.fuente
        ? [
            `Brazo B = ${FUENTE.brazoB}. No es el paquete instalado de npm con licencia (no hay licencia de pruebas); se comprobó que el build del fuente da el mismo dist/index.js (sha256) que el tarball de npm, pero la ruta de licencia es la de desarrollo (sin verificación de licencia ni metering): la parte de licencia/medición del paquete no se ejerce aquí.`,
          ]
        : []),
      "La latencia es de pared desde este portátil, con A y B lanzados a la vez para cada turno; incluye la red doméstica y la carga del proveedor en ese momento. Los reintentos por 429 se excluyen de p50/p95 por llamada. Otros tres bancos compartían las claves a la vez.",
    ],
  };

  const destinoDir = op.salida ?? (op.mock ? DIR_TRABAJO : DIR_PUBLICADO);
  mkdirSync(destinoDir, { recursive: true });
  // Última barrera: ningún valor de credencial sale a disco. Si aparece el VALOR
  // de una clave cargada, no se escribe nada (es un fallo del arnés y hay que
  // verlo); lo que solo tenga FORMA de clave (p. ej. un ejemplo en una respuesta
  // de coding) se tapa igualmente antes de escribir.
  const barrera = (n: string, t: string): string => {
    if (secretos().some((s) => s && s.length >= 8 && t.includes(s))) {
      throw new Error(`MT-Bench: el ${n} contenía el valor de una credencial cargada; no se escribe nada`);
    }
    const limpio = tapar(t);
    if (limpio !== t) console.warn(`MT-Bench: se taparon cadenas con forma de credencial en el ${n} antes de escribirlo`);
    return limpio;
  };
  const json = barrera("json", JSON.stringify(informe, null, 2) + "\n");
  const md = barrera("md", markdown(informe));
  const crudoTxt = barrera("crudo", crudo.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(destinoDir, `${nombre}.json`), json);
  writeFileSync(join(destinoDir, `${nombre}.md`), md);
  mkdirSync(DIR_TRABAJO, { recursive: true });
  writeFileSync(join(DIR_TRABAJO, `${nombre}-respuestas.jsonl`), crudoTxt);
  console.log(`\nEscrito: ${join(destinoDir, nombre)}.{json,md} · respuestas crudas en ${join(DIR_TRABAJO, `${nombre}-respuestas.jsonl`)} (no versionado)`);
  console.log(`Gasto real: generación ${fmtUsd(gastoGen)} · juez ${fmtUsd(gastoJuez)} · hosts vistos ${JSON.stringify(informe.hosts.vistos)}${hostsBloqueados.size ? ` · BLOQUEADOS ${JSON.stringify(informe.hosts.bloqueados)}` : ""}`);
  if (fallidos.length) {
    console.log(`Modelos fallidos: ${fallidos.map((f) => `${f.modelo} (${f.error})`).join("; ")}`);
    process.exitCode = 1;
  }
  globalThis.fetch = fetchGlobal;
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  main().catch((e) => {
    console.error(`MT-Bench: ${tapar(String((e as Error)?.stack ?? e))}`);
    process.exit(1);
  });
}
