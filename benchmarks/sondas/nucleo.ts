/**
 * EL NÚCLEO DE LAS SONDAS EN VIVO — lo que no toca la red y se prueba en CI.
 *
 *  · La red guardada: un `fetch` que solo deja salir hacia los tres hosts
 *    oficiales (api.anthropic.com, api.openai.com,
 *    generativelanguage.googleapis.com), que apunta cada host que se intentó
 *    —permitido o no— y que no deja empezar una llamada cuyo peor caso no quepa
 *    en el tope DURO de 5 $ (todas las sondas juntas).
 *  · El coste de cada respuesta según su `usage`, a la tarifa de lista del
 *    catálogo de la capa: la cuenta que se compara con `report.cost.actual`.
 *  · El resumen del cable: qué salió en cada cuerpo (marcas de caché, `is_error`,
 *    `diagnostics`, `reasoning_effort`, `extra_content`…) y qué volvió (bloques,
 *    búsquedas, parada). NUNCA texto de respuesta: solo clases y longitudes.
 *  · La limpieza de secretos: todo lo que va a disco pasa por `limpiarSecretos`
 *    y el JSON se comprueba contra las claves antes de escribirse.
 */
import {
  PRICE_CATALOG,
} from "../../src/index.js";

// ── Hosts ───────────────────────────────────────────────────────────────────

export const HOSTS_PERMITIDOS = ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"] as const;
export type HostPermitido = (typeof HOSTS_PERMITIDOS)[number];

export const BASE_ANTHROPIC = "https://api.anthropic.com/v1";
export const BASE_OPENAI = "https://api.openai.com/v1";
export const BASE_GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";

export type Familia = "anthropic" | "openai" | "gemini";

export function hostDe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(url no válida)";
  }
}

/** Solo https, host exacto y puerto por defecto. */
export function hostPermitido(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.port === "" && (HOSTS_PERMITIDOS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

export function familiaDelHost(host: string): Familia | null {
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "api.openai.com") return "openai";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  return null;
}

// ── Presupuesto ─────────────────────────────────────────────────────────────

/** El tope DURO de todas las sondas juntas, decidido por el dueño. */
export const TOPE_TOTAL_USD = 5;

export class PresupuestoAgotado extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PresupuestoAgotado";
  }
}

/**
 * Lo GASTADO según el `usage` a tarifa de lista (la cuenta prudente: una
 * negativa no cobrada también suma). Las llamadas van de una en una; ninguna
 * empieza si `gastado + peorCaso` pasa del tope.
 */
export class Presupuesto {
  gastado = 0;
  readonly porSonda: Record<string, number> = {};
  constructor(readonly tope: number = TOPE_TOTAL_USD) {
    if (!(tope > 0) || tope > TOPE_TOTAL_USD) throw new Error(`presupuesto: el tope tiene que estar en (0, ${TOPE_TOTAL_USD}]`);
  }
  admitir(peorCaso: number): void {
    if (this.gastado + peorCaso > this.tope) {
      throw new PresupuestoAgotado(
        `presupuesto: ${this.gastado.toFixed(4)} $ gastados + ${peorCaso.toFixed(4)} $ de peor caso > tope ${this.tope} $`,
      );
    }
  }
  gastar(sonda: string, usd: number): void {
    this.gastado += usd;
    this.porSonda[sonda] = (this.porSonda[sonda] ?? 0) + usd;
  }
}

// ── Precios ─────────────────────────────────────────────────────────────────

export interface Precio {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
}

export function precioDe(modelo: string): Precio {
  const m = modelo.includes("/") ? modelo.slice(modelo.lastIndexOf("/") + 1) : modelo;
  const p = (PRICE_CATALOG as Record<string, Precio | undefined>)[m];
  if (!p) throw new Error(`sin fila de catálogo para ${m}: no se puede presupuestar`);
  return p;
}

/**
 * Peor caso de UNA llamada, desde el cuerpo que sale: un token por cada 2
 * caracteres de JSON más 3.000 de margen (el prompt de herramientas que añade el
 * proveedor, las definiciones que carga una búsqueda) y el tope de salida entero
 * dos veces (el pensamiento de Gemini puede facturarse por encima).
 */
export function peorCaso(cuerpo: string, topeSalida: number, p: Precio): number {
  const entrada = 3000 + Math.ceil(cuerpo.length / 2);
  return (entrada / 1000) * p.inputPer1k + ((2 * topeSalida) / 1000) * p.outputPer1k;
}

// ── Lectura del `usage` ─────────────────────────────────────────────────────

export interface Uso {
  /** Entrada NO cacheada (Anthropic: `input_tokens`; OpenAI/Gemini: prompt − leídos − escritos). */
  entrada: number;
  lecturaCache: number;
  escrituraCache5m: number;
  escrituraCache1h: number;
  /** Salida facturada (Gemini: completion + el pensamiento que solo está en total_tokens). */
  salida: number;
  /** De la salida, el razonamiento declarado (OpenAI: reasoning_tokens; Gemini: el hueco). */
  razonamiento: number;
  /** Solo Gemini: completion_tokens tal cual, sin el hueco. */
  salidaSinPensamiento?: number;
}

function n(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
}

export function leerUso(familia: Familia, json: unknown): Uso | null {
  if (!json || typeof json !== "object") return null;
  const u = (json as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== "object") return null;
  if (familia === "anthropic") {
    const cc = u["cache_creation"] as Record<string, unknown> | undefined;
    const total = n(u["cache_creation_input_tokens"]);
    const h1 = cc ? n(cc["ephemeral_1h_input_tokens"]) : 0;
    const m5 = cc ? n(cc["ephemeral_5m_input_tokens"]) : total - h1;
    return {
      entrada: n(u["input_tokens"]),
      lecturaCache: n(u["cache_read_input_tokens"]),
      escrituraCache5m: Math.max(0, m5),
      escrituraCache1h: h1,
      salida: n(u["output_tokens"]),
      razonamiento: 0,
    };
  }
  const detalle = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const leidos = n(detalle["cached_tokens"]);
  const escritos = n(detalle["cache_write_tokens"]);
  const prompt = n(u["prompt_tokens"]);
  const completion = n(u["completion_tokens"]);
  const razon = n(((u["completion_tokens_details"] ?? {}) as Record<string, unknown>)["reasoning_tokens"]);
  const base = { entrada: Math.max(0, prompt - leidos - escritos), lecturaCache: leidos, escrituraCache5m: escritos, escrituraCache1h: 0 };
  if (familia === "gemini") {
    const hueco = Math.max(0, n(u["total_tokens"]) - prompt - completion);
    return { ...base, salida: completion + hueco, razonamiento: hueco, salidaSinPensamiento: completion };
  }
  return { ...base, salida: completion, razonamiento: razon };
}

/** El coste de una respuesta según su `usage`, a tarifa de lista (escritura 5 min a 1,25×, 1 h a 2×). */
export function costeDeUso(u: Uso, p: Precio): number {
  const leida = p.cachedInputPer1k ?? p.inputPer1k;
  return (
    (u.entrada / 1000) * p.inputPer1k +
    (u.lecturaCache / 1000) * leida +
    (u.escrituraCache5m / 1000) * p.inputPer1k * 1.25 +
    (u.escrituraCache1h / 1000) * p.inputPer1k * 2 +
    (u.salida / 1000) * p.outputPer1k
  );
}

// ── El cable, resumido ──────────────────────────────────────────────────────

export interface ResumenDelCuerpo {
  mensajes: number;
  herramientas: number;
  diferidas: number;
  busquedaEnTools: boolean;
  marcasDeCache: number;
  /** Dónde están las marcas: "tools[i]", "system[i]", "messages[i]" o "top". */
  dondeMarcas: string[];
  toolUse: number;
  toolResult: number;
  isError: number;
  paresDeBusquedaReenviados: number;
  diagnostics?: unknown;
  reasoningEffort?: string;
  maxTokens?: number;
  extraContentReenviado: number;
  toolCallsReenviadas: number;
  temperature?: number;
  toolChoice?: unknown;
  campos: string[];
}

type Obj = Record<string, unknown>;
const esObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

export function resumirCuerpo(familia: Familia, cuerpo: Obj): ResumenDelCuerpo {
  const mensajes = (cuerpo["messages"] as unknown[] | undefined) ?? [];
  const tools = (cuerpo["tools"] as unknown[] | undefined) ?? [];
  const r: ResumenDelCuerpo = {
    mensajes: mensajes.length,
    herramientas: tools.length,
    diferidas: tools.filter((t) => esObj(t) && t["defer_loading"] === true).length,
    busquedaEnTools: tools.some((t) => esObj(t) && typeof t["type"] === "string" && String(t["type"]).startsWith("tool_search_tool")),
    marcasDeCache: 0,
    dondeMarcas: [],
    toolUse: 0,
    toolResult: 0,
    isError: 0,
    paresDeBusquedaReenviados: 0,
    extraContentReenviado: 0,
    toolCallsReenviadas: 0,
    campos: Object.keys(cuerpo).sort(),
  };
  if ("diagnostics" in cuerpo) r.diagnostics = cuerpo["diagnostics"];
  if (typeof cuerpo["reasoning_effort"] === "string") r.reasoningEffort = cuerpo["reasoning_effort"] as string;
  const mt = cuerpo["max_tokens"] ?? cuerpo["max_completion_tokens"];
  if (typeof mt === "number") r.maxTokens = mt;
  if (typeof cuerpo["temperature"] === "number") r.temperature = cuerpo["temperature"] as number;
  if ("tool_choice" in cuerpo) r.toolChoice = cuerpo["tool_choice"];
  if (esObj(cuerpo["cache_control"])) {
    r.marcasDeCache += 1;
    r.dondeMarcas.push("top");
  }
  tools.forEach((t, i) => {
    if (esObj(t) && esObj(t["cache_control"])) {
      r.marcasDeCache += 1;
      r.dondeMarcas.push(`tools[${i}]`);
    }
  });
  const sys = cuerpo["system"];
  if (Array.isArray(sys)) {
    sys.forEach((b, i) => {
      if (esObj(b) && esObj(b["cache_control"])) {
        r.marcasDeCache += 1;
        r.dondeMarcas.push(`system[${i}]`);
      }
    });
  }
  mensajes.forEach((m, i) => {
    if (!esObj(m)) return;
    if (familia !== "anthropic") {
      const tc = m["tool_calls"];
      if (Array.isArray(tc)) {
        r.toolCallsReenviadas += tc.length;
        r.extraContentReenviado += tc.filter((c) => esObj(c) && esObj(c["extra_content"])).length;
      }
      return;
    }
    const content = m["content"];
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!esObj(b)) continue;
      if (esObj(b["cache_control"])) {
        r.marcasDeCache += 1;
        r.dondeMarcas.push(`messages[${i}]`);
      }
      if (b["type"] === "tool_use") r.toolUse += 1;
      if (b["type"] === "tool_result") {
        r.toolResult += 1;
        if (b["is_error"] === true) r.isError += 1;
      }
      if (b["type"] === "tool_search_tool_result") r.paresDeBusquedaReenviados += 1;
    }
  });
  return r;
}

export interface ResumenDeLaRespuesta {
  id?: string;
  parada?: string;
  bloques: Record<string, number>;
  /** Búsquedas del servidor (Anthropic: bloques `server_tool_use`). */
  busquedas: number;
  herramientasCargadas: string[];
  llamadas: string[];
  largoDelTexto: number;
  extraContent: number;
  diagnostics?: unknown;
  error?: string;
}

export function resumirRespuesta(familia: Familia, status: number, json: unknown): ResumenDeLaRespuesta {
  const r: ResumenDeLaRespuesta = { bloques: {}, busquedas: 0, herramientasCargadas: [], llamadas: [], largoDelTexto: 0, extraContent: 0 };
  if (status >= 400) {
    const raiz = Array.isArray(json) ? json[0] : json;
    const e = esObj(raiz) ? raiz["error"] : undefined;
    r.error = esObj(e) ? String(e["message"] ?? e["type"] ?? "error").slice(0, 400) : `HTTP ${status}`;
    return r;
  }
  if (!esObj(json)) return r;
  if (typeof json["id"] === "string") r.id = json["id"] as string;
  if (familia === "anthropic") {
    r.parada = typeof json["stop_reason"] === "string" ? (json["stop_reason"] as string) : undefined;
    if ("diagnostics" in json) r.diagnostics = json["diagnostics"];
    for (const b of (json["content"] as unknown[] | undefined) ?? []) {
      if (!esObj(b)) continue;
      const t = String(b["type"]);
      r.bloques[t] = (r.bloques[t] ?? 0) + 1;
      if (t === "server_tool_use") r.busquedas += 1;
      if (t === "tool_use") r.llamadas.push(String(b["name"]));
      if (t === "text") r.largoDelTexto += String(b["text"] ?? "").length;
      if (t === "tool_search_tool_result") {
        const c = b["content"];
        const refs = esObj(c) ? (c["tool_references"] as unknown[] | undefined) : undefined;
        for (const ref of refs ?? []) if (esObj(ref)) r.herramientasCargadas.push(String(ref["tool_name"]));
      }
    }
    return r;
  }
  const choice = ((json["choices"] as unknown[] | undefined) ?? [])[0];
  if (esObj(choice)) {
    r.parada = typeof choice["finish_reason"] === "string" ? (choice["finish_reason"] as string) : undefined;
    const msg = choice["message"];
    if (esObj(msg)) {
      r.largoDelTexto = typeof msg["content"] === "string" ? (msg["content"] as string).length : 0;
      for (const c of (msg["tool_calls"] as unknown[] | undefined) ?? []) {
        if (!esObj(c)) continue;
        const f = c["function"];
        r.llamadas.push(esObj(f) ? String(f["name"]) : "?");
        if (esObj(c["extra_content"])) r.extraContent += 1;
      }
    }
  }
  return r;
}

// ── La red guardada ─────────────────────────────────────────────────────────

export interface Llamada {
  n: number;
  sonda: string;
  brazo: string;
  host: string;
  ruta: string;
  familia: Familia;
  modelo: string;
  status: number;
  cuerpo: ResumenDelCuerpo;
  respuesta: ResumenDeLaRespuesta;
  uso: Uso | null;
  costeUsd: number;
}

export interface Etiqueta {
  sonda: string;
  brazo: string;
  /**
   * Lo que el arnés le hace al cuerpo ANTES de que salga, para provocar a
   * propósito un caso (el diagnóstico de caché: un byte del prefijo que el
   * espejo de la capa no ve). Devuelve el cuerpo tocado o `undefined`.
   */
  tocarCuerpo?: (cuerpo: Obj) => Obj | undefined;
  /** No guardar nada del cuerpo ni de la respuesta más allá de clases y cuentas (banco de seguridad). */
  sensible?: boolean;
}

export interface RedGuardada {
  fetch: typeof fetch;
  llamadas: Llamada[];
  hostsVistos: Record<string, number>;
  hostsBloqueados: Record<string, number>;
  presupuesto: Presupuesto;
  /** La etiqueta que se pone a las llamadas que salgan a partir de ahora. */
  etiquetar(e: Etiqueta): void;
}

/**
 * El `fetch` de todas las sondas, con y sin capa. `base` es el fetch de verdad en
 * vivo y el de mentira en seco. Un host fuera de la lista NUNCA sale: se apunta y
 * se lanza un error. El tope de salida se lee del cuerpo (`max_tokens` /
 * `max_completion_tokens`); si no lo trae, se presupuesta con 4.096.
 */
export function crearRed(base: typeof fetch, presupuesto: Presupuesto): RedGuardada {
  const llamadas: Llamada[] = [];
  const hostsVistos: Record<string, number> = {};
  const hostsBloqueados: Record<string, number> = {};
  let etiqueta: Etiqueta = { sonda: "(sin etiqueta)", brazo: "-" };

  const f = (async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const host = hostDe(url);
    if (!hostPermitido(url)) {
      hostsBloqueados[host] = (hostsBloqueados[host] ?? 0) + 1;
      throw new Error(`red guardada: ${host} no es uno de los hosts permitidos (${HOSTS_PERMITIDOS.join(", ")})`);
    }
    hostsVistos[host] = (hostsVistos[host] ?? 0) + 1;
    const familia = familiaDelHost(host)!;
    let cuerpoTexto = typeof init?.body === "string" ? init.body : "";
    let cuerpo: Obj = {};
    try {
      cuerpo = cuerpoTexto ? (JSON.parse(cuerpoTexto) as Obj) : {};
    } catch {
      cuerpo = {};
    }
    if (etiqueta.tocarCuerpo) {
      const tocado = etiqueta.tocarCuerpo(cuerpo);
      if (tocado) {
        cuerpo = tocado;
        cuerpoTexto = JSON.stringify(tocado);
        init = { ...init, body: cuerpoTexto };
      }
    }
    const modelo = typeof cuerpo["model"] === "string" ? (cuerpo["model"] as string) : "?";
    const tope = Number(cuerpo["max_tokens"] ?? cuerpo["max_completion_tokens"] ?? 4096);
    const precio = precioDe(modelo);
    presupuesto.admitir(peorCaso(cuerpoTexto, Number.isFinite(tope) ? tope : 4096, precio));

    const res = await base(url, init);
    let json: unknown = null;
    const tipo = res.headers.get("content-type") ?? "";
    if (tipo.includes("json")) {
      try {
        json = await res.clone().json();
      } catch {
        json = null;
      }
    }
    const uso = res.status < 400 ? leerUso(familia, json) : null;
    const coste = uso ? costeDeUso(uso, precio) : 0;
    presupuesto.gastar(etiqueta.sonda, coste);
    const respuesta = resumirRespuesta(familia, res.status, json);
    if (etiqueta.sensible) respuesta.error = respuesta.error ? "(omitido: banco de seguridad)" : undefined;
    llamadas.push({
      n: llamadas.length + 1,
      sonda: etiqueta.sonda,
      brazo: etiqueta.brazo,
      host,
      ruta: new URL(url).pathname,
      familia,
      modelo,
      status: res.status,
      cuerpo: resumirCuerpo(familia, cuerpo),
      respuesta,
      uso,
      costeUsd: coste,
    });
    return res;
  }) as typeof fetch;

  return {
    fetch: f,
    llamadas,
    hostsVistos,
    hostsBloqueados,
    presupuesto,
    etiquetar(e: Etiqueta) {
      etiqueta = e;
    },
  };
}

// ── Secretos ────────────────────────────────────────────────────────────────

export function limpiarSecretos(texto: string, secretos: readonly string[]): string {
  let t = texto;
  for (const s of secretos) if (s && s.length >= 8) t = t.split(s).join("[redacted]");
  return t
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9*_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._*-]+/gi, "Bearer [redacted]")
    .replace(/\bbvk_[A-Za-z0-9_-]{6,}/g, "[redacted]");
}

export function contieneSecreto(texto: string, secretos: readonly string[]): boolean {
  return secretos.some((s) => s && s.length >= 8 && texto.includes(s));
}

// ── Catálogos ───────────────────────────────────────────────────────────────

export interface HerramientaDeSonda {
  id: string;
  description: string;
  intents: string[];
  risk: "read";
  parameters: {
    type: "object";
    properties: Record<string, { type: "string" | "integer"; description: string }>;
    required: string[];
  };
}

const DOMINIOS = [
  "pedidos", "envios", "facturas", "clientes", "inventario", "devoluciones", "pagos", "proveedores",
  "almacenes", "tarifas", "cupones", "resenas", "garantias", "suscripciones", "contratos", "empleados",
  "turnos", "vehiculos", "rutas", "incidencias", "auditorias", "impuestos", "divisas", "catalogo", "campanas",
];
const VERBOS = ["consultar", "listar", "resumir", "validar", "historial"];

/**
 * Un catálogo de `n` herramientas de solo lectura, deterministas. `palabrasDeRelleno`
 * alarga cada descripción (para pasar el mínimo cacheable del modelo) con texto
 * de política plausible, no con basura repetida.
 */
export function catalogo(n: number, palabrasDeRelleno = 0): HerramientaDeSonda[] {
  const relleno = [
    "Solo lectura; nunca modifica datos.",
    "Devuelve campos normalizados en español con fechas ISO 8601 y cantidades en céntimos.",
    "Si el identificador no existe devuelve un error explícito en lugar de un resultado vacío.",
    "Respeta los permisos del agente que llama y omite los campos personales que no le correspondan.",
    "Los resultados pueden tener hasta cinco minutos de retraso respecto al sistema de origen.",
    "Paginación por cursor opaco; el límite por defecto es de veinte elementos por página.",
    "Úsala antes que las herramientas de escritura para confirmar el estado actual.",
    "Las zonas horarias se devuelven siempre en UTC con la zona local del almacén como campo aparte.",
  ];
  const out: HerramientaDeSonda[] = [];
  for (let i = 0; i < n; i++) {
    const dominio = DOMINIOS[i % DOMINIOS.length]!;
    const verbo = VERBOS[Math.floor(i / DOMINIOS.length) % VERBOS.length]!;
    const vuelta = Math.floor(i / (DOMINIOS.length * VERBOS.length));
    const id = `${verbo}_${dominio}${vuelta ? `_${vuelta}` : ""}`;
    let descripcion = `${verbo[0]!.toUpperCase()}${verbo.slice(1)} ${dominio} por identificador o filtro.`;
    let k = 0;
    while (descripcion.split(/\s+/).length < 10 + palabrasDeRelleno) descripcion += ` ${relleno[(i + k++) % relleno.length]}`;
    out.push({
      id,
      description: descripcion,
      intents: [`${verbo} ${dominio}`],
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: `Identificador del elemento de ${dominio}.` },
          filtro: { type: "string", description: "Filtro libre opcional." },
        },
        required: ["id"],
      },
    });
  }
  return out;
}

/** El mismo catálogo en la forma de la Messages API (brazo sin capa). */
export function aAnthropic(tools: HerramientaDeSonda[]): Obj[] {
  return tools.map((t) => ({ name: t.id, description: t.description, input_schema: t.parameters }));
}

/** Estimación grosera de tokens de un texto (4 caracteres por token), solo para dimensionar. */
export function tokensAprox(texto: string): number {
  return Math.ceil(texto.length / 4);
}
