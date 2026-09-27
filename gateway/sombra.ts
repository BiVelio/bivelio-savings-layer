import { createHash } from "node:crypto";

import { precioDeLista } from "../src/pricing/catalogo.js";
import { primaDeEscritura, primaDeEscritura1h } from "../src/pricing/primas.js";

/**
 * S2.4 · LA SOMBRA — el motor de las TRES políticas de elisión candidatas,
 * comparadas en DINERO (no en tokens) sobre tráfico real
 * (docs/PLAN-PASARELA-API-KEY.md, S2.4). Este módulo es PURO: no toca red, no
 * toca el camino de la petición — lo consumen el replay del corpus
 * (benchmarks/sombra-corpus.ts) hoy y el carril sombra del gateway mañana.
 *
 * Las políticas:
 *   · v0 — determinista: candidato = bloque `tool_result` por encima de un
 *     umbral de edad×tamaño. La edad CAMBIA cada turno, así que sus decisiones
 *     cambian con el tiempo: es la política que más caché de prefijo invalida,
 *     y está aquí para MEDIR ese coste, no a pesar de él.
 *   · v1 — consciente del TIPO de bloque (decisión del dueño, 01-09;
 *     implementación propia desde cero): logs → conservar errores y trazas;
 *     salida de código → firmas/tipos sin cuerpos; diffs → intactos (el diff ES
 *     la señal). Depende solo del CONTENIDO, nunca de la edad: sus decisiones
 *     son estables de por vida y no rompen el prefijo hacia atrás.
 *   · v2 — empaquetado con presupuesto: puntuar bloques por recencia + señal de
 *     error + tamaño y podar los peores hasta un presupuesto, conservando
 *     SIEMPRE el orden cronológico. Al crecer la conversación, bloques que ayer
 *     cabían hoy no caben: invalida, pero acotado por el presupuesto.
 *
 * LA TRAMPA QUE MATA POLÍTICAS (y por qué existe el simulador de abajo):
 * reescribir un bloque que estaba en la caché de prefijo convierte TODO lo
 * posterior en tokens nuevos (escritura a 1,25×/2× en vez de lectura a 0,1×).
 * En tráfico real ~98 % de la entrada es lectura de caché: una política que
 * ahorra tokens rompiendo prefijos puede COSTAR dinero. Aquí la invalidación
 * no se estima: emerge del simulador y se resta siempre, y además se reporta
 * en dólares como cifra propia.
 *
 * PRIVACIDAD: `compactarCuerpo` reduce cada petición a metadatos por bloque
 * (hash, bytes, clase). El contenido se mira UNA vez para clasificar y calcular
 * la reducción de v1, y no sale de esa función: ni al informe, ni al replay,
 * ni a un log.
 */

/** Nombres de las políticas candidatas: las tres del plan más `v2m`, la
 *  variante MONÓTONA de v2 que nació de la primera tirada del replay — la v2
 *  literal repuntúa cada turno, el conjunto de víctimas baila, y esa
 *  inestabilidad costó −39 % en dinero (¡perdía!): la caché de prefijo castiga
 *  cada cambio de opinión. En v2m un bloque elidido queda elidido de por vida;
 *  el presupuesto solo decide QUIÉN CAE HOY, jamás quién resucita. */
export const POLITICAS = ["v0", "v1", "v2", "v2m"] as const;
export type Politica = (typeof POLITICAS)[number];

/** Clase de contenido de un tool_result, para la política v1. */
export type ClaseDeBloque = "log" | "codigo" | "diff" | "otro";

/** El marcador `cache_control` de un bloque: su TTL, o null si no lo lleva. */
export type MarcaDeCache = "1h" | "5m" | null;

/** Un bloque del prompt, compactado: SIN contenido. */
export interface BloqueSombra {
  /** Identidad CANÓNICA del bloque: hash de lo que el tokenizador del
   *  proveedor ve. Un bloque de texto se identifica por su TEXTO (así
   *  `content:"x"` ≡ `[{type:"text",text:"x"}]`, las dos formas en que Claude
   *  Code manda el mismo mensaje según lleve o no el marcador) y cualquier
   *  otro por su JSON SIN `cache_control` — el marcador se mueve de turno en
   *  turno, el contenido no. Con el marcador dentro del hash, el bloque que
   *  llevó el breakpoint «cambiaba» en cada turno y el simulador declaraba
   *  una rotura de prefijo por turno: la escritura simulada del corpus salía
   *  un 66 % por encima del contador del proveedor. Un tool_result que se
   *  reenvía idéntico turno tras turno conserva su clave — así se le puede
   *  poner edad. */
  clave: string;
  /** `rol:tipo` (p. ej. `user:tool_result`, `assistant:text`, `system`). */
  tipo: string;
  /** Breakpoint de caché del bloque (doc del proveedor: se escribe UNA
   *  entrada por marcador, con el hash del prefijo que acaba en él). */
  marca: MarcaDeCache;
  bytes: number;
  /** Solo tool_result: bytes tras la reducción por contenido de v1. */
  bytesV1: number;
  clase: ClaseDeBloque;
  esError: boolean;
}

/** Umbral por debajo del cual NINGUNA política toca un bloque: el muñón ocupa
 *  ~120 bytes y elidir menos de 1 KB no paga ni su propia reescritura. */
export const MINIMO_BYTES_CANDIDATO = 1024;

/** Bytes del muñón que sustituye a un bloque elidido. */
export const BYTES_DEL_MUNON = 120;

/** v0: elidir cuando edad_turnos × KB ≥ este umbral (y edad ≥ 2: el resultado
 *  recién nacido y el del turno anterior no se tocan jamás). */
export const V0_UMBRAL_EDAD_KB = 8;

/** v2: presupuesto de masa tool_result por turno, en bytes. */
export const V2_PRESUPUESTO_BYTES = 256 * 1024;

const RE_LINEA_SENAL = /error|exception|traceback|warn|fatal|fail|panic|assert|denied|refused|timeout|\bat\s+\S+:\d+/i;
// Firmas/estructura, NO cuerpos: aquí no entran `const`/`let`/visibilidad,
// que aparecen en cualquier línea de un cuerpo y convertirían «conservar
// firmas» en «conservarlo todo».
const RE_LINEA_FIRMA =
  /^\s*(export\s|import\s|function\s|class\s|interface\s|type\s|enum\s|def\s|fn\s|func\s|impl\s|struct\s|trait\s|package\s|module\s|@\w)/;

function bytesDe(valor: unknown): number {
  return Buffer.byteLength(typeof valor === "string" ? valor : JSON.stringify(valor ?? ""));
}

/** El texto plano de un content de tool_result (string o lista de bloques text). */
function textoDeContenido(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

/** El prefijo de número de línea que los harness de agentes anteponen a las
 *  lecturas de fichero (formato `cat -n`: espacios + dígitos + tab/→). Sin
 *  quitarlo, TODO el código leído con la herramienta Read se clasifica como
 *  «otro» — la primera tirada del replay lo demostró: 48 % del prompt era
 *  tool_result «otro» y el clasificador solo veía código en el 0,4 %. */
const RE_PREFIJO_NUMERO_DE_LINEA = /^\s*\d+[\t→]/;

function sinNumeroDeLinea(l: string): string {
  return l.replace(RE_PREFIJO_NUMERO_DE_LINEA, "");
}

/** Clasifica el contenido de un tool_result. Solo mira el texto; determinista. */
export function clasificar(texto: string): ClaseDeBloque {
  if (!texto) return "otro";
  const lineas = texto.split("\n");
  const n = Math.max(1, lineas.length);
  let diff = 0;
  let firma = 0;
  let sello = 0;
  for (const cruda of lineas) {
    const l = sinNumeroDeLinea(cruda);
    if (/^[+-](?![+-])/.test(l) || l.startsWith("@@") || l.startsWith("diff --git")) diff += 1;
    if (RE_LINEA_FIRMA.test(l)) firma += 1;
    if (/^\s*(\d{4}-\d{2}-\d{2}|\[\d|\d{2}:\d{2}:\d{2})/.test(l) || /\b(INFO|DEBUG|TRACE|WARN|ERROR)\b/.test(l)) sello += 1;
  }
  if (diff / n > 0.25) return "diff";
  if (sello / n > 0.3) return "log";
  if (firma / n > 0.08) return "codigo";
  return "otro";
}

/**
 * La reducción de v1 sobre un texto YA clasificado: devuelve los BYTES que
 * quedarían. No devuelve el texto reducido a propósito — el motor solo
 * necesita la cifra, y así el contenido no viaja más allá de esta función.
 *   · log: sobreviven las líneas con señal (error/traza/aviso) más una línea
 *     de contexto a cada lado.
 *   · codigo: sobreviven las líneas de firma/tipo/estructura.
 *   · diff: intacto (el diff es exactamente lo que el modelo necesita ver).
 *   · otro: intacto (v1 no elide lo que no sabe leer — conservador a
 *     propósito: presente-y-mal es peor que ausente).
 */
export function bytesTrasReduccionV1(texto: string, clase: ClaseDeBloque): number {
  if (clase === "diff" || clase === "otro") return Buffer.byteLength(texto);
  const lineas = texto.split("\n");
  const conservar = new Set<number>();
  for (let i = 0; i < lineas.length; i++) {
    const linea = sinNumeroDeLinea(lineas[i]!);
    const es =
      clase === "log"
        ? RE_LINEA_SENAL.test(linea)
        : RE_LINEA_FIRMA.test(linea);
    if (!es) continue;
    conservar.add(i);
    if (clase === "log") {
      if (i > 0) conservar.add(i - 1);
      if (i < lineas.length - 1) conservar.add(i + 1);
    }
  }
  let bytes = BYTES_DEL_MUNON; // el marcador de «aquí había N bytes de …»
  for (const i of conservar) bytes += Buffer.byteLength(lineas[i]!) + 1;
  return Math.min(bytes, Buffer.byteLength(texto));
}

/** Quita el marcador de caché al serializar: es metadato de cacheo, no contenido. */
const sinMarcas = (clave: string, valor: unknown): unknown => (clave === "cache_control" ? undefined : valor);

/** Lo que el tokenizador del proveedor ve de un bloque: el texto, si es un
 *  bloque de texto puro (cadena suelta o `{type:"text", text[, cache_control]}`);
 *  el JSON sin marcador para cualquier otro. */
function formaCanonica(valor: unknown): string {
  if (typeof valor === "string") return `text:${valor}`;
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return `json:${JSON.stringify(valor ?? "")}`;
  const o = valor as Record<string, unknown>;
  if (o["type"] === "text" && typeof o["text"] === "string" && Object.keys(o).every((k) => k === "type" || k === "text" || k === "cache_control")) {
    return `text:${o["text"] as string}`;
  }
  return `json:${JSON.stringify(o, sinMarcas)}`;
}

/** La clave canónica de un bloque (ver `BloqueSombra.clave`). */
export function claveCanonica(valor: unknown): string {
  return createHash("sha256").update(formaCanonica(valor)).digest("hex").slice(0, 16);
}

/** El breakpoint de un bloque, leído de su `cache_control`: `ttl:"1h"` → 1h;
 *  presente sin ttl (o con "5m") → 5m; ausente → null. */
export function marcaDe(valor: unknown): MarcaDeCache {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const cc = (valor as { cache_control?: unknown }).cache_control;
  if (!cc || typeof cc !== "object") return null;
  return (cc as { ttl?: unknown }).ttl === "1h" ? "1h" : "5m";
}

/**
 * Compacta un cuerpo de /v1/messages a la lista de bloques que el motor
 * necesita. ÚNICO punto que ve contenido; lo que devuelve no lo lleva.
 *
 * El ORDEN es el del prefijo real del proveedor: tools → system → messages
 * («cache prefixes are created in the following order: tools, system, then
 * messages»). Un `system` en forma de lista se emite como un bloque por
 * elemento, cada uno con su propio marcador (Claude Code marca dos
 * sub-bloques a 1h). Los parámetros de la petición (thinking, betas,
 * tool_choice…) NO forman parte de la identidad: el proveedor no invalida
 * por ellos, y meterlos en el hash multiplicaba por 3 la escritura simulada.
 */
export function compactarCuerpo(cuerpo: { messages?: unknown; system?: unknown; tools?: unknown }): BloqueSombra[] {
  const bloques: BloqueSombra[] = [];
  const anota = (tipo: string, valor: unknown) => {
    const bytes = bytesDe(valor);
    const b: BloqueSombra = {
      clave: claveCanonica(valor),
      tipo,
      marca: marcaDe(valor),
      bytes,
      bytesV1: bytes,
      clase: "otro",
      esError: false,
    };
    if (tipo.endsWith(":tool_result") && valor && typeof valor === "object") {
      const v = valor as { is_error?: unknown; content?: unknown };
      b.esError = v.is_error === true;
      const texto = textoDeContenido(v.content);
      b.clase = clasificar(texto);
      // El envoltorio JSON (tool_use_id, comillas…) no se reduce: solo el texto.
      const envoltorio = bytes - Buffer.byteLength(texto);
      b.bytesV1 = Math.min(bytes, Math.max(0, envoltorio) + bytesTrasReduccionV1(texto, b.clase));
    }
    bloques.push(b);
  };
  if (Array.isArray(cuerpo.tools)) for (const t of cuerpo.tools) anota("tools", t);
  if (Array.isArray(cuerpo.system)) for (const s of cuerpo.system) anota("system", s);
  else if ((cuerpo.system ?? undefined) !== undefined) anota("system", cuerpo.system);
  for (const m of Array.isArray(cuerpo.messages) ? cuerpo.messages : []) {
    if (!m || typeof m !== "object") {
      anota("?:invalido", m);
      continue;
    }
    const msg = m as { role?: unknown; content?: unknown };
    const rol = typeof msg.role === "string" ? msg.role : "?";
    if (typeof msg.content === "string") anota(`${rol}:text`, msg.content);
    else if (Array.isArray(msg.content)) for (const b of msg.content) anota(`${rol}:${(b as { type?: string })?.type ?? "?"}`, b);
  }
  return bloques;
}

/** Un turno ya compactado, listo para el simulador. */
export interface TurnoSombra {
  bloques: BloqueSombra[];
  /** Época en ms del registro (para la caducidad del prefijo). */
  at: number;
  model: string;
  /** Contador REAL del proveedor: entrada total (input+lectura+escritura). */
  entradaReal: number;
  /** ¿La escritura real del turno fue con TTL 1h? Solo decide la prima del
   *  breakpoint IMPLÍCITO de un turno sin ningún marcador (el TTL de cada
   *  entrada lo fija la marca del bloque que la escribe). */
  escritura1h: boolean;
}

/** Estado por sesión que las políticas necesitan: la edad de cada bloque y,
 *  para v2m, el conjunto (solo-crece) de bloques ya elididos. */
export interface EstadoSesion {
  nacimiento: Map<string, number>;
  turno: number;
  elididosV2m: Set<string>;
}

export function estadoNuevo(): EstadoSesion {
  return { nacimiento: new Map(), turno: 0, elididosV2m: new Set() };
}

/** Registra el turno en el estado (edades) y devuelve el índice de turno. */
export function avanzarEstado(estado: EstadoSesion, bloques: BloqueSombra[]): number {
  const turno = estado.turno++;
  for (const b of bloques) if (!estado.nacimiento.has(b.clave)) estado.nacimiento.set(b.clave, turno);
  return turno;
}

/**
 * Aplica una política a los bloques de UN turno y devuelve los bytes finales
 * por bloque (mismo orden — el orden cronológico jamás se altera). Un bloque
 * elidido queda en BYTES_DEL_MUNON con la MISMA clave más el sufijo `:e` (la
 * identidad del muñón es estable: dos turnos que eliden el mismo bloque
 * producen el mismo muñón, y el prefijo entre ellos se conserva).
 */
export function aplicarPolitica(
  politica: Politica,
  bloques: BloqueSombra[],
  estado: EstadoSesion,
  turno: number,
  /** Solo v2/v2m: el dial del presupuesto (el replay lo barre para la
   *  sensibilidad; el defecto es el del plan). */
  presupuestoV2: number = V2_PRESUPUESTO_BYTES,
): { clave: string; bytes: number }[] {
  const indiceUltimoToolResult = bloques.reduce((ultimo, b, i) => (b.tipo.endsWith(":tool_result") ? i : ultimo), -1);
  const esCandidato = (b: BloqueSombra, i: number) =>
    b.tipo.endsWith(":tool_result") && b.bytes >= MINIMO_BYTES_CANDIDATO && i !== indiceUltimoToolResult;

  if (politica === "v0") {
    return bloques.map((b, i) => {
      if (!esCandidato(b, i)) return { clave: b.clave, bytes: b.bytes };
      const edad = turno - (estado.nacimiento.get(b.clave) ?? turno);
      const elidir = edad >= 2 && (edad * b.bytes) / 1024 >= V0_UMBRAL_EDAD_KB;
      return elidir ? { clave: `${b.clave}:e`, bytes: BYTES_DEL_MUNON } : { clave: b.clave, bytes: b.bytes };
    });
  }

  if (politica === "v1") {
    // Solo contenido, jamás edad: la decisión de un bloque no cambia nunca.
    return bloques.map((b, i) => {
      if (!esCandidato(b, i) || b.esError) return { clave: b.clave, bytes: b.bytes };
      return b.bytesV1 < b.bytes ? { clave: `${b.clave}:r`, bytes: b.bytesV1 } : { clave: b.clave, bytes: b.bytes };
    });
  }

  // v2 / v2m · presupuesto: puntuar candidatos y podar los peores hasta que la
  // masa tool_result quepa. Los errores y el último resultado no se podan
  // jamás. La diferencia entre las dos es UNA sola cosa: v2m recuerda a sus
  // víctimas (estado.elididosV2m) y no las resucita nunca — v2 literal
  // repuntúa cada turno y su baile de víctimas demostró en el replay que
  // tritura la caché de prefijo (−39 % en dinero).
  const monotona = politica === "v2m";
  const candidatos: { i: number; puntos: number }[] = [];
  const elididos = new Set<number>();
  let masa = 0;
  for (let i = 0; i < bloques.length; i++) {
    const b = bloques[i]!;
    if (!b.tipo.endsWith(":tool_result")) continue;
    if (monotona && estado.elididosV2m.has(b.clave) && i !== indiceUltimoToolResult) {
      elididos.add(i);
      masa += BYTES_DEL_MUNON;
      continue;
    }
    masa += b.bytes;
    if (!esCandidato(b, i) || b.esError) continue;
    const edad = turno - (estado.nacimiento.get(b.clave) ?? turno);
    // Menos puntos = primero en caer: viejo y grande cae antes; la señal de
    // error ya quedó fuera de candidatos.
    candidatos.push({ i, puntos: -(edad * Math.log2(Math.max(2, b.bytes))) });
  }
  if (masa > presupuestoV2) {
    candidatos.sort((a, z) => a.puntos - z.puntos);
    for (const c of candidatos) {
      if (masa <= presupuestoV2) break;
      elididos.add(c.i);
      masa -= bloques[c.i]!.bytes - BYTES_DEL_MUNON;
      if (monotona) estado.elididosV2m.add(bloques[c.i]!.clave);
    }
  }
  return bloques.map((b, i) => (elididos.has(i) ? { clave: `${b.clave}:e`, bytes: BYTES_DEL_MUNON } : { clave: b.clave, bytes: b.bytes }));
}

/** Precios por millar para el simulador, derivados del catálogo real. */
export interface PreciosSimulados {
  /** Entrada sin caché (lo que va tras el último breakpoint). */
  inputPer1k: number;
  lecturaPer1k: number;
  escrituraPer1k: number;
  escritura1hPer1k: number;
}

/**
 * Los precios con los que se simula un turno, a precio de lista del modelo EL
 * DÍA DEL TURNO (`at`, epoch ms; por defecto ahora): el simulador también
 * reproduce corpus pasados, y un turno de diciembre no se tarifa al precio de
 * enero (src/pricing/catalogo.ts, la vigencia por fila).
 */
export function preciosPara(model: string, at?: number): PreciosSimulados | null {
  const precio = precioDeLista(model, at);
  if (!precio) return null;
  return {
    inputPer1k: precio.inputPer1k,
    lecturaPer1k: precio.cachedInputPer1k ?? precio.inputPer1k,
    escrituraPer1k: precio.inputPer1k * primaDeEscritura(model),
    escritura1hPer1k: precio.inputPer1k * primaDeEscritura1h(model),
  };
}

/** Desglose en dólares de una variante simulada sobre una sesión. */
export interface CosteSimulado {
  lecturaUsd: number;
  escrituraUsd: number;
  /** Entrada SIN caché: lo que va tras el último breakpoint del turno — el
   *  proveedor lo cuenta como `input_tokens`, ni lectura ni escritura. */
  entradaUsd: number;
  totalUsd: number;
  tokensLeidos: number;
  tokensEscritos: number;
  tokensEntrada: number;
  /** Tokens reescritos SOLO porque un cambio anterior rompió el prefijo: el
   *  bloque existía idéntico en el turno previo más allá del punto de rotura.
   *  Este es el coste de invalidación que el plan obliga a restar SIEMPRE. */
  tokensInvalidados: number;
  invalidacionUsd: number;
}

function costeVacio(): CosteSimulado {
  return {
    lecturaUsd: 0,
    escrituraUsd: 0,
    entradaUsd: 0,
    totalUsd: 0,
    tokensLeidos: 0,
    tokensEscritos: 0,
    tokensEntrada: 0,
    tokensInvalidados: 0,
    invalidacionUsd: 0,
  };
}

/** TTLs de la caché de prefijo, en ms. */
const TTL_MS = { "1h": 3_600_000, "5m": 300_000 } as const;

/** Ventana de búsqueda hacia atrás desde un breakpoint, en POSICIONES
 *  (doc: «the lookback window is 20 blocks… counting the breakpoint itself
 *  as the first»; una racha de tool_use o de tool_result consecutivos cuenta
 *  como una posición). */
export const VENTANA_DE_BUSQUEDA = 20;

/** Peso máximo, en bytes, de un bloque de imagen en el reparto bytes→tokens:
 *  una imagen tokeniza por píxeles (~1,6 K tokens), no por sus 200 KB de
 *  base64. AJUSTE EMPÍRICO y NO determinado: el arnés da el mismo error con
 *  2.000 B que con 6.000 B (2,7 % frente a 2,8 % en fable-5, el único modelo con
 *  imágenes). La fórmula del proveedor es (ancho × alto) / 750 tokens y exige
 *  leer el contenido, que este simulador no retiene. */
export const BYTES_PESO_IMAGEN = 6_000;

/** Tope de entradas vivas por caché de prefijos: memoria acotada, no doctrina.
 *  Cada entrada es un hash de 24 chars + dos números; 20.000 × 2 variantes ×
 *  modelos vivos cabe holgado en una sesión larga. Al superarlo caen las
 *  expiradas y, si no basta, las más viejas. */
export const MAX_ENTRADAS_CACHE = 20_000;

interface EntradaDeCache {
  expira: number;
  ttl: "1h" | "5m";
}

/**
 * LA CACHÉ DE PREFIJOS SIMULADA: una entrada por breakpoint escrito, con el
 * hash acumulado del prefijo que acaba en él y su caducidad. Es de la
 * ORGANIZACIÓN, no de la sesión: la comparten todas las cadenas de un mismo
 * modelo y variante (una sesión nueva o un subagente acierta en el prefijo
 * tools+system que otra sesión escribió). Base y política NO pueden
 * compartir una: la política cambia el contenido y, con él, los hashes.
 */
export class CacheDePrefijos {
  private readonly entradas = new Map<string, EntradaDeCache>();

  constructor(private readonly tope: number = MAX_ENTRADAS_CACHE) {}

  get size(): number {
    return this.entradas.size;
  }

  /** La entrada VIVA en `hash` en el instante `at`, o null. */
  viva(hash: string, at: number): EntradaDeCache | null {
    const e = this.entradas.get(hash);
    return e && at <= e.expira ? e : null;
  }

  /** Escribe (o reescribe) la entrada; la caducidad se mide desde el INICIO
   *  de la petición que la escribe. */
  escribir(hash: string, at: number, ttl: "1h" | "5m"): void {
    this.entradas.delete(hash);
    this.entradas.set(hash, { expira: at + TTL_MS[ttl], ttl });
    if (this.entradas.size > this.tope) this.podar(at);
  }

  /** Una lectura refresca la entrada sin coste, con su TTL original. */
  refrescar(hash: string, at: number): void {
    const e = this.entradas.get(hash);
    if (!e) return;
    // Reinsertar la mueve al final: la poda por tope cae sobre lo más viejo.
    this.entradas.delete(hash);
    this.entradas.set(hash, { expira: at + TTL_MS[e.ttl], ttl: e.ttl });
  }

  private podar(at: number): void {
    for (const [h, e] of this.entradas) if (at > e.expira) this.entradas.delete(h);
    while (this.entradas.size > this.tope) {
      const masVieja = this.entradas.keys().next().value;
      if (masVieja === undefined) break;
      this.entradas.delete(masVieja);
    }
  }
}

/** Hash acumulado del prefijo hasta cada límite de bloque, encadenado sobre
 *  el modelo: cambiar cualquier bloque cambia el hash de todo lo posterior. */
function hashesDePrefijo(model: string, claves: string[]): string[] {
  const hashes: string[] = new Array<string>(claves.length);
  let h = createHash("sha256").update(`model:${model}`).digest("hex");
  for (let i = 0; i < claves.length; i++) {
    h = createHash("sha256").update(h).update("|").update(claves[i]!).digest("hex").slice(0, 32);
    hashes[i] = h;
  }
  return hashes;
}

/** Posición de cada bloque para la ventana de búsqueda: una racha de
 *  `*:tool_use` consecutivos es UNA posición, ídem `*:tool_result`. */
function posicionesDe(tipos: string[]): number[] {
  const pos: number[] = new Array<number>(tipos.length);
  let p = -1;
  let racha = "";
  for (let i = 0; i < tipos.length; i++) {
    const t = tipos[i]!;
    const esRacha = t.endsWith(":tool_use") || t.endsWith(":tool_result");
    if (!(esRacha && t === racha)) p += 1;
    racha = esRacha ? t : "";
    pos[i] = p;
  }
  return pos;
}

/** El peso de un bloque en el reparto de la entrada real: sus bytes, salvo
 *  las imágenes, que se topan (ver BYTES_PESO_IMAGEN). */
function pesoDe(tipo: string, bytes: number): number {
  return tipo.endsWith(":image") ? Math.min(bytes, BYTES_PESO_IMAGEN) : bytes;
}

/**
 * EL SIMULADOR, en forma INCREMENTAL: una cadena por (sesión, modelo) y
 * variante, alimentada turno a turno. Es la misma pieza para el replay del
 * corpus (que la recorre entera) y para el carril sombra vivo del gateway
 * (que le da el turno recién servido y usa el coste de ESE paso).
 *
 * El modelo es el de la doc del proveedor («how automatic prefix checking
 * works»), calibrado contra el contador real del corpus (error de escritura
 * del baseline: 66 % → 3 % en el modelo principal):
 *   · un breakpoint (`cache_control`) escribe UNA entrada: el hash acumulado
 *     del prefijo que acaba en él; nada se escribe en posiciones anteriores;
 *   · la lectura busca hacia atrás desde cada breakpoint, límite de bloque a
 *     límite de bloque, hasta VENTANA_DE_BUSQUEDA posiciones, una entrada
 *     VIVA que escribiera una petición anterior (de esta sesión o de otra:
 *     la caché es de la organización);
 *   · lo anterior al acierto se LEE; lo que va del acierto al último
 *     breakpoint se ESCRIBE a la prima de la marca que lo cubre; lo que va
 *     tras el último breakpoint es ENTRADA sin caché (`input_tokens`);
 *   · cada entrada caduca por su propio TTL, medido desde el inicio de la
 *     petición que la escribió o la leyó por última vez (la lectura refresca
 *     TODO el prefijo leído).
 * Un turno sin ningún marcador NO toca la caché: todo su prompt es entrada a
 * precio de lista (la doc dice que sin marcador no hay caché, y el contador del
 * proveedor lo confirma en los 15 turnos del corpus sin marca: cw = cr = 0).
 * Los tokens por bloque se calibran contra el contador REAL del proveedor:
 * tokens_bloque = entradaReal × peso_bloque / peso_turno.
 */
export class CadenaDeSimulacion {
  private readonly estado = estadoNuevo();
  private readonly cache: CacheDePrefijos;
  /** El turno anterior, solo para atribuir la INVALIDACIÓN (qué se reescribe
   *  porque algo anterior cambió); los aciertos salen de la caché. */
  private previo: { clave: string; bytes: number }[] = [];
  private previoUltimoBp = -1;
  private previoTtl: "1h" | "5m" = "5m";
  private hayPrevio = false;
  private atPrevio = 0;
  readonly acumulado = costeVacio();

  constructor(
    private readonly transformar: (
      bloques: BloqueSombra[],
      estado: EstadoSesion,
      turno: number,
    ) => { clave: string; bytes: number }[],
    /** La caché de prefijos compartida entre las cadenas del mismo modelo y
     *  variante; sin ella la cadena usa una propia (sesión aislada). */
    cache?: CacheDePrefijos,
  ) {
    this.cache = cache ?? new CacheDePrefijos();
  }

  /** Procesa un turno y devuelve el coste de ESE paso (además de acumular). */
  paso(t: TurnoSombra): CosteSimulado {
    const delPaso = costeVacio();
    const turno = avanzarEstado(this.estado, t.bloques);
    const precios = preciosPara(t.model, t.at);
    // La transformación conserva número y orden de bloques: tipo y marca se
    // toman del bloque original en la misma posición (un muñón hereda el
    // breakpoint del bloque que sustituye).
    const trans = this.transformar(t.bloques, this.estado, turno);
    if (!precios || t.entradaReal <= 0 || trans.length === 0) {
      // Sin precio o sin entrada no hay nada que simular, pero el turno SIGUIENTE
      // empareja su invalidación contra `previo` con el corte de ESTE: se reinicia
      // el corte para no arrastrar el del turno anterior sobre un previo nuevo.
      this.previo = trans;
      this.previoUltimoBp = -1;
      this.previoTtl = "5m";
      this.hayPrevio = true;
      this.atPrevio = t.at;
      return delPaso;
    }
    const tipos = trans.map((_, i) => t.bloques[i]?.tipo ?? "");
    const marcas: MarcaDeCache[] = trans.map((_, i) => t.bloques[i]?.marca ?? null);

    // Reparto de la entrada real por peso (bytes, imágenes topadas).
    const pesoOriginal = t.bloques.reduce((s, b) => s + pesoDe(b.tipo, b.bytes), 0);
    const tokensPorPeso = pesoOriginal > 0 ? t.entradaReal / pesoOriginal : 0;
    const tokensDe = trans.map((b, i) => pesoDe(tipos[i]!, b.bytes) * tokensPorPeso);

    const hashes = hashesDePrefijo(t.model, trans.map((b) => b.clave));
    const posiciones = posicionesDe(tipos);
    let bps = marcas.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
    if (bps.length === 0) {
      // SIN MARCADOR NO HAY CACHÉ. La doc lo dice y el contador del proveedor lo
      // confirma: en los 15 turnos del corpus sin ningún cache_control, cw = 0 y
      // cr = 0 — todo input_tokens. Un breakpoint implícito los escribía a prima y
      // dejaba en la caché compartida entradas que el proveedor nunca creó (+1,4 %
      // de escritura en fable-5 frente al oráculo). Se cobra todo a ENTRADA y el
      // turno no toca la caché; el prefijo para invalidación se reinicia.
      for (let i = 0; i < trans.length; i++) {
        delPaso.tokensEntrada += tokensDe[i]!;
        delPaso.entradaUsd += (tokensDe[i]! / 1_000) * precios.inputPer1k;
      }
      delPaso.totalUsd = delPaso.entradaUsd;
      this.previo = trans;
      this.previoUltimoBp = -1;
      this.previoTtl = "5m";
      this.hayPrevio = true;
      this.atPrevio = t.at;
      this.acumulado.tokensEntrada += delPaso.tokensEntrada;
      this.acumulado.entradaUsd += delPaso.entradaUsd;
      this.acumulado.totalUsd += delPaso.totalUsd;
      return delPaso;
    }

    // Acierto: el límite de bloque más lejano con entrada viva, buscando
    // hacia atrás desde cada breakpoint dentro de su ventana.
    let acierto = -1;
    for (const bp of bps) {
      const posMinima = posiciones[bp]! - (VENTANA_DE_BUSQUEDA - 1);
      for (let i = bp; i >= 0 && posiciones[i]! >= posMinima; i--) {
        if (this.cache.viva(hashes[i]!, t.at)) {
          if (i > acierto) acierto = i;
          break;
        }
      }
    }
    // Leer refresca TODO el prefijo leído; escribir crea las entradas de los
    // breakpoints posteriores al acierto.
    for (let i = 0; i <= acierto; i++) this.cache.refrescar(hashes[i]!, t.at);
    const ultimoBp = bps[bps.length - 1]!;
    for (const bp of bps) if (bp > acierto) this.cache.escribir(hashes[bp]!, t.at, marcas[bp]!);

    // Contabilidad por bloque. La prima de escritura de un bloque es la de la
    // marca del primer breakpoint que lo cubre.
    let idxBp = 0;
    // Invalidación: bloques escritos que existían IDÉNTICOS en el turno
    // anterior, dentro de lo que aquel dejó cacheado y más allá del acierto —
    // se reescriben solo porque algo anterior cambió. Una caducidad no es
    // invalidación: si el prefijo del turno previo ya expiró, no se atribuye.
    const caducado = this.hayPrevio && t.at - this.atPrevio > TTL_MS[this.previoTtl];
    const previoRestante = caducado ? [] : this.previo.slice(acierto + 1, this.previoUltimoBp + 1);
    let cursor = 0;
    for (let i = 0; i < trans.length; i++) {
      const bloque = trans[i]!;
      const tokens = tokensDe[i]!;
      if (i <= acierto) {
        delPaso.tokensLeidos += tokens;
        delPaso.lecturaUsd += (tokens / 1_000) * precios.lecturaPer1k;
        continue;
      }
      if (i > ultimoBp) {
        delPaso.tokensEntrada += tokens;
        delPaso.entradaUsd += (tokens / 1_000) * precios.inputPer1k;
        continue;
      }
      while (bps[idxBp]! < i) idxBp += 1;
      const precioEscritura = marcas[bps[idxBp]!] === "1h" ? precios.escritura1hPer1k : precios.escrituraPer1k;
      delPaso.tokensEscritos += tokens;
      delPaso.escrituraUsd += (tokens / 1_000) * precioEscritura;
      // Mirar hacia delante SIN consumir: si este bloque no está en el resto
      // del turno previo, el cursor se queda donde estaba — consumirlo en el
      // fallo dejaba sin emparejar (y sin cobrar como invalidación) todos
      // los bloques idénticos que venían detrás.
      let j = cursor;
      while (j < previoRestante.length && previoRestante[j]!.clave !== bloque.clave) j += 1;
      if (j < previoRestante.length) {
        if (previoRestante[j]!.bytes === bloque.bytes) {
          delPaso.tokensInvalidados += tokens;
          delPaso.invalidacionUsd += (tokens / 1_000) * (precioEscritura - precios.lecturaPer1k);
        }
        cursor = j + 1;
      }
    }
    this.previo = trans;
    this.previoUltimoBp = ultimoBp;
    this.previoTtl = marcas[ultimoBp] ?? "5m";
    this.hayPrevio = true;
    this.atPrevio = t.at;

    delPaso.totalUsd = delPaso.lecturaUsd + delPaso.escrituraUsd + delPaso.entradaUsd;
    this.acumulado.lecturaUsd += delPaso.lecturaUsd;
    this.acumulado.escrituraUsd += delPaso.escrituraUsd;
    this.acumulado.entradaUsd += delPaso.entradaUsd;
    this.acumulado.totalUsd += delPaso.totalUsd;
    this.acumulado.tokensLeidos += delPaso.tokensLeidos;
    this.acumulado.tokensEscritos += delPaso.tokensEscritos;
    this.acumulado.tokensEntrada += delPaso.tokensEntrada;
    this.acumulado.tokensInvalidados += delPaso.tokensInvalidados;
    this.acumulado.invalidacionUsd += delPaso.invalidacionUsd;
    return delPaso;
  }
}

/** Una sesión entera de una tacada (el replay del corpus). */
export function simularSesion(
  turnos: TurnoSombra[],
  transformar: (bloques: BloqueSombra[], estado: EstadoSesion, turno: number) => { clave: string; bytes: number }[],
  cache?: CacheDePrefijos,
): CosteSimulado {
  const cadena = new CadenaDeSimulacion(transformar, cache);
  for (const t of turnos) cadena.paso(t);
  return cadena.acumulado;
}

/** La transformación identidad: el baseline del simulador. */
export function identidad(bloques: BloqueSombra[]): { clave: string; bytes: number }[] {
  return bloques.map((b) => ({ clave: b.clave, bytes: b.bytes }));
}
