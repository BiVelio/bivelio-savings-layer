import { createHash } from "node:crypto";

import { precioDeLista } from "../src/pricing/catalogo.js";
import { PRIMA_ESCRITURA_CACHE_1H, primaDeEscritura } from "./medidor.js";

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

/** Un bloque del prompt, compactado: SIN contenido. */
export interface BloqueSombra {
  /** Identidad estable del bloque: hash del contenido serializado. Un
   *  tool_result que se reenvía idéntico turno tras turno conserva su clave —
   *  así se le puede poner edad. */
  clave: string;
  /** `rol:tipo` (p. ej. `user:tool_result`, `assistant:text`, `system`). */
  tipo: string;
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

/**
 * Compacta un cuerpo de /v1/messages a la lista de bloques que el motor
 * necesita. ÚNICO punto que ve contenido; lo que devuelve no lo lleva.
 */
export function compactarCuerpo(cuerpo: { messages?: unknown; system?: unknown; tools?: unknown }): BloqueSombra[] {
  const bloques: BloqueSombra[] = [];
  const anota = (tipo: string, valor: unknown) => {
    const bytes = bytesDe(valor);
    const b: BloqueSombra = {
      clave: createHash("sha256").update(typeof valor === "string" ? valor : JSON.stringify(valor ?? "")).digest("hex").slice(0, 16),
      tipo,
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
  if ((cuerpo.system ?? undefined) !== undefined) anota("system", cuerpo.system);
  if (Array.isArray(cuerpo.tools)) for (const t of cuerpo.tools) anota("tools", t);
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
  /** ¿La escritura real del turno fue con TTL 1h? (decide la prima simulada). */
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
  lecturaPer1k: number;
  escrituraPer1k: number;
  escritura1hPer1k: number;
}

export function preciosPara(model: string): PreciosSimulados | null {
  const precio = precioDeLista(model);
  if (!precio) return null;
  return {
    lecturaPer1k: precio.cachedInputPer1k ?? precio.inputPer1k,
    escrituraPer1k: precio.inputPer1k * primaDeEscritura(model),
    escritura1hPer1k: precio.inputPer1k * PRIMA_ESCRITURA_CACHE_1H,
  };
}

/** Desglose en dólares de una variante simulada sobre una sesión. */
export interface CosteSimulado {
  lecturaUsd: number;
  escrituraUsd: number;
  totalUsd: number;
  tokensLeidos: number;
  tokensEscritos: number;
  /** Tokens reescritos SOLO porque un cambio anterior rompió el prefijo: el
   *  bloque existía idéntico en el turno previo más allá del punto de rotura.
   *  Este es el coste de invalidación que el plan obliga a restar SIEMPRE. */
  tokensInvalidados: number;
  invalidacionUsd: number;
}

function costeVacio(): CosteSimulado {
  return { lecturaUsd: 0, escrituraUsd: 0, totalUsd: 0, tokensLeidos: 0, tokensEscritos: 0, tokensInvalidados: 0, invalidacionUsd: 0 };
}

/** TTLs de la caché de prefijo, en ms. */
const TTL_MS = { "1h": 3_600_000, "5m": 300_000 } as const;

/**
 * EL SIMULADOR, en forma INCREMENTAL: una cadena por (sesión, modelo) y
 * variante, alimentada turno a turno. Es la misma pieza para el replay del
 * corpus (que la recorre entera) y para el carril sombra vivo del gateway
 * (que le da el turno recién servido y usa el coste de ESE paso).
 *
 * Modelo: el prefijo común (a nivel de bloque) con el turno anterior se lee a
 * precio de lectura; el resto se ESCRIBE a la prima del TTL real del turno; si
 * el hueco entre turnos supera el TTL, el prefijo caduca y se reescribe entero
 * — igual que la caché real. Los tokens por bloque se calibran contra el
 * contador REAL del proveedor: tokens_bloque = entradaReal × bytes_bloque /
 * bytes_turno (la misma calibración por bytes del análisis S1).
 */
export class CadenaDeSimulacion {
  private readonly estado = estadoNuevo();
  private previo: { clave: string; bytes: number }[] = [];
  private hayPrevio = false;
  private atPrevio = 0;
  readonly acumulado = costeVacio();

  constructor(
    private readonly transformar: (
      bloques: BloqueSombra[],
      estado: EstadoSesion,
      turno: number,
    ) => { clave: string; bytes: number }[],
  ) {}

  /** Procesa un turno y devuelve el coste de ESE paso (además de acumular). */
  paso(t: TurnoSombra): CosteSimulado {
    const delPaso = costeVacio();
    const turno = avanzarEstado(this.estado, t.bloques);
    const precios = preciosPara(t.model);
    const trans = this.transformar(t.bloques, this.estado, turno);
    if (!precios || t.entradaReal <= 0) {
      this.previo = trans;
      this.hayPrevio = true;
      this.atPrevio = t.at;
      return delPaso;
    }
    const bytesOriginales = t.bloques.reduce((s, b) => s + b.bytes, 0);
    const tokensPorByte = bytesOriginales > 0 ? t.entradaReal / bytesOriginales : 0;
    const ttl = TTL_MS[t.escritura1h ? "1h" : "5m"];
    const caducado = this.hayPrevio && t.at - this.atPrevio > ttl;

    // Prefijo común con el turno anterior, a nivel de bloque.
    let prefijo = 0;
    if (!caducado) {
      while (
        prefijo < trans.length &&
        prefijo < this.previo.length &&
        trans[prefijo]!.clave === this.previo[prefijo]!.clave &&
        trans[prefijo]!.bytes === this.previo[prefijo]!.bytes
      ) {
        prefijo += 1;
      }
    }

    // Invalidación: bloques escritos que existían IDÉNTICOS en el turno
    // anterior más allá del punto de rotura — se reescriben solo porque algo
    // anterior cambió. Emparejamiento en orden (subsecuencia).
    const previoRestante = this.previo.slice(prefijo);
    let cursor = 0;
    const precioEscritura = t.escritura1h ? precios.escritura1hPer1k : precios.escrituraPer1k;
    for (let i = 0; i < trans.length; i++) {
      const bloque = trans[i]!;
      const tokens = bloque.bytes * tokensPorByte;
      if (i < prefijo) {
        delPaso.tokensLeidos += tokens;
        delPaso.lecturaUsd += (tokens / 1_000) * precios.lecturaPer1k;
        continue;
      }
      delPaso.tokensEscritos += tokens;
      delPaso.escrituraUsd += (tokens / 1_000) * precioEscritura;
      if (!caducado) {
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
    }
    this.previo = trans;
    this.hayPrevio = true;
    this.atPrevio = t.at;

    delPaso.totalUsd = delPaso.lecturaUsd + delPaso.escrituraUsd;
    this.acumulado.lecturaUsd += delPaso.lecturaUsd;
    this.acumulado.escrituraUsd += delPaso.escrituraUsd;
    this.acumulado.totalUsd += delPaso.totalUsd;
    this.acumulado.tokensLeidos += delPaso.tokensLeidos;
    this.acumulado.tokensEscritos += delPaso.tokensEscritos;
    this.acumulado.tokensInvalidados += delPaso.tokensInvalidados;
    this.acumulado.invalidacionUsd += delPaso.invalidacionUsd;
    return delPaso;
  }
}

/** Una sesión entera de una tacada (el replay del corpus). */
export function simularSesion(
  turnos: TurnoSombra[],
  transformar: (bloques: BloqueSombra[], estado: EstadoSesion, turno: number) => { clave: string; bytes: number }[],
): CosteSimulado {
  const cadena = new CadenaDeSimulacion(transformar);
  for (const t of turnos) cadena.paso(t);
  return cadena.acumulado;
}

/** La transformación identidad: el baseline del simulador. */
export function identidad(bloques: BloqueSombra[]): { clave: string; bytes: number }[] {
  return bloques.map((b) => ({ clave: b.clave, bytes: b.bytes }));
}
