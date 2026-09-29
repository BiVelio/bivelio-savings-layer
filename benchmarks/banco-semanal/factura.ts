/**
 * EL BANCO SEMANAL · EL CUADRE CONTRA LA FACTURA REAL DEL PROVEEDOR.
 * ---------------------------------------------------------------------------
 * Criterio 4 de docs/CAMINO-A-0.5.md: «el informe cuadra con la factura ±2 %,
 * con el ahorro nativo aparte». La regla `informe-vs-factura` compara el
 * informe de la capa con `usage × precio de lista`, o sea, con el MISMO
 * catálogo que usa la capa: un precio mal puesto en el catálogo no lo vería.
 * Aquí se lee lo que el proveedor COBRA, con su propia API de costes, y se
 * compara con lo que el banco midió en la tirada.
 *
 * QUÉ SE COMPARA, por proveedor:
 *   esperado  = Σ `gastoUsd` de las celdas que ese proveedor factura directo
 *               (brazo A + brazo B + los demás brazos y repeticiones de cada
 *               arnés, contados con los contadores de `usage` del proveedor),
 *               + el juez de MT-Bench SOLO si va directo a ese proveedor (por
 *               defecto va por ai-gateway.vercel.sh, y ese lo factura Vercel).
 *   facturado = el coste que devuelve la API de costes para el workspace o
 *               proyecto dedicado al banco, en los días UTC de la tirada.
 *   ±2 % sobre lo facturado (la tolerancia de CAMINO, la misma
 *   `fueraDeTolerancia` de umbrales.ts).
 *
 * EL AHORRO NATIVO, APARTE. El descuento de la caché de prefijo del proveedor
 * ya está DENTRO de la factura (los tokens leídos de caché se cobran a su
 * tarifa) y dentro de lo medido (los arneses los tarifan igual). No se suma ni
 * se resta en ningún lado: ni `report.nativeSavings` ni ahorro de la capa
 * entran en el cuadre. Lo que la factura cobró por la caché del proveedor
 * (lecturas y escrituras, por `token_type` o `line_item`) se muestra en una
 * línea propia, para que se vea que ese dinero es del proveedor y no de la capa.
 *
 * LAS APIs (consultadas el 2026-09-29):
 *   Anthropic · Usage & Cost Admin API, clave de administrador `sk-ant-admin…`
 *     https://platform.claude.com/docs/en/manage-claude/usage-cost-api
 *     GET /v1/organizations/cost_report — SOLO `bucket_width=1d`, `amount` en
 *       CÉNTIMOS como cadena decimal, sin filtro por workspace (se agrupa con
 *       `group_by[]=workspace_id` y se elige el del banco), `limit` ≤ 31.
 *       https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve
 *     GET /v1/organizations/usage_report/messages — `1m`/`1h`/`1d`, filtra por
 *       `workspace_ids[]` y `api_key_ids[]`, `limit` ≤ 1440 con `1m`.
 *       https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages
 *     «Usage and cost data typically appears within 5 minutes of API request
 *     completion, though delays may occasionally be longer.»
 *   OpenAI · Costs y Usage API, clave de administrador de la organización
 *     https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
 *     GET /v1/organization/costs — SOLO `bucket_width=1d`, `start_time`/`end_time`
 *       en segundos Unix (fin exclusivo), filtra por `project_ids[]` y
 *       `api_key_ids[]`, `amount.value` en DÓLARES, `limit` ≤ 180.
 *     https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
 *     GET /v1/organization/usage/completions — `1m`/`1h`/`1d`, mismos filtros,
 *       `limit` ≤ 1440 con `1m`. OpenAI no publica el retraso de estos datos.
 *
 * EL RETRASO, Y POR QUÉ EL CUADRE ES EN DOS FASES. Las dos APIs de COSTE solo
 * dan días enteros, y los datos llegan con retraso (minutos en Anthropic, sin
 * cifra publicada en OpenAI). Pero la factura de un workspace dedicado SOLO
 * CRECE mientras llegan datos. Eso da una regla sin ambigüedad:
 *   - facturado dentro de ±2 %      → `cuadra`.
 *   - facturado POR ENCIMA del 2 %  → `no-cuadra` ya: el retraso no puede
 *                                     inflar una factura.
 *   - facturado POR DEBAJO          → puede ser retraso: se reintenta cada
 *                                     `BANCO_FACTURA_INTERVALO_S` hasta
 *                                     `BANCO_FACTURA_ESPERA_MIN` (fase 1, en
 *                                     la misma tirada). Si se agota, queda
 *                                     `pendiente` (un aviso) y se escribe en
 *                                     `resultados.json`.
 * Fase 2: la tirada SIGUIENTE (`--previa` con el artefacto de la anterior)
 * vuelve a leer los pendientes. Para entonces el día ya cerró hace días
 * (`definitivo`) y lo que siga por debajo es `no-cuadra`: la tirada N+1 falla y
 * la puerta de publish.yml cierra. Se eligió así, y no un job aparte que espere
 * a medianoche, porque la puerta solo mira el último run «(vivo)» de este
 * workflow: un segundo workflow no la cerraría sin tocar puerta.ts, y esperar
 * horas dentro del job chocaría con su límite de 360 min.
 *
 * TRÁFICO AJENO. El coste es por día y por workspace/proyecto: si otro tráfico
 * cae en esos días, la factura no es la del banco. Se comprueba con el API de
 * USO por minuto: uso fuera de [inicio, fin] de la tirada, o de otra clave que
 * la del banco (si se declara su id), hace el cuadre `no-comprobable` (aviso,
 * no falla: no se puede afirmar nada, ni bueno ni malo). Relanzar el banco en
 * vivo el MISMO día UTC lo provoca, y está documentado.
 *
 * SIN CLAVE DE ADMINISTRADOR, «factura real no comprobada (sin clave de
 * administrador)»: un aviso, y el banco no falla. Mismo criterio que las
 * claves normales. La clave no sale de aquí: solo va en la cabecera, y ningún
 * texto que se escribe la incluye.
 */
import { MODELOS_DEL_BANCO } from "./plan.js";
import { configDesdeEntorno } from "../modelos.js";
import { endpointDeModelo } from "../transporte.js";
import { fueraDeTolerancia, type ResultadoDeCelda } from "./umbrales.js";

export type ProveedorFacturado = "anthropic" | "openai";
export const PROVEEDORES_FACTURADOS: readonly ProveedorFacturado[] = ["anthropic", "openai"];

/** Los hosts cuyo gasto factura cada proveedor directamente. */
const HOST_DEL_PROVEEDOR: Readonly<Record<ProveedorFacturado, string>> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/** Nombres de las variables (docs/BANCO-SEMANAL.md). Las claves son secretos; los ids, no. */
export const VARIABLES_DE_FACTURA = {
  anthropic: { clave: "ANTHROPIC_ADMIN_API_KEY", workspace: "BANCO_ANTHROPIC_WORKSPACE_ID", claveId: "BANCO_ANTHROPIC_API_KEY_ID" },
  openai: { clave: "OPENAI_ADMIN_API_KEY", proyecto: "BANCO_OPENAI_PROJECT_ID", claveId: "BANCO_OPENAI_API_KEY_ID" },
} as const;

export const ESPERA_POR_DEFECTO_MIN = 20;
export const INTERVALO_POR_DEFECTO_S = 300;
/** Minutos de holgura alrededor de [inicio, fin] al buscar tráfico ajeno (el API fecha por minuto). */
export const HOLGURA_DE_VENTANA_MIN = 2;
/** Desde cuándo la factura de un día se da por cerrada: 24 h después de terminar el día UTC. */
export const CIERRE_DEL_DIA_MS = 24 * 3600_000;

const DIA_MS = 24 * 3600_000;
const MIN_MS = 60_000;

export interface Ventana {
  /** ISO: cuando el orquestador empezó a lanzar celdas. */
  inicio: string;
  /** ISO: cuando terminó la última celda. */
  fin: string;
}

// ── Lo que el banco midió, por proveedor ────────────────────────────────────

export interface GastoEsperado {
  proveedor: ProveedorFacturado;
  esperadoUsd: number;
  celdas: number;
  /** El juez de MT-Bench sumado aquí (solo si va directo a este proveedor). */
  juezUsd: number;
  /** Celdas de este proveedor que murieron sin artefacto: su gasto real no se conoce. */
  desconocidas: string[];
}

function hostDe(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A qué proveedor le factura su endpoint una celda de este modelo (o null: pasarela, Google, mock). */
export function proveedorQueFactura(modeloId: string, env: NodeJS.ProcessEnv): ProveedorFacturado | null {
  const e = endpointDeModelo(modeloId, configDesdeEntorno(env));
  if (!e || e.transporte === "mock" || !e.host) return null;
  return PROVEEDORES_FACTURADOS.find((p) => HOST_DEL_PROVEEDOR[p] === e.host) ?? null;
}

/** El juez de MT-Bench: por defecto ai-gateway.vercel.sh (lo factura Vercel, no entra en ninguna factura de aquí). */
export function proveedorDelJuez(env: NodeJS.ProcessEnv): ProveedorFacturado | null {
  const h = hostDe(env["BVSALA_JUDGE_BASE_URL"]);
  return PROVEEDORES_FACTURADOS.find((p) => HOST_DEL_PROVEEDOR[p] === h) ?? null;
}

export function gastoEsperado(resultados: readonly ResultadoDeCelda[], env: NodeJS.ProcessEnv): Record<ProveedorFacturado, GastoEsperado> {
  const out = Object.fromEntries(
    PROVEEDORES_FACTURADOS.map((p) => [p, { proveedor: p, esperadoUsd: 0, celdas: 0, juezUsd: 0, desconocidas: [] as string[] }]),
  ) as Record<ProveedorFacturado, GastoEsperado>;
  const juez = proveedorDelJuez(env);
  for (const r of resultados) {
    if (!MODELOS_DEL_BANCO.some((m) => m.id === r.modelo)) continue;
    const p = proveedorQueFactura(r.modelo, env);
    if (r.estado === "arnes-falla") {
      if (p) out[p].desconocidas.push(`${r.bateria}/${r.modelo}`);
      continue;
    }
    if (r.estado !== "medida") continue;
    const jz = r.medicion.gastoJuezUsd ?? 0;
    if (p) {
      out[p].esperadoUsd += r.medicion.gastoUsd - jz;
      out[p].celdas += 1;
    }
    if (juez && jz > 0) {
      out[juez].esperadoUsd += jz;
      out[juez].juezUsd += jz;
    }
  }
  return out;
}

// ── La ventana en días UTC ──────────────────────────────────────────────────

/** [primer día, día siguiente al último) en ms UTC: lo que cubren los buckets diarios de coste. */
export function diasDeLaVentana(v: Ventana): { desde: number; hasta: number } {
  const i = Date.parse(v.inicio);
  const f = Date.parse(v.fin);
  const desde = Math.floor(i / DIA_MS) * DIA_MS;
  const hasta = Math.floor(f / DIA_MS) * DIA_MS + DIA_MS;
  return { desde, hasta };
}

/** La factura de esos días ya no se mueve (se da por cerrada). */
export function facturaCerrada(v: Ventana, ahora: number): boolean {
  return ahora >= diasDeLaVentana(v).hasta + CIERRE_DEL_DIA_MS;
}

// ── Lectura de las APIs ─────────────────────────────────────────────────────

export interface LecturaDeFactura {
  facturadoUsd: number;
  /** Lo que la factura cobró por la caché de prefijo del proveedor (lecturas + escrituras). Aparte: no es de la capa. */
  cacheDelProveedorUsd: number;
  /** null si no hay tráfico ajeno; si lo hay, qué se vio. */
  ajeno: string | null;
}

export class ErrorDeFactura extends Error {}

type J = Record<string, unknown>;

async function pedir(f: typeof fetch, url: string, headers: Record<string, string>): Promise<J> {
  let r: Response;
  try {
    r = await f(url, { headers, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new ErrorDeFactura(`sin respuesta de ${new URL(url).host}: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!r.ok) {
    const cuerpo = (await r.json().catch(() => ({}))) as { error?: { type?: string; code?: string } };
    // Solo el estado y el TIPO de error: nunca el cuerpo entero (podría citar la cabecera).
    const tipo = cuerpo.error?.type ?? cuerpo.error?.code ?? "";
    throw new ErrorDeFactura(`${new URL(url).host}${new URL(url).pathname} respondió HTTP ${r.status}${tipo ? ` ${tipo}` : ""}`);
  }
  return (await r.json()) as J;
}

/** Recorre todas las páginas (`has_more` + `next_page`) y devuelve los buckets. */
async function todasLasPaginas(f: typeof fetch, base: string, params: [string, string][], headers: Record<string, string>): Promise<J[]> {
  const buckets: J[] = [];
  let page: string | null = null;
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams(params);
    if (page) q.set("page", page);
    const cuerpo = await pedir(f, `${base}?${q.toString()}`, headers);
    const data = cuerpo["data"];
    if (!Array.isArray(data)) throw new ErrorDeFactura(`${new URL(base).pathname}: la respuesta no trae \`data\` (¿cambió la forma del API?)`);
    buckets.push(...(data as J[]));
    if (cuerpo["has_more"] !== true) return buckets;
    page = typeof cuerpo["next_page"] === "string" ? cuerpo["next_page"] : null;
    if (!page) throw new ErrorDeFactura(`${new URL(base).pathname}: has_more sin next_page`);
  }
  throw new ErrorDeFactura(`${new URL(base).pathname}: más de 100 páginas`);
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const resultados = (b: J): J[] => (Array.isArray(b["results"]) ? (b["results"] as J[]) : []);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** El minuto de un bucket está dentro de la tirada (con holgura). */
function dentro(msBucket: number, v: Ventana): boolean {
  const i = Math.floor(Date.parse(v.inicio) / MIN_MS) * MIN_MS - HOLGURA_DE_VENTANA_MIN * MIN_MS;
  const f = Math.floor(Date.parse(v.fin) / MIN_MS) * MIN_MS + HOLGURA_DE_VENTANA_MIN * MIN_MS;
  return msBucket >= i && msBucket <= f;
}

function describirAjeno(fuera: number, otraClave: Set<string>): string | null {
  const partes: string[] = [];
  if (fuera > 0) partes.push(`${fuera} minutos con uso fuera de la tirada en los mismos días`);
  if (otraClave.size) partes.push(`uso de otras claves (${[...otraClave].slice(0, 3).join(", ")})`);
  return partes.length ? partes.join("; ") : null;
}

export interface ConfigAnthropic {
  claveAdmin: string;
  workspaceId: string;
  apiKeyId?: string;
}

const ANTHROPIC_ADMIN = "https://api.anthropic.com/v1/organizations";

export async function leerFacturaAnthropic(c: ConfigAnthropic, v: Ventana, f: typeof fetch): Promise<LecturaDeFactura> {
  const headers = { "x-api-key": c.claveAdmin, "anthropic-version": "2023-06-01", "user-agent": "bivelio-banco-semanal" };
  const { desde, hasta } = diasDeLaVentana(v);
  const dias = Math.round((hasta - desde) / DIA_MS);
  // Coste: por día, agrupado por workspace (el API no filtra por workspace) y por descripción (para la caché aparte).
  const coste = await todasLasPaginas(
    f,
    `${ANTHROPIC_ADMIN}/cost_report`,
    [
      ["starting_at", iso(desde)],
      ["ending_at", iso(hasta)],
      ["bucket_width", "1d"],
      ["group_by[]", "workspace_id"],
      ["group_by[]", "description"],
      ["limit", String(Math.min(31, dias))],
    ],
    headers,
  );
  let centimos = 0;
  let centimosCache = 0;
  for (const b of coste) {
    const ini = Date.parse(String(b["starting_at"]));
    if (!(ini >= desde && ini < hasta)) continue;
    for (const r of resultados(b)) {
      if (r["workspace_id"] !== c.workspaceId) continue;
      if (r["currency"] !== undefined && r["currency"] !== "USD") throw new ErrorDeFactura(`cost_report en ${String(r["currency"])}, no en USD`);
      const cts = Number(r["amount"]);
      if (!Number.isFinite(cts)) throw new ErrorDeFactura("cost_report: `amount` no es un número");
      centimos += cts;
      if (typeof r["token_type"] === "string" && r["token_type"].startsWith("cache")) centimosCache += cts;
    }
  }
  // Uso por minuto del workspace, por clave: ¿hay algo que no sea esta tirada?
  const uso = await todasLasPaginas(
    f,
    `${ANTHROPIC_ADMIN}/usage_report/messages`,
    [
      ["starting_at", iso(desde)],
      ["ending_at", iso(hasta)],
      ["bucket_width", "1m"],
      ["workspace_ids[]", c.workspaceId],
      ["group_by[]", "api_key_id"],
      ["limit", "1440"],
    ],
    headers,
  );
  let fuera = 0;
  const otraClave = new Set<string>();
  for (const b of uso) {
    const ini = Date.parse(String(b["starting_at"]));
    let hubo = false;
    for (const r of resultados(b)) {
      const cc = (r["cache_creation"] ?? {}) as J;
      const tokens =
        num(r["uncached_input_tokens"]) + num(r["cache_read_input_tokens"]) + num(r["output_tokens"]) + num(cc["ephemeral_5m_input_tokens"]) + num(cc["ephemeral_1h_input_tokens"]);
      if (tokens <= 0) continue;
      hubo = true;
      if (c.apiKeyId && r["api_key_id"] !== c.apiKeyId) otraClave.add(String(r["api_key_id"] ?? "consola"));
    }
    if (hubo && !dentro(ini, v)) fuera++;
  }
  return { facturadoUsd: centimos / 100, cacheDelProveedorUsd: centimosCache / 100, ajeno: describirAjeno(fuera, otraClave) };
}

export interface ConfigOpenAI {
  claveAdmin: string;
  projectId?: string;
  apiKeyId?: string;
}

const OPENAI_ORG = "https://api.openai.com/v1/organization";

export async function leerFacturaOpenAI(c: ConfigOpenAI, v: Ventana, f: typeof fetch): Promise<LecturaDeFactura> {
  if (!c.projectId && !c.apiKeyId) throw new ErrorDeFactura("sin proyecto ni clave del banco para filtrar");
  const headers = { authorization: `Bearer ${c.claveAdmin}` };
  const { desde, hasta } = diasDeLaVentana(v);
  const dias = Math.round((hasta - desde) / DIA_MS);
  const filtros: [string, string][] = [
    ...(c.projectId ? ([["project_ids[]", c.projectId]] as [string, string][]) : []),
    ...(c.apiKeyId ? ([["api_key_ids[]", c.apiKeyId]] as [string, string][]) : []),
  ];
  const coste = await todasLasPaginas(
    f,
    `${OPENAI_ORG}/costs`,
    [
      ["start_time", String(desde / 1000)],
      ["end_time", String(hasta / 1000)],
      ["bucket_width", "1d"],
      ...filtros,
      ["group_by[]", "line_item"],
      ["limit", String(Math.min(180, dias))],
    ],
    headers,
  );
  let usd = 0;
  let cache = 0;
  for (const b of coste) {
    const ini = num(b["start_time"]) * 1000;
    if (!(ini >= desde && ini < hasta)) continue;
    for (const r of resultados(b)) {
      const a = (r["amount"] ?? {}) as J;
      if (a["currency"] !== undefined && String(a["currency"]).toLowerCase() !== "usd") throw new ErrorDeFactura(`costs en ${String(a["currency"])}, no en USD`);
      const valor = num(a["value"]);
      usd += valor;
      if (typeof r["line_item"] === "string" && /cache/i.test(r["line_item"])) cache += valor;
    }
  }
  // Uso por minuto del proyecto (y/o de la clave), agrupado por clave.
  const uso = await todasLasPaginas(
    f,
    `${OPENAI_ORG}/usage/completions`,
    [["start_time", String(desde / 1000)], ["end_time", String(hasta / 1000)], ["bucket_width", "1m"], ...filtros, ["group_by[]", "api_key_id"], ["limit", "1440"]],
    headers,
  );
  let fuera = 0;
  const otraClave = new Set<string>();
  for (const b of uso) {
    const ini = num(b["start_time"]) * 1000;
    let hubo = false;
    for (const r of resultados(b)) {
      if (num(r["num_model_requests"]) + num(r["input_tokens"]) + num(r["output_tokens"]) <= 0) continue;
      hubo = true;
      if (c.apiKeyId && r["api_key_id"] !== c.apiKeyId) otraClave.add(String(r["api_key_id"] ?? "sin clave"));
    }
    if (hubo && !dentro(ini, v)) fuera++;
  }
  return { facturadoUsd: usd, cacheDelProveedorUsd: cache, ajeno: describirAjeno(fuera, otraClave) };
}

// ── El cuadre ───────────────────────────────────────────────────────────────

export type EstadoDelCuadre = "cuadra" | "no-cuadra" | "pendiente" | "sin-clave" | "no-comprobable" | "sin-gasto";

export interface Cuadre {
  proveedor: ProveedorFacturado;
  /** La tirada cuyo gasto se cuadra (la actual, o una anterior que quedó pendiente). */
  runId: string;
  ventana: Ventana;
  estado: EstadoDelCuadre;
  esperadoUsd: number;
  facturadoUsd?: number;
  cacheDelProveedorUsd?: number;
  juezUsd?: number;
  /** Lecturas hechas del API de costes. */
  intentos: number;
  detalle: string;
}

/**
 * La decisión, pura. `definitivo`: la factura de esos días ya no va a crecer
 * (día cerrado), así que quedarse corto también es no cuadrar.
 */
export function decidir(esperadoUsd: number, facturadoUsd: number, definitivo: boolean): "cuadra" | "no-cuadra" | "pendiente" {
  if (!fueraDeTolerancia(esperadoUsd, facturadoUsd)) return "cuadra";
  if (facturadoUsd > esperadoUsd) return "no-cuadra";
  return definitivo ? "no-cuadra" : "pendiente";
}

const usd = (x: number) => `${x.toFixed(4)} $`;

function relativo(esperado: number, facturado: number): string {
  return facturado !== 0 ? ` (${(((esperado - facturado) / facturado) * 100).toFixed(2)} %)` : "";
}

export interface OpcionesDelCuadre {
  runId: string;
  ventana: Ventana;
  resultados: readonly ResultadoDeCelda[];
  env: NodeJS.ProcessEnv;
  /** Los pendientes de la tirada anterior (`cuadresPendientesDe`). */
  previos?: readonly Cuadre[];
  f?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
  log?: (s: string) => void;
}

type Lector = (v: Ventana) => Promise<LecturaDeFactura>;

/** El lector de un proveedor, o por qué no se puede leer (sin clave, sin workspace/proyecto). */
function lectorDe(p: ProveedorFacturado, env: NodeJS.ProcessEnv, f: typeof fetch): Lector | { estado: "sin-clave" | "no-comprobable"; detalle: string } {
  const val = (k: string) => (env[k] ? String(env[k]).trim() : "") || undefined;
  if (p === "anthropic") {
    const n = VARIABLES_DE_FACTURA.anthropic;
    const clave = val(n.clave);
    if (!clave) return { estado: "sin-clave", detalle: `factura real no comprobada (sin clave de administrador: ${n.clave})` };
    const workspaceId = val(n.workspace);
    if (!workspaceId) return { estado: "no-comprobable", detalle: `factura real no comprobada (sin workspace dedicado al banco: ${n.workspace})` };
    const apiKeyId = val(n.claveId);
    return (v) => leerFacturaAnthropic({ claveAdmin: clave, workspaceId, ...(apiKeyId ? { apiKeyId } : {}) }, v, f);
  }
  const n = VARIABLES_DE_FACTURA.openai;
  const clave = val(n.clave);
  if (!clave) return { estado: "sin-clave", detalle: `factura real no comprobada (sin clave de administrador: ${n.clave})` };
  const projectId = val(n.proyecto);
  const apiKeyId = val(n.claveId);
  if (!projectId && !apiKeyId) return { estado: "no-comprobable", detalle: `factura real no comprobada (sin proyecto ni clave dedicados al banco: ${n.proyecto} o ${n.claveId})` };
  return (v) => leerFacturaOpenAI({ claveAdmin: clave, ...(projectId ? { projectId } : {}), ...(apiKeyId ? { apiKeyId } : {}) }, v, f);
}

function minutosDe(env: NodeJS.ProcessEnv, k: string, porDefecto: number): number {
  const n = Number(env[k]);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

/**
 * Lee la factura hasta que se decide o se agota la espera. Sin espera
 * (`esperaMs` 0) lee una vez.
 */
async function cuadrarUno(
  base: Omit<Cuadre, "estado" | "intentos" | "detalle">,
  leer: Lector,
  esperaMs: number,
  intervaloMs: number,
  definitivo: (t: number) => boolean,
  dormir: (ms: number) => Promise<void>,
  ahora: () => number,
): Promise<Cuadre> {
  const limite = ahora() + esperaMs;
  let intentos = 0;
  for (;;) {
    intentos++;
    let l: LecturaDeFactura;
    try {
      l = await leer(base.ventana);
    } catch (e) {
      const m = e instanceof ErrorDeFactura ? e.message : `error leyendo la factura: ${e instanceof Error ? e.name : "desconocido"}`;
      return { ...base, estado: "no-comprobable", intentos, detalle: `factura real no comprobada: ${m}` };
    }
    const conLectura = { ...base, facturadoUsd: l.facturadoUsd, cacheDelProveedorUsd: l.cacheDelProveedorUsd, intentos };
    if (l.ajeno) {
      return { ...conLectura, estado: "no-comprobable", detalle: `factura real no comprobada: tráfico ajeno en los días de la tirada (${l.ajeno}); aísla el gasto del banco` };
    }
    const cerrado = definitivo(ahora());
    const d = decidir(base.esperadoUsd, l.facturadoUsd, cerrado);
    const cifras = `el banco midió ${usd(base.esperadoUsd)} y el proveedor factura ${usd(l.facturadoUsd)}${relativo(base.esperadoUsd, l.facturadoUsd)}`;
    if (d === "cuadra") return { ...conLectura, estado: "cuadra", detalle: `cuadra: ${cifras}` };
    if (d === "no-cuadra") {
      const porque = l.facturadoUsd > base.esperadoUsd ? "la factura pasa del 2 % (el retraso no infla una factura)" : "día cerrado y la factura sigue por debajo del 2 %";
      return { ...conLectura, estado: "no-cuadra", detalle: `${cifras}: ${porque}` };
    }
    if (ahora() + intervaloMs > limite) {
      return { ...conLectura, estado: "pendiente", detalle: `${cifras} tras ${intentos} lecturas: puede ser el retraso del API; se vuelve a comprobar en la próxima tirada` };
    }
    await dormir(intervaloMs);
  }
}

/**
 * Fase 1 (esta tirada, con espera) y fase 2 (los pendientes de la anterior,
 * una lectura). Devuelve un cuadre por proveedor y por tirada.
 */
export async function cuadrarLaFactura(o: OpcionesDelCuadre): Promise<Cuadre[]> {
  const f = o.f ?? fetch;
  const ahora = o.ahora ?? (() => Date.now());
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => undefined);
  const esperaMs = minutosDe(o.env, "BANCO_FACTURA_ESPERA_MIN", ESPERA_POR_DEFECTO_MIN) * MIN_MS;
  const intervaloMs = Math.max(60, minutosDe(o.env, "BANCO_FACTURA_INTERVALO_S", INTERVALO_POR_DEFECTO_S)) * 1000;
  const esperado = gastoEsperado(o.resultados, o.env);
  const out: Cuadre[] = [];

  // Fase 2 primero: es una lectura por proveedor y no espera.
  for (const prev of o.previos ?? []) {
    const lector = lectorDe(prev.proveedor, o.env, f);
    if (typeof lector !== "function") {
      out.push({ ...prev, estado: "pendiente", intentos: 0, detalle: `sigue pendiente: ${lector.detalle}` });
      continue;
    }
    log(`[banco] factura · ${prev.proveedor} · tirada anterior ${prev.runId}: se vuelve a leer`);
    const { estado: _e, intentos: _i, detalle: _d, ...base } = prev;
    out.push(await cuadrarUno(base, lector, 0, intervaloMs, (t) => facturaCerrada(prev.ventana, t), dormir, ahora));
  }

  // Fase 1, los proveedores en paralelo (cada uno espera lo suyo).
  const actuales = await Promise.all(
    PROVEEDORES_FACTURADOS.map(async (p): Promise<Cuadre> => {
      const e = esperado[p];
      const base = { proveedor: p, runId: o.runId, ventana: o.ventana, esperadoUsd: e.esperadoUsd, juezUsd: e.juezUsd };
      if (e.celdas === 0 && e.juezUsd === 0 && e.desconocidas.length === 0) {
        return { ...base, estado: "sin-gasto", intentos: 0, detalle: "el banco no gastó nada facturado por este proveedor: nada que cuadrar" };
      }
      const lector = lectorDe(p, o.env, f);
      if (typeof lector !== "function") return { ...base, estado: lector.estado, intentos: 0, detalle: lector.detalle };
      if (e.desconocidas.length) {
        return {
          ...base,
          estado: "no-comprobable",
          intentos: 0,
          detalle: `factura real no comprobada: ${e.desconocidas.length} celdas murieron sin artefacto y su gasto no se conoce (${e.desconocidas.slice(0, 3).join(", ")})`,
        };
      }
      log(`[banco] factura · ${p}: el banco midió ${usd(e.esperadoUsd)}; se lee la factura (espera hasta ${esperaMs / MIN_MS} min)`);
      return cuadrarUno(base, lector, esperaMs, intervaloMs, (t) => facturaCerrada(o.ventana, t), dormir, ahora);
    }),
  );
  return [...out, ...actuales];
}

/**
 * Los cuadres que la tirada anterior dejó `pendiente`, leídos de su
 * `resultados.json`. Una forma que no se reconoce devuelve [] (sin tirada
 * anterior útil no hay nada que re-comprobar).
 */
export function cuadresPendientesDe(resultadosPrevios: unknown): Cuadre[] {
  const fac = (resultadosPrevios as { factura?: unknown } | null)?.factura;
  if (!Array.isArray(fac)) return [];
  return (fac as Cuadre[]).filter(
    (c) =>
      c &&
      c.estado === "pendiente" &&
      PROVEEDORES_FACTURADOS.includes(c.proveedor) &&
      typeof c.runId === "string" &&
      typeof c.esperadoUsd === "number" &&
      typeof c.ventana?.inicio === "string" &&
      typeof c.ventana?.fin === "string",
  );
}

/** Para el resumen: una línea por cuadre. */
export function lineaDelCuadre(c: Cuadre): string {
  const cache = c.cacheDelProveedorUsd !== undefined && c.cacheDelProveedorUsd > 0 ? ` · de la factura, ${usd(c.cacheDelProveedorUsd)} son caché de prefijo del proveedor (ahorro nativo: aparte, no es de la capa)` : "";
  const juez = c.juezUsd ? ` · incluye ${usd(c.juezUsd)} del juez` : "";
  return `${c.proveedor} · tirada ${c.runId} (${c.ventana.inicio} → ${c.ventana.fin}) · **${c.estado}** · ${c.detalle}${juez}${cache}`;
}
