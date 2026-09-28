/**
 * MT-Bench A/B — batería pública (LMSYS/FastChat, 80 preguntas de 2 turnos).
 * ---------------------------------------------------------------------------
 * Brazo A: la conversación directa contra el API del proveedor, sin la capa.
 * Brazo B: la MISMA conversación a través de `@bivelio/savings-layer` 0.4.30
 *          TAL COMO SE INSTALA DE NPM (versión e integridad fijadas abajo),
 *          con la licencia del cliente (`BIVELIO_LICENSE_KEY`), que es la única
 *          vía que el paquete publicado acepta: es fail-closed.
 * Los dos brazos se miden con el `usage` real que devuelve el proveedor, leído
 * por el MISMO transporte (un `fetch` envuelto) y el MISMO lector. El informe
 * de la capa se guarda aparte, para comparar lo que ELLA dice haber ahorrado
 * con lo que se midió.
 *
 * Calidad: juez de pares de MT-Bench (gpt-4o), las dos posiciones, con la
 * respuesta de referencia en math/reasoning/coding (prompts de FastChat tal
 * cual, del mismo commit fijado).
 *
 * Uso:
 *   pnpm bench:mt-bench --mock                 # sin red: valida el arnés entero
 *   pnpm bench:mt-bench                        # LIVE, los 4 modelos
 *   pnpm bench:mt-bench --modelos=gpt-4o-mini --max-preguntas=8
 *   … --sin-juez                               # solo coste/latencia
 *
 * Presupuesto DURO (en código, no en la documentación): 1,25 $ por modelo (A+B
 * juntos) y 1 $ para el juez entero (0,25 $ por modelo). Cada llamada reserva
 * su peor coste antes de salir y no sale si no cabe; ver `Tope` en nucleo.ts.
 *
 * Credenciales: solo por `--env-file` (el script de package.json lee
 * `.env.bench`). Nada de este fichero imprime, guarda ni vuelca una clave: los
 * errores pasan por `redactar` y los cuerpos que se guardan son de petición,
 * nunca cabeceras.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  TOPE_DEL_JUEZ_USD,
  TOPE_POR_MODELO_USD,
  Tope,
  combinarPartidas,
  costeDeUso,
  diferenciasDeCuerpo,
  fmtUsd,
  idCualificado,
  leerVeredicto,
  ordenEstratificado,
  parsearPreguntas,
  parsearPromptsDelJuez,
  parsearReferencias,
  percentil,
  peorCosteDeLlamada,
  peorCosteDePregunta,
  primaDeEscritura,
  promptDelJuez,
  puntuacionDeB,
  redactar,
  sumarUsos,
  urlDeFichero,
  usoDeAnthropic,
  usoDeOpenAI,
  type Categoria,
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

/** `npm view @bivelio/savings-layer@0.4.30 dist.integrity` (2026-09-28). */
export const PAQUETE = {
  nombre: "@bivelio/savings-layer",
  version: "0.4.30",
  integrity: "sha512-73eFHgLeCQnJlCzkDnnpxJjRCbBDXYxiJIJZ4iglVrN0IrFhGleCYRdE7nyYMzguLzaw5KmexjDyPMpt8BxL+w==",
  shasum: "df3b228413dd09c906658ab083550c3e5adeb2c9",
  /** El peer que el README pide para modelos de OpenAI (conteo exacto). */
  tokenizador: "gpt-tokenizer@3.4.0",
  origen: "npm registry (no el tarball local)",
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
const LIBRO_DE_GASTO = join(DIR_TRABAJO, "gasto-live-acumulado.json");

interface LibroDeGasto {
  generacion: Record<string, number>;
  juez: Record<string, number>;
}

function leerLibro(): LibroDeGasto {
  if (!existsSync(LIBRO_DE_GASTO)) return { generacion: {}, juez: {} };
  return JSON.parse(readFileSync(LIBRO_DE_GASTO, "utf8")) as LibroDeGasto;
}

function guardarLibro(l: LibroDeGasto): void {
  mkdirSync(DIR_TRABAJO, { recursive: true });
  writeFileSync(LIBRO_DE_GASTO, JSON.stringify(l, null, 2) + "\n");
}
const DIR_PUBLICADO = join(RAIZ, "docs", "benchmarks", FECHA);

// ── Argumentos ──────────────────────────────────────────────────────────────

interface Opciones {
  mock: boolean;
  modelos: ModeloDeLaBateria[];
  maxPreguntas: number;
  juez: boolean;
  concurrenciaPreguntas: number;
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
  return {
    mock: argv.includes("--mock"),
    modelos,
    maxPreguntas: Number.isFinite(max) && max > 0 ? Math.min(80, Math.floor(max)) : 80,
    juez: !argv.includes("--sin-juez"),
    // 2 preguntas a la vez × 2 brazos = ≤ 4 peticiones simultáneas por proveedor.
    concurrenciaPreguntas: 2,
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

/** La parte de la API pública de 0.4.30 que usa la batería (tipada a mano: se carga en tiempo de ejecución). */
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
  generate(req: { model: string; messages: { role: string; content: string }[]; temperature?: number }): Promise<ResultadoDeLaCapa>;
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
  if (mod.BV_SALA_VERSION !== PAQUETE.version) {
    throw new Error(`MT-Bench: el paquete cargado dice ser ${mod.BV_SALA_VERSION}, esperado ${PAQUETE.version}`);
  }
  return { mod, integrity: integrityInstalada };
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
 * Un `fetch` que: (1) en OpenAI añade `max_completion_tokens` si falta (techo de
 * gasto idéntico en los dos brazos); (2) reserva el peor coste en el tope ANTES
 * de enviar; (3) reintenta 429/5xx con backoff exponencial y `retry-after`; (4)
 * lee el `usage` de la respuesta con el lector de la familia y cierra la
 * reserva con el coste real. La respuesta que recibe el llamante (la capa o el
 * brazo A) es la misma, intacta.
 */
function fetchMedido(ctx: ContextoDeTransporte): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let cuerpo: Record<string, unknown> = {};
    let texto = typeof init?.body === "string" ? init.body : "";
    if (texto) {
      cuerpo = JSON.parse(texto) as Record<string, unknown>;
      if (ctx.familia === "openai" && cuerpo["max_completion_tokens"] == null && cuerpo["max_tokens"] == null) {
        cuerpo["max_completion_tokens"] = ctx.maxSalida;
        texto = JSON.stringify(cuerpo);
      }
    }
    const maxSalida = Number(cuerpo["max_tokens"] ?? cuerpo["max_completion_tokens"] ?? ctx.maxSalida);
    const reserva = ctx.tope.reservar(
      peorCosteDeLlamada(ctx.precio, primaDeEscritura(ctx.familia), JSON.stringify(cuerpo["messages"] ?? cuerpo).length + JSON.stringify(cuerpo["system"] ?? "").length, maxSalida, 256),
    );
    const t0 = performance.now();
    let reintentos = 0;
    let res: Response | null = null;
    let ultimoError: unknown = null;
    for (let intento = 0; intento < 7; intento++) {
      try {
        res = await ctx.base(input, { ...init, body: texto || init?.body });
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

function fabricaReal(mod: ModuloDelPaquete, cred: Credenciales): FabricaDeCapa {
  return {
    descripcion: `${PAQUETE.nombre}@${mod.BV_SALA_VERSION} de npm, licenseKey del cliente, sin licenseServerUrl (ruta offline: sin metering ni llamada a casa)`,
    crear(m, f) {
      const provider =
        m.familia === "anthropic"
          ? new mod.AnthropicProvider({ apiKey: cred.anthropic.clave, baseUrl: cred.anthropic.base, defaultMaxOutputTokens: m.maxSalida, fetchImpl: f })
          : new mod.OpenAICompatibleProvider({ apiKey: cred.openai.clave, baseUrl: cred.openai.base, fetchImpl: f });
      const precio = mod.CATALOGO[m.id];
      return mod.createSavingsLayer({
        provider,
        licenseKey: cred.licencia,
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
          const r = await llamarDirecto(m, cred, req.messages as Mensaje[], req.temperature, f);
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
function fetchFalso(): typeof fetch {
  let n = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
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
          const r = await capa.generate({ model: idCualificado(m), messages: [...histB], ...(temperatura !== undefined ? { temperature: temperatura } : {}) });
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
  const partida = async (sys: string, user: string): Promise<Ganador> => {
    const res = await f(`${cred.juez.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cred.juez.clave ?? ""}` },
      // FastChat: temperature 0, max_tokens 2048.
      body: JSON.stringify({ model: cred.juez.modelo, temperature: 0, max_tokens: 2048, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    if (!res.ok) return "error";
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return leerVeredicto(j.choices?.[0]?.message?.content ?? "");
  };
  const turnos = await Promise.all(
    ([1, 2] as const).map(async (turno): Promise<JuicioDeTurno> => {
      const identicas = turno === 1 ? convA.respuestas[0] === convB.respuestas[0] : convA.respuestas.every((t, i) => t === convB.respuestas[i]);
      const p1 = promptDelJuez(ds.prompts, turno, convA, convB, ref);
      if (identicas) {
        return { turno, prompt: p1.nombre, partida1: "idéntica", partida2: "idéntica", ganador: "empate", inconsistente: false, identicas: true };
      }
      const p2 = promptDelJuez(ds.prompts, turno, convB, convA, ref);
      const [g1, g2] = await Promise.all([partida(p1.system, p1.user), partida(p2.system, p2.user)]);
      const c = combinarPartidas(g1, g2);
      return { turno, prompt: p1.nombre, partida1: g1, partida2: g2, ganador: c.ganador, inconsistente: c.inconsistente, identicas: false };
    }),
  );
  return turnos;
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
    deltaMedioPorPreguntaUsd: CI | null;
    wilcoxonP: number | null;
  };
  tokens: { A: UsoMedido; B: UsoMedido };
  cacheDePrefijo: { llamadasConLecturaA: number; llamadasConLecturaB: number; llamadasConEscrituraA: number; llamadasConEscrituraB: number; llamadas: number };
  latencia: { A: { p50: number | null; p95: number | null }; B: { p50: number | null; p95: number | null }; deltaMedioMs: CI | null; llamadasSinReintento: number };
  truncadas: { A: number; B: number };
  cable: { turnos: number; identicos: number; diferencias: Record<string, number>; modelosServidosB: string[]; modelosServidosA: string[] };
  capa: {
    basis: Record<string, number>;
    ahorroDeclaradoUsd: number;
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
      const d = diferenciasDeCuerpo(a.cuerpo, b.cuerpo);
      if (d.length === 0) identicos++;
      difs.push(...d);
    }
  }
  const informes = completas.flatMap((r) => r.B.map((t) => t.informe).filter((x): x is NonNullable<typeof x> => !!x));
  const ahorroPorBasis: Record<string, number> = {};
  for (const i of informes) ahorroPorBasis[i.cost.basis] = (ahorroPorBasis[i.cost.basis] ?? 0) + i.cost.netSavings;
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
      ahorroEstratificadoPorCategoria: completas.length ? bootstrapRatioCIEstratificado(estratos, { seed: SEMILLA_DE_MUESTRA }) : null,
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
      ahorroDeclaradoUsd: informes.reduce((s, i) => s + i.cost.netSavings, 0),
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
      errores: js.length - validos.length,
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
  L.push(`- **Paquete:** \`${PAQUETE.nombre}@${inf.paquete.version}\` (${PAQUETE.origen}; integrity \`${inf.paquete.integrity}\`).`);
  L.push(`- **Dataset:** ${inf.dataset.origen} — \`${DATASET.repo}@${DATASET.commit}\` (${DATASET.license}); sha256 verificados: question.jsonl \`${DATASET.ficheros.preguntas.sha256.slice(0, 16)}…\`, reference_answer/gpt-4.jsonl \`${DATASET.ficheros.referencias.sha256.slice(0, 16)}…\`, judge_prompts.jsonl \`${DATASET.ficheros.promptsDelJuez.sha256.slice(0, 16)}…\`. No se versiona: se descarga y se comprueba en cada tirada.`);
  L.push(`- **Subconjunto:** orden estratificado por categoría con semilla ${SEMILLA_DE_MUESTRA}; cualquier prefijo queda equilibrado (±1 por categoría). Se corta cuando el peor coste de la siguiente pregunta ya no cabe en el tope.`);
  L.push(`- **Juez:** \`${inf.juez.modelo}\` por pasarela, prompts de pares de FastChat (\`pair-v2\`, \`pair-v2-multi-turn\`, y \`pair-math-v1*\` con referencia en math/reasoning/coding), posiciones intercambiadas; si las dos partidas discrepan, empate. Turnos con respuestas byte-idénticas en A y B = empate sin juez (declarado aparte).`);
  L.push(`- **Gasto real total:** generación ${usd(inf.gastoTotal.generacion)} + juez ${usd(inf.gastoTotal.juez)} = **${usd(inf.gastoTotal.generacion + inf.gastoTotal.juez)}**.`);
  L.push("");
  L.push("## Tabla por modelo");
  L.push("");
  L.push("| modelo | preguntas | coste A | coste B | ahorro B vs A (IC95 estratificado) | caché leída A/B (llamadas) | p50 A / B (ms) | p95 A / B (ms) | B gana / A gana / empate (turnos) | tasa de victoria B (IC95) | gasto real (gen + juez) |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of inf.modelos) {
    const lat = (x: number | null) => (x === null ? "—" : Math.round(x).toString());
    L.push(
      `| \`${r.modelo}\` | ${r.preguntas.completas}/${r.preguntas.planificadas}${r.preguntas.cortePorPresupuesto ? " ✂" : ""} | ${usd(r.coste.A)} | ${usd(r.coste.B)} | ${ci(r.coste.ahorroEstratificadoPorCategoria)} | ${r.cacheDePrefijo.llamadasConLecturaA}/${r.cacheDePrefijo.llamadasConLecturaB} | ${lat(r.latencia.A.p50)} / ${lat(r.latencia.B.p50)} | ${lat(r.latencia.A.p95)} / ${lat(r.latencia.B.p95)} | ${r.calidad.victoriasB} / ${r.calidad.victoriasA} / ${r.calidad.empates} | ${ci(r.calidad.tasaDeVictoriaB)} | ${usd(r.gasto.total)} + ${usd(r.gasto.juez)} |`,
    );
  }
  L.push("");
  L.push("✂ = subconjunto por presupuesto. La tasa de victoria de B cuenta el empate como ½: 50 % = sin diferencia.");
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
    L.push(`- Tope de salida por llamada: ${r.maxSalida} (igual en A y B). Temperatura: ${r.temperatura}. Precio: ${r.precio ? `${r.precio.inputPer1k}/${r.precio.outputPer1k} $ por 1k (cacheada ${r.precio.cachedInputPer1k ?? "—"})` : "SIN FILA EN EL CATÁLOGO"}.`);
    L.push(`- Coste A ${usd(r.coste.A)} · B ${usd(r.coste.B)} · ahorro agrupado ${ci(r.coste.ahorroPooled)} · estratificado ${ci(r.coste.ahorroEstratificadoPorCategoria)} · Δ medio por pregunta ${r.coste.deltaMedioPorPreguntaUsd ? `${(r.coste.deltaMedioPorPreguntaUsd.point * 1e6).toFixed(1)} µ$ [${(r.coste.deltaMedioPorPreguntaUsd.lower * 1e6).toFixed(1)}, ${(r.coste.deltaMedioPorPreguntaUsd.upper * 1e6).toFixed(1)}]` : "—"} · Wilcoxon p ${r.coste.wilcoxonP?.toFixed(3) ?? "—"}.`);
    L.push(`- Tokens A: entrada ${r.tokens.A.entrada}, caché leída ${r.tokens.A.cacheLeida}, escrita ${r.tokens.A.cacheEscrita}, salida ${r.tokens.A.salida} (razonamiento ${r.tokens.A.razonamiento}). B: ${r.tokens.B.entrada} / ${r.tokens.B.cacheLeida} / ${r.tokens.B.cacheEscrita} / ${r.tokens.B.salida} (${r.tokens.B.razonamiento}).`);
    L.push(`- Truncadas por el tope: A ${r.truncadas.A}, B ${r.truncadas.B}. Respuestas byte-idénticas A=B: ${r.respuestasIdenticasPorTurno} turnos.`);
    L.push(`- Cable: ${r.cable.identicos}/${r.cable.turnos} turnos con cuerpo idéntico (normalizado) en A y B; campos que difieren: ${Object.entries(r.cable.diferencias).map(([k, v]) => `\`${k}\` ×${v}`).join(", ") || "ninguno"}. Modelo servido A: ${r.cable.modelosServidosA.join(", ")}; B: ${r.cable.modelosServidosB.join(", ")}.`);
    L.push(`- Lo que dice la capa: basis ${JSON.stringify(r.capa.basis)}, ahorro declarado ${usd(r.capa.ahorroDeclaradoUsd)} (${JSON.stringify(Object.fromEntries(Object.entries(r.capa.ahorroDeclaradoPorBasis).map(([k, v]) => [k, Number(v.toFixed(6))])))}), coste declarado ${usd(r.capa.costeDeclaradoUsd)} frente a ${usd(r.capa.costeMedidoB)} medido; turnos cuyo conteo de tokens no cuadra con el proveedor: ${r.capa.tokensQueNoCuadran}; llamadas extra al proveedor: ${r.capa.llamadasExtraAlProveedor}; caché ${JSON.stringify(r.capa.cacheResult)}; ruta ${JSON.stringify(r.capa.executionClass)}.`);
    L.push(`- Calidad: ${r.calidad.juzgada ? `${r.calidad.turnosJuzgados} turnos de ${r.calidad.preguntasJuzgadas} preguntas (${r.calidad.llamadasAlJuez} llamadas al juez${r.calidad.cortePorPresupuesto ? ", cortado por el tope del juez" : ""}); B gana ${r.calidad.victoriasB}, A gana ${r.calidad.victoriasA}, empate ${r.calidad.empates} (de ellos ${r.calidad.inconsistentes} por partidas discrepantes y ${r.calidad.identicas} por respuestas idénticas); errores de lectura ${r.calidad.errores}; tasa de victoria B ${ci(r.calidad.tasaDeVictoriaB)}. Por categoría: ${Object.entries(r.calidad.porCategoria).map(([k, v]) => `${k} ${v.B}/${v.A}/${v.empate}`).join(", ") || "—"}.` : "no juzgada (--sin-juez)."}`);
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
  dataset: { origen: string; repo: string; commit: string; license: string; ficheros: typeof DATASET.ficheros };
  juez: { modelo: string; topeUsd: number };
  topes: { porModeloUsd: number; juezUsd: number };
  semilla: number;
  gastoTotal: { generacion: number; juez: number };
  modelos: ResumenDeModelo[];
  modelosFallidos: { modelo: string; error: string }[];
  limitaciones: string[];
}

// ── Principal ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const op = leerOpciones(process.argv.slice(2));
  const cred = credenciales();
  const ds = await cargarDataset(!op.mock);
  const base: typeof fetch = op.mock ? fetchFalso() : fetch;

  let fabrica: FabricaDeCapa;
  let catalogo: Readonly<Record<string, Precio>>;
  let integrity = "—";
  let version: string = PAQUETE.version;
  if (op.mock) {
    fabrica = fabricaStub(cred);
    // El catálogo del fuente de este commit (= 0.4.30); en LIVE se usa el del paquete de npm.
    catalogo = (await import("../../../src/pricing/catalogo.js")).CATALOGO as Readonly<Record<string, Precio>>;
    version = `${PAQUETE.version} (no cargado: --mock)`;
  } else {
    const faltan = [
      !cred.licencia && "BIVELIO_LICENSE_KEY (el paquete publicado es fail-closed: sin licencia el brazo B no existe)",
      op.modelos.some((m) => m.familia === "anthropic") && !cred.anthropic.clave && "BVSALA_DEMO_ANTHROPIC_API_KEY",
      op.modelos.some((m) => m.familia === "openai") && !cred.openai.clave && "BVSALA_DEMO_API_KEY",
      op.juez && !cred.juez.clave && "BVSALA_JUDGE_API_KEY",
    ].filter(Boolean);
    if (faltan.length) {
      console.error(`MT-Bench LIVE: faltan variables (solo nombres): ${faltan.join(", ")}. No se ha hecho ninguna llamada de pago.`);
      process.exit(2);
    }
    const p = await cargarPaquete();
    fabrica = fabricaReal(p.mod, cred);
    catalogo = p.mod.CATALOGO;
    integrity = p.integrity;
    version = p.mod.BV_SALA_VERSION;
  }

  const orden = ordenEstratificado(ds.preguntas).slice(0, op.maxPreguntas);
  const precioJuez = catalogo[cred.juez.modelo.replace(/^[^/]+\//, "")] ?? null;
  if (op.juez && !precioJuez) throw new Error(`MT-Bench: el juez ${cred.juez.modelo} no tiene precio en el catálogo; no se puede acotar su gasto`);
  // Fijo por modelo de la batería (1 $ / 4), corra uno o los cuatro en esta invocación.
  const topeJuezPorModelo = TOPE_DEL_JUEZ_USD / MODELOS_POR_DEFECTO.length;
  const libro: LibroDeGasto = op.mock ? { generacion: {}, juez: {} } : leerLibro();

  console.log(`MT-Bench ${op.mock ? "MOCK" : "LIVE"} · ${ds.origen} · ${orden.length} preguntas en orden estratificado · modelos: ${op.modelos.map((m) => m.id).join(", ")}`);
  console.log(`Topes duros: ${fmtUsd(TOPE_POR_MODELO_USD)} por modelo (A+B) · juez ${fmtUsd(TOPE_DEL_JUEZ_USD)} (${fmtUsd(topeJuezPorModelo)} por modelo)`);

  const resumenes: ResumenDeModelo[] = [];
  const fallidos: { modelo: string; error: string }[] = [];
  const crudo: unknown[] = [];
  let gastoGen = 0;
  let gastoJuez = 0;

  for (const m of op.modelos) {
    const precio = catalogo[m.id] ?? null;
    if (!precio) {
      fallidos.push({ modelo: m.id, error: "sin fila en el catálogo de precios del paquete: el tope no se puede calcular, no se corre" });
      continue;
    }
    const prima = primaDeEscritura(m.familia);
    const previoGen = libro.generacion[m.id] ?? 0;
    const previoJuez = libro.juez[m.id] ?? 0;
    if (previoGen > 0 || previoJuez > 0) {
      console.log(`  ${m.id}: tiradas LIVE anteriores ya gastaron ${fmtUsd(previoGen)} + juez ${fmtUsd(previoJuez)}; queda lo que falta hasta el tope`);
    }
    const anotar = (tipo: keyof LibroDeGasto) => (usd: number) => {
      if (op.mock) return;
      libro[tipo][m.id] = (libro[tipo][m.id] ?? 0) + usd;
      guardarLibro(libro);
    };
    const tope = new Tope(`generación ${m.id}`, Math.max(0, TOPE_POR_MODELO_USD - previoGen), anotar("generacion"));
    let corte: string | undefined;
    const t0 = Date.now();
    const resultados = await enPool(orden, op.concurrenciaPreguntas, async (p) => {
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
    // Si el primer turno falló en TODAS (p. ej. el id no existe en el API), el modelo se declara fallido.
    if (resultados.length > 0 && resultados.every((r) => r.error)) {
      fallidos.push({ modelo: m.id, error: resultados[0]!.error ?? "?" });
    }
    const ordenIds = new Map(orden.map((p, i) => [p.id, i]));
    resultados.sort((a, b) => ordenIds.get(a.id)! - ordenIds.get(b.id)!);

    // Juez: preguntas completas, en el orden estratificado, hasta el tope del juez.
    const juicios = new Map<number, JuicioDeTurno[]>();
    let topeJuez: Tope | null = null;
    let corteJuez = false;
    let llamadasJuez = 0;
    if (op.juez && precioJuez) {
      topeJuez = new Tope(`juez ${m.id}`, Math.max(0, topeJuezPorModelo - previoJuez), anotar("juez"));
      for (const r of resultados) {
        if (r.error || r.A.length !== 2 || r.B.length !== 2) continue;
        const p = ds.preguntas.find((q) => q.id === r.id)!;
        const largo = (p.turnos.join("").length + r.A.concat(r.B).reduce((s, t) => s + t.texto.length, 0)) * 1 + 4000;
        const peor = 4 * peorCosteDeLlamada(precioJuez, 1, largo, 2048);
        if (!topeJuez.cabe(peor)) {
          corteJuez = true;
          break;
        }
        try {
          const j = await juzgarPregunta(r, p, ds, cred, topeJuez, precioJuez, base);
          llamadasJuez += j.filter((x) => !x.identicas).length * 2;
          juicios.set(r.id, j);
        } catch (e) {
          if (e instanceof PresupuestoAgotado) {
            corteJuez = true;
            break;
          }
          throw e;
        }
      }
    }
    const res = resumir(m, precio, orden.length, resultados, tope, corte, juicios, topeJuez, llamadasJuez, corteJuez);
    resumenes.push(res);
    gastoGen += tope.gastado;
    gastoJuez += topeJuez?.gastado ?? 0;

    console.log(
      `  ${m.id}: ${res.preguntas.completas}/${orden.length} preguntas en ${((Date.now() - t0) / 1000).toFixed(0)} s · A ${fmtUsd(res.coste.A)} B ${fmtUsd(res.coste.B)} · ahorro ${ci(res.coste.ahorroEstratificadoPorCategoria)} · gasto ${fmtUsd(tope.gastado)} + juez ${fmtUsd(topeJuez?.gastado ?? 0)} · B gana/A gana/empate ${res.calidad.victoriasB}/${res.calidad.victoriasA}/${res.calidad.empates}`,
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
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ, encoding: "utf8" }).trim();
  } catch {
    /* sin git */
  }

  const informe: InformeCompleto = {
    bateria: "mt-bench",
    fecha: FECHA,
    modo: op.mock ? "MOCK" : "LIVE",
    commitDelRepo: commit,
    paquete: { nombre: PAQUETE.nombre, version, integrity, origen: op.mock ? "no cargado (--mock)" : PAQUETE.origen },
    brazoB: fabrica.descripcion,
    dataset: { origen: ds.origen, repo: DATASET.repo, commit: DATASET.commit, license: DATASET.license, ficheros: DATASET.ficheros },
    juez: { modelo: cred.juez.modelo, topeUsd: TOPE_DEL_JUEZ_USD },
    topes: { porModeloUsd: TOPE_POR_MODELO_USD, juezUsd: TOPE_DEL_JUEZ_USD },
    semilla: SEMILLA_DE_MUESTRA,
    gastoTotal: { generacion: gastoGen, juez: gastoJuez },
    modelos: resumenes,
    modelosFallidos: fallidos,
    limitaciones: [
      "MT-Bench es conversación de 2 turnos, prompts cortos (cientos de tokens) y sin herramientas ni contrato de salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché de prefijo no llega al mínimo de tramo en la mayoría de turnos. Este banco mide sobre todo que la capa NO empeore (coste, latencia, calidad) en tráfico de chat, no cuánto ahorra en tráfico agéntico.",
      "Subconjunto estratificado por presupuesto cuando 80 preguntas no caben en 1,25 $ por modelo; la calidad, además, solo se juzga en las preguntas que caben en 0,25 $ de juez por modelo, así que su intervalo es ancho.",
      "El juez es gpt-4o por Vercel AI Gateway: sesgos conocidos de juez LLM (verbosidad, autopreferencia de familia OpenAI). Las posiciones intercambiadas controlan el sesgo de posición, no los demás.",
      "Temperatura de FastChat por categoría (0,7 en writing/roleplay): parte de las diferencias de calidad entre A y B en esas categorías es muestreo, no la capa. Los dos brazos muestrean igual.",
      "El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete. Descuentos negociados, batch o niveles no entran.",
      "En OpenAI la capa 0.4.30 no admite un tope de salida en texto libre (solo con contrato `response`); el transporte del banco añade `max_completion_tokens` idéntico en A y B como techo de gasto. Se excluye del diff del cable.",
      "La latencia es de pared desde este portátil, con A y B lanzados a la vez para cada turno; incluye la red doméstica y la carga del proveedor en ese momento. Los reintentos por 429 se excluyen de p50/p95 por llamada.",
    ],
  };

  const destinoDir = op.mock ? DIR_TRABAJO : DIR_PUBLICADO;
  mkdirSync(destinoDir, { recursive: true });
  const nombre = op.mock ? "mt-bench-mock" : "mt-bench";
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
  console.log(`Gasto real: generación ${fmtUsd(gastoGen)} · juez ${fmtUsd(gastoJuez)}`);
  if (fallidos.length) {
    console.log(`Modelos fallidos: ${fallidos.map((f) => `${f.modelo} (${f.error})`).join("; ")}`);
    process.exitCode = 1;
  }
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  main().catch((e) => {
    console.error(`MT-Bench: ${tapar(String((e as Error)?.stack ?? e))}`);
    process.exit(1);
  });
}
