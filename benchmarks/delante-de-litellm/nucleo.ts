/**
 * E6 · BV-SALA DELANTE DE LITELLM — el núcleo que comparten la prueba real
 * (`e2e.ts`, con LiteLLM 1.102.1 instalado en un venv temporal) y el test de CI
 * (`test/delante-de-litellm.test.ts`, contra el DOBLE de este fichero, sin
 * Python ni red).
 *
 * La pregunta del experimento (informe de competencia del 2026-09-27, §10): el
 * comprador que ya tiene LiteLLM, ¿puede tener libros con base sin cambiar de
 * gateway? Y dos cosas que demostrar:
 *
 *   (a) una repetición idéntica sale con base `reference`;
 *   (b) detrás de un upstream no oficial no hay comisión.
 *
 * Desde el 2026-09-28 el dueño decidió (b) por encima de (a) también en el SDK:
 * detrás del proxy la repetición se sirve igual, pero sale `estimated`
 * (`unofficial-origin`, E0-bis de src/pipeline/referencia.ts).
 *
 * Aquí viven las piezas, puras o casi (servidores HTTP en 127.0.0.1 y nada
 * más):
 *
 *   · `arrancarDobleDeLiteLLM`: un proxy que se porta como LiteLLM 1.102.1 en lo
 *     que el SDK y el gateway ven —alias de modelo en la respuesta, campos
 *     `provider_specific_fields`, las cabeceras `x-litellm-*` con su coste, y su
 *     caché local, que en un acierto no llama al upstream y REPITE la cabecera
 *     de coste—. Lo observado en el LiteLLM real está en la evidencia fechada
 *     (benchmarks/evidencia/delante-de-litellm-*.json) y el test ata el doble a
 *     ella.
 *   · `repetirConElSdk`: el SDK apuntando al proxy, la MISMA petición dos veces,
 *     con la medición encendida contra una ingesta falsa local.
 *   · `coalescerConElGateway` / `rebajarTtlConElGateway`: el gateway de BV-SALA
 *     con el proxy como upstream.
 *   · `veredictoDeComision`: lo que el servidor haría con cada registro —la
 *     verja real del ingest (`parseUsageRecords`), la de versión y el
 *     interruptor de la tarifa— y si entra en la base de la comisión.
 *
 * Nada de esto cambia el producto: mide lo que hace hoy. Ninguna petición sale
 * de 127.0.0.1 y ninguna lleva una clave real.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { parseUsageRecords } from "../../apps/web/lib/metering/usage.js";
import { COMISIONAR_REFERENCIA } from "../../apps/web/lib/billing/tarifa.js";
import { compararVersiones, superficieDe } from "../../apps/web/lib/version/semver.js";
import { arrancarGateway } from "../../gateway/servidor.js";
import { createSavingsLayer } from "../../src/pipeline/create.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import type { CostModel } from "../../src/tokenizer/accounting.js";
import type { SavingsReport } from "../../src/contracts/types.js";
import { CABECERA_VERSION, VERSION_MINIMA_REFERENCIA } from "../../src/version.js";
import { testLicense } from "../../test/helpers/test-license.js";

/** Una clave con la forma de ninguna real: solo viaja a la ingesta FALSA local. */
export const CLAVE_DE_RELLENO = "e6-relleno-no-es-una-clave";

/**
 * La master key de relleno de `litellm-con-cache.yaml` (LiteLLM exige el
 * prefijo `sk-`). El SDK la manda al proxy como su `apiKey`; solo vale contra
 * el proceso local.
 */
export const CLAVE_DEL_PROXY = "sk-e6-relleno-no-es-una-clave";

/** La versión de LiteLLM que imita el doble y que instala `instalar-litellm.sh`. */
export const VERSION_LITELLM = "1.102.1";

// ── Servidores pequeños ────────────────────────────────────────────────────

async function leerCuerpo(req: IncomingMessage): Promise<Buffer> {
  const trozos: Buffer[] = [];
  for await (const t of req) trozos.push(t as Buffer);
  return Buffer.concat(trozos);
}

function escuchar(servidor: Server, puerto = 0): Promise<number> {
  return new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(puerto, "127.0.0.1", () => {
      const dir = servidor.address();
      resolver(typeof dir === "object" && dir ? dir.port : 0);
    });
  });
}

function cerrarServidor(servidor: Server): Promise<void> {
  return new Promise((r) => {
    servidor.closeAllConnections();
    servidor.close(() => r());
  });
}

export async function esperarA(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`esperarA: la condición no se cumplió en ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── La ingesta falsa ───────────────────────────────────────────────────────

export interface LoteRecibido {
  /** La cabecera `x-bvsala-version` con la que llegó (`sdk/0.4.26`, `gateway/0.4.26`). */
  version: string | null;
  registros: Record<string, unknown>[];
}

export interface IngestaFalsa {
  origen: string;
  lotes: LoteRecibido[];
  registros(): Record<string, unknown>[];
  cerrar(): Promise<void>;
}

/**
 * Una ingesta de BiVelio FALSA: guarda cada lote con su cabecera de versión y
 * contesta 202, y sirve `/api/org/entitlements` con las features que se le
 * digan (el canal de palancas del gateway lo pide al arrancar).
 */
export async function arrancarIngestaFalsa(features: readonly string[] = []): Promise<IngestaFalsa> {
  const lotes: LoteRecibido[] = [];
  const s = createServer(async (req, res) => {
    const cuerpo = await leerCuerpo(req);
    if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ features, refreshAfterSeconds: 300 }));
      return;
    }
    if (req.method === "POST" && cuerpo.length > 0) {
      try {
        const v = req.headers[CABECERA_VERSION];
        lotes.push({
          version: typeof v === "string" ? v : null,
          registros: JSON.parse(cuerpo.toString("utf8")) as Record<string, unknown>[],
        });
      } catch {
        /* un lote ilegible no es asunto de este banco */
      }
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end("{}");
  });
  const puerto = await escuchar(s);
  return {
    origen: `http://127.0.0.1:${puerto}`,
    lotes,
    registros: () => lotes.flatMap((l) => l.registros),
    cerrar: () => cerrarServidor(s),
  };
}

// ── Lo que el servidor haría con cada registro ─────────────────────────────

export interface Veredicto {
  requestId: string;
  cacheResult: string;
  /** El basis que MANDÓ el emisor. */
  basisEmitido: string;
  /** El basis que se queda el servidor tras sus verjas. */
  basisIngerido: string;
  /** ¿Entra en la base de la comisión? */
  enLaBase: boolean;
  /** baseline − actual del registro, en USD (lo que se comisionaría si entra). */
  ahorroUsd: number;
}

/**
 * Espejo de `admiteReferencia` (apps/web/lib/metering/version.ts, que el
 * typecheck raíz no puede importar por su alias `@/`): solo el SDK, desde la
 * versión mínima de la regla. `version.test.ts` ata esa mínima a la de
 * src/version.ts, que es la que se usa aquí.
 */
export function versionAdmiteReferencia(version: string | null): boolean {
  if (superficieDe(version) !== "sdk") return false;
  if (/-/.test(version!.slice(version!.indexOf("/") + 1))) return false;
  return compararVersiones(version!, VERSION_MINIMA_REFERENCIA) >= 0;
}

/**
 * Lo que el servidor de BiVelio haría con un lote, en el orden de la ruta de
 * ingesta (apps/web/app/api/metering/usage/route.ts): la verja REAL del
 * registro (`parseUsageRecords`, que degrada una referencia incoherente), la de
 * versión (una referencia de un proceso sin la regla vigente, o del gateway,
 * entra como estimada) y el interruptor de la tarifa (`COMISIONAR_REFERENCIA`).
 * Lo medido entra en la base si tiene ahorro; lo estimado, nunca.
 */
export function veredictoDeComision(lotes: readonly LoteRecibido[]): Veredicto[] {
  const out: Veredicto[] = [];
  for (const lote of lotes) {
    const ingeridos = parseUsageRecords(structuredClone(lote.registros), "org-e6") as unknown as Record<string, unknown>[];
    ingeridos.forEach((r, i) => {
      const emitido = lote.registros[i]!;
      let basis = String(r["basis"] ?? "");
      if (basis === "reference" && !versionAdmiteReferencia(lote.version)) basis = "estimated";
      const ahorroUsd = Number(r["baselineCost"] ?? 0) - Number(r["actualCost"] ?? 0);
      const enLaBase =
        (basis === "measured" && ahorroUsd > 0) || (basis === "reference" && COMISIONAR_REFERENCIA && ahorroUsd > 0);
      out.push({
        requestId: String(r["requestId"]),
        cacheResult: String(r["cacheResult"]),
        basisEmitido: String(emitido["basis"] ?? ""),
        basisIngerido: basis,
        enLaBase,
        ahorroUsd,
      });
    });
  }
  return out;
}

// ── El doble de LiteLLM ────────────────────────────────────────────────────

/**
 * `repr()` de Python para un float, que es como LiteLLM escribe su coste en la
 * cabecera (`1.14e-05`, `3.9999999999999996e-05`, `0.0`). Los dígitos son los
 * mismos que los de JavaScript (los dos dan el más corto que vuelve al mismo
 * double); cambia la forma: Python pasa a notación científica por debajo de
 * 1e-4 o desde 1e16, con el exponente a dos cifras, y un entero lleva `.0`.
 */
export function reprPython(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(x);
  if (abs < 1e-4 || abs >= 1e16) {
    const [mantisa, exp] = x.toExponential().split("e") as [string, string];
    const signo = exp.startsWith("-") ? "-" : "+";
    const cifras = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantisa}e${signo}${cifras}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Un modelo de la `model_list` del doble: alias → modelo del upstream. */
export interface ModeloDelDoble {
  /** `litellm_params.model`: `openai/gpt-4o-mini`, `anthropic/claude-haiku-4-5`. */
  modelo: string;
  /** Precio por TOKEN que LiteLLM le pone (su tabla, no la nuestra). */
  entradaPorToken: number;
  salidaPorToken: number;
}

/**
 * La `model_list` de `litellm.yaml`, con los precios que LiteLLM 1.102.1 trae
 * en su tabla local (`model_prices_and_context_window_backup.json`):
 * gpt-4o-mini 0,15/0,60 $ por 1M y claude-haiku-4-5 1/5 $ por 1M. El test
 * comprueba que los alias coinciden con el YAML.
 */
export const MODELOS_DE_LA_RECETA: Readonly<Record<string, ModeloDelDoble>> = {
  "gpt-4o-mini": { modelo: "openai/gpt-4o-mini", entradaPorToken: 1.5e-7, salidaPorToken: 6e-7 },
  "equipo-rapido": { modelo: "openai/gpt-4o-mini", entradaPorToken: 1.5e-7, salidaPorToken: 6e-7 },
  "claude-haiku-4-5": { modelo: "anthropic/claude-haiku-4-5", entradaPorToken: 1e-6, salidaPorToken: 5e-6 },
};

export interface OpcionesDelDoble {
  /** Origen del upstream (el falso del banco): `http://127.0.0.1:<puerto>`. */
  upstream: string;
  modelos?: Readonly<Record<string, ModeloDelDoble>>;
  /** `litellm_settings.cache: true` con `type: local`. */
  cache?: boolean;
}

export interface DobleDeLiteLLM {
  origen: string;
  /** Peticiones que el doble reenvió al upstream (un acierto de su caché no cuenta). */
  reenviadas(): number;
  cerrar(): Promise<void>;
}

/** Orden de claves de un objeto, como lo deja LiteLLM al reserializar. */
function ordenar(o: Record<string, unknown>, claves: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of claves) if (k in o) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
  return out;
}

/**
 * La respuesta de Chat Completions tal como la devuelve LiteLLM 1.102.1
 * (observado el 2026-09-27): `model` pasa a ser el ALIAS del proxy, cada
 * `message` gana `provider_specific_fields: { refusal: null }` y cada `choice`
 * `provider_specific_fields: {}`, `logprobs: null` desaparece, y el `usage` se
 * reordena (completion, prompt, total, detalles).
 */
export function respuestaDeChatComoLiteLLM(upstream: Record<string, unknown>, alias: string): Record<string, unknown> {
  const choices = Array.isArray(upstream["choices"]) ? (upstream["choices"] as Record<string, unknown>[]) : [];
  const uso = (upstream["usage"] ?? {}) as Record<string, unknown>;
  return ordenar(
    {
      ...upstream,
      model: alias,
      choices: choices.map((c) => {
        const { logprobs: _logprobs, ...resto } = c;
        const msg = (c["message"] ?? {}) as Record<string, unknown>;
        return ordenar(
          {
            ...resto,
            message: ordenar({ ...msg, provider_specific_fields: { refusal: null } }, ["content", "role"]),
            provider_specific_fields: {},
          },
          ["finish_reason", "index", "message", "provider_specific_fields"],
        );
      }),
      usage: ordenar(uso, ["completion_tokens", "prompt_tokens", "total_tokens"]),
    },
    ["id", "created", "model", "object", "system_fingerprint", "choices", "usage"],
  );
}

/**
 * Un proxy que se porta como LiteLLM 1.102.1 delante del upstream falso, en lo
 * que ven el SDK y el gateway: `POST /v1/chat/completions` (y
 * `/chat/completions`) y `POST /v1/messages`, sin stream. No es LiteLLM: no
 * enruta, no reintenta, no autentica ni lleva presupuestos. Lo que sí copia es
 * lo que cambia una cuenta: el alias en la respuesta, las cabeceras de coste
 * (calculadas con SU tabla de precios) y la caché local, que en un acierto no
 * llama al upstream, devuelve el mismo cuerpo con el `usage` original y repite
 * la cabecera de coste, con `x-litellm-cache-key` como única señal.
 */
export async function arrancarDobleDeLiteLLM(opts: OpcionesDelDoble): Promise<DobleDeLiteLLM> {
  const modelos = opts.modelos ?? MODELOS_DE_LA_RECETA;
  let reenviadas = 0;
  let gastoDeLaClave = 0;
  const cache = new Map<string, { cuerpo: string; coste: CosteLiteLLM }>();

  const s = createServer(async (req, res) => {
    try {
      const crudo = await leerCuerpo(req);
      const ruta = (req.url ?? "/").split("?")[0]!;
      const esChat = ruta === "/v1/chat/completions" || ruta === "/chat/completions";
      const esMessages = ruta === "/v1/messages";
      if (req.method === "GET" && ruta === "/health/liveliness") return responder(res, 200, {}, JSON.stringify("I'm alive!"));
      if (req.method !== "POST" || (!esChat && !esMessages)) {
        return responder(res, 404, {}, JSON.stringify({ detail: "Not Found" }));
      }
      const peticion = JSON.parse(crudo.toString("utf8")) as Record<string, unknown>;
      const alias = String(peticion["model"] ?? "");
      const m = modelos[alias];
      if (!m) {
        return responder(res, 400, {}, JSON.stringify({ error: { message: `Invalid model name passed in model=${alias}`, type: "None", param: "None", code: "400" } }));
      }
      if (peticion["stream"] === true) {
        return responder(res, 400, {}, JSON.stringify({ error: { message: "el doble de LiteLLM no sirve stream" } }));
      }
      const idUpstream = m.modelo.replace(/^[^/]+\//, "");
      const claveCache = createHash("sha256").update(`${ruta}\n${alias}\n${JSON.stringify(peticion)}`).digest("hex");
      const acierto = opts.cache ? cache.get(claveCache) : undefined;

      let cuerpo: string;
      let coste: CosteLiteLLM;
      if (acierto) {
        ({ cuerpo, coste } = acierto);
      } else {
        const saliente = esMessages ? { ...peticion, model: idUpstream, stream: false } : { ...peticion, model: idUpstream };
        const destino = esMessages ? `${opts.upstream}/v1/messages` : `${opts.upstream}/v1/chat/completions`;
        reenviadas += 1;
        const r = await fetch(destino, {
          method: "POST",
          headers: esMessages
            ? { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "relleno" }
            : { "content-type": "application/json", authorization: "Bearer relleno" },
          body: JSON.stringify(saliente),
        });
        const texto = await r.text();
        if (!r.ok) return responder(res, r.status, {}, texto);
        const json = JSON.parse(texto) as Record<string, unknown>;
        const uso = (json["usage"] ?? {}) as Record<string, number>;
        const entrada = esMessages ? Number(uso["input_tokens"] ?? 0) : Number(uso["prompt_tokens"] ?? 0);
        const salida = esMessages ? Number(uso["output_tokens"] ?? 0) : Number(uso["completion_tokens"] ?? 0);
        coste = { entrada: entrada * m.entradaPorToken, salida: salida * m.salidaPorToken };
        cuerpo = JSON.stringify(esMessages ? { ...json, model: alias } : respuestaDeChatComoLiteLLM(json, alias));
        if (opts.cache) cache.set(claveCache, { cuerpo, coste });
      }
      gastoDeLaClave += coste.entrada + coste.salida;
      const cabeceras = cabecerasComoLiteLLM({
        alias,
        modelo: m.modelo,
        apiBase: esChat ? `${opts.upstream}/v1` : undefined,
        coste,
        gastoDeLaClave,
        ...(acierto ? { claveCache } : {}),
        largo: Buffer.byteLength(cuerpo),
      });
      return responder(res, 200, cabeceras, cuerpo);
    } catch (e) {
      if (!res.headersSent) responder(res, 500, {}, JSON.stringify({ error: { message: String(e) } }));
      else res.destroy();
    }
  });
  const puerto = await escuchar(s);
  return {
    origen: `http://127.0.0.1:${puerto}`,
    reenviadas: () => reenviadas,
    cerrar: () => cerrarServidor(s),
  };
}

interface CosteLiteLLM {
  entrada: number;
  salida: number;
}

function responder(res: ServerResponse, estado: number, cabeceras: Record<string, string>, cuerpo: string): void {
  res.writeHead(estado, { "content-type": "application/json", "content-length": String(Buffer.byteLength(cuerpo)), ...cabeceras });
  res.end(cuerpo);
}

/**
 * Las cabeceras `x-litellm-*` de una respuesta de LiteLLM 1.102.1, en su orden.
 * La ruta de Chat Completions añade además `x-litellm-model-api-base` y
 * `x-litellm-callback-duration-ms`; la de Messages no (observado). Las
 * `llm_provider-*` (cabeceras del upstream reenviadas) no se imitan: dependen
 * del upstream, no de LiteLLM.
 */
export function cabecerasComoLiteLLM(o: {
  alias: string;
  modelo: string;
  apiBase: string | undefined;
  coste: CosteLiteLLM;
  gastoDeLaClave: number;
  claveCache?: string;
  largo: number;
}): Record<string, string> {
  const total = o.coste.entrada + o.coste.salida;
  const h: Record<string, string> = {
    "x-litellm-call-id": randomUUID(),
    "x-litellm-model-id": createHash("sha256").update(`${o.alias}:${o.modelo}`).digest("hex"),
    "x-litellm-model-name": o.modelo,
  };
  if (o.claveCache) h["x-litellm-cache-key"] = o.claveCache;
  if (o.apiBase) h["x-litellm-model-api-base"] = o.apiBase;
  Object.assign(h, {
    "x-litellm-version": VERSION_LITELLM,
    "x-litellm-response-cost": reprPython(total),
    "x-litellm-response-cost-original": reprPython(total),
    "x-litellm-response-cost-discount-amount": "0.0",
    "x-litellm-response-cost-margin-amount": "0.0",
    "x-litellm-response-cost-margin-percent": "0.0",
    "x-litellm-response-cost-input": reprPython(o.coste.entrada),
    "x-litellm-response-cost-output": reprPython(o.coste.salida),
    "x-litellm-response-cost-tool-usage": "0.0",
    "x-litellm-key-spend": reprPython(o.gastoDeLaClave),
    "x-litellm-response-duration-ms": "1.0",
    "x-litellm-overhead-duration-ms": "0.5",
  });
  if (o.apiBase) h["x-litellm-callback-duration-ms"] = "0.0";
  Object.assign(h, {
    "x-litellm-model-group": o.alias,
    "x-litellm-attempted-retries": "0",
    "x-litellm-attempted-fallbacks": "0",
  });
  return h;
}

// ── El SDK delante del proxy ───────────────────────────────────────────────

export interface OpcionesDeRepeticion {
  protocolo: "openai" | "anthropic";
  /**
   * La base del proveedor del SDK: `http://127.0.0.1:4000/v1` en los dos
   * protocolos (el adaptador de Anthropic añade `/messages`, el compatible
   * con OpenAI `/chat/completions`).
   */
  base: string;
  /** El id que manda el SDK: `openai/gpt-4o-mini`, `equipo-rapido`… */
  modelo: string;
  /** Precios propios del cliente (`costModels`), si los declara. */
  costModels?: Record<string, CostModel>;
  /** `temperature` de la petición; 0 por defecto (salida acreditable). */
  temperatura?: number;
  /**
   * Cuántas CAPAS hacen la misma petición, una tras otra (1 por defecto: la
   * misma capa la repite). Con 2, la segunda es otro proceso —otra instancia de
   * la aplicación— que no comparte la caché exacta en memoria de la primera.
   */
  capas?: 1 | 2;
}

export interface InformeResumido {
  requestId: string;
  basis: string;
  cacheResult: string;
  actualUsd: number;
  baselineUsd: number;
  referenceRequestId?: string;
  referenceRejected?: string;
  /**
   * Por qué ESTA llamada, si corrió, no dejó registro de referencia (la traza
   * `reference` · `not-written`): `unofficial-origin` detrás del proxy.
   */
  referenceNotWritten?: string;
}

export interface ResultadoDeRepeticion {
  primera: InformeResumido;
  segunda: InformeResumido;
  /** Las cabeceras `x-litellm-*` de cada respuesta que el proveedor del SDK recibió. */
  cabecerasDelProxy: Record<string, string>[];
  lotes: LoteRecibido[];
  veredictos: Veredicto[];
}

function resumen(r: SavingsReport): InformeResumido {
  const cache = r.cache as SavingsReport["cache"] & { reference?: { requestId: string }; referenceRejected?: string };
  const sinRegistro = r.traces.find((t) => t.stage === "reference" && t.outcome === "not-written")?.detail?.["reason"];
  return {
    requestId: r.requestId,
    basis: String(r.cost.basis),
    cacheResult: String(r.cache.result),
    actualUsd: r.cost.actual,
    baselineUsd: r.cost.baselineEstimate,
    ...(cache.reference ? { referenceRequestId: cache.reference.requestId } : {}),
    ...(cache.referenceRejected ? { referenceRejected: cache.referenceRejected } : {}),
    ...(typeof sinRegistro === "string" ? { referenceNotWritten: sinRegistro } : {}),
  };
}

/**
 * El SDK (desde el fuente, sin licencia: `devUnlicensed`) con su proveedor
 * apuntando al proxy, la MISMA petición dos veces y la medición encendida
 * contra una ingesta falsa local. Devuelve los dos informes, las cabeceras que
 * mandó el proxy y lo que el servidor haría con cada registro.
 */
export async function repetirConElSdk(o: OpcionesDeRepeticion): Promise<ResultadoDeRepeticion> {
  const ingesta = await arrancarIngestaFalsa();
  const cabecerasDelProxy: Record<string, string>[] = [];
  const fetchQueMira = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = await fetch(url, init);
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k.startsWith("x-litellm-")) h[k] = v;
    });
    cabecerasDelProxy.push(h);
    return r;
  }) as typeof fetch;

  const nuevaCapa = () => {
    const provider =
      o.protocolo === "openai"
        ? new OpenAICompatibleProvider({ baseUrl: o.base, apiKey: CLAVE_DEL_PROXY, stripProviderPrefix: true, fetchImpl: fetchQueMira })
        : new AnthropicProvider({ baseUrl: o.base, apiKey: CLAVE_DEL_PROXY, stripProviderPrefix: true, fetchImpl: fetchQueMira });
    return createSavingsLayer({
      provider,
      devUnlicensed: true,
      silenceWarnings: true,
      ...(o.costModels ? { costModels: o.costModels } : {}),
      serviceAccountKey: CLAVE_DE_RELLENO,
      meteringUrl: `${ingesta.origen}/api/metering/usage`,
      metering: { seatId: "asiento-e6", ci: false, flushIntervalMs: 50 },
    });
  };

  const peticion = {
    model: o.modelo,
    messages: [{ role: "user" as const, content: "What is the capital of France? Answer in one word." }],
    temperature: o.temperatura ?? 0,
  };
  const capas = o.capas === 2 ? [nuevaCapa(), nuevaCapa()] : [nuevaCapa()];
  try {
    const primera = await capas[0]!.generate(peticion);
    const segunda = await capas[capas.length - 1]!.generate(peticion);
    for (const c of capas) c.close();
    await esperarA(() => ingesta.registros().length >= 2);
    return {
      primera: resumen(primera.report),
      segunda: resumen(segunda.report),
      cabecerasDelProxy,
      lotes: ingesta.lotes,
      veredictos: veredictoDeComision(ingesta.lotes),
    };
  } finally {
    for (const c of capas) c.close();
    await ingesta.cerrar();
  }
}

// ── El gateway delante del proxy ───────────────────────────────────────────

export interface ResultadoDelGateway {
  estados: number[];
  lineas: string[];
  lotes: LoteRecibido[];
  veredictos: Veredicto[];
}

/**
 * El gateway de BV-SALA (desde el fuente, con la licencia efímera de los
 * tests) con `upstream` = el proxy y la coalescencia encendida: dos peticiones
 * de Chat Completions IDÉNTICAS, la segunda cuando la primera ya está en vuelo
 * (el upstream tiene que tardar más de `separacionMs`). La gemela no llama a
 * nadie; su valoración y su motivo salen en la línea de log.
 */
export async function coalescerConElGateway(o: { upstream: string; separacionMs?: number }): Promise<ResultadoDelGateway> {
  const ingesta = await arrancarIngestaFalsa();
  const lineas: string[] = [];
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: o.upstream,
    coalescer: true,
    serviceAccountKey: CLAVE_DE_RELLENO,
    meteringUrl: `${ingesta.origen}/api/metering/usage`,
    seatId: "asiento-e6",
    log: (l) => lineas.push(l),
    warn: () => {},
  });
  const cuerpo = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France? Answer in one word." }],
    temperature: 0,
  });
  const pedir = () =>
    fetch(`http://127.0.0.1:${gw.puerto}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLAVE_DEL_PROXY}` },
      body: cuerpo,
    }).then(async (r) => {
      await r.text();
      return r.status;
    });
  try {
    const p1 = pedir();
    await new Promise((r) => setTimeout(r, o.separacionMs ?? 60));
    const p2 = pedir();
    const estados = await Promise.all([p1, p2]);
    await gw.cerrar();
    await esperarA(() => ingesta.registros().length >= 2);
    return { estados, lineas, lotes: ingesta.lotes, veredictos: veredictoDeComision(ingesta.lotes) };
  } finally {
    await gw.cerrar().catch(() => {});
    await ingesta.cerrar();
  }
}

/**
 * El gateway con la palanca de TTL armada (licencia de prueba + la feature
 * `cache_ttl_tuning` servida por el canal de entitlements) y `upstream` = el
 * proxy: una petición de Messages con `cache_control` a 1 h. La palanca la
 * rebaja a 5 min y, si el proveedor declara escrituras de caché, acredita la
 * diferencia de prima a precio de lista como ahorro `measured`.
 *
 * Devuelve también lo que el upstream recibió, para ver si el TTL rebajado
 * llegó hasta él a través del proxy.
 */
export async function rebajarTtlConElGateway(o: { upstream: string }): Promise<ResultadoDelGateway> {
  const ingesta = await arrancarIngestaFalsa(["cache_ttl_tuning"]);
  const lineas: string[] = [];
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: o.upstream,
    serviceAccountKey: CLAVE_DE_RELLENO,
    meteringUrl: `${ingesta.origen}/api/metering/usage`,
    seatId: "asiento-e6",
    log: (l) => lineas.push(l),
    warn: () => {},
  });
  try {
    // El canal de entitlements refresca al arrancar: se espera a que asiente.
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": CLAVE_DEL_PROXY },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: "What is the capital of France? Answer in one word." }],
      }),
    });
    await r.text();
    await gw.cerrar();
    await esperarA(() => ingesta.registros().length >= 1);
    return { estados: [r.status], lineas, lotes: ingesta.lotes, veredictos: veredictoDeComision(ingesta.lotes) };
  } finally {
    await gw.cerrar().catch(() => {});
    await ingesta.cerrar();
  }
}
