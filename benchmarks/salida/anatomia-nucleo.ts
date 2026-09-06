/**
 * SALIDA · ANATOMÍA — NÚCLEO PURO. Antes de tocar el dinero de SALIDA hay que
 * saber DÓNDE está: en el corpus real del dueño la salida es el 0,3 % de los
 * tokens pero el 11,6 % del dinero (se paga ×5 y jamás viene de caché). Un
 * skill de «salida tersa» solo puede acortar el TEXTO para el humano; no
 * acorta el JSON de un tool_use (una escritura de fichero pesa lo que pesa el
 * fichero) ni el thinking. Este módulo reparte cada respuesta en esas masas y
 * mide dos cosas que ningún contador del proveedor da: cuánto se TRUNCA
 * (stop_reason max_tokens) y cuánto REPITE lo que el modelo acaba de leer.
 *
 * Todo aquí es puro y determinista; la lectura de capturas y la escritura del
 * artefacto viven en anatomia.ts. PRIVACIDAD: las funciones que entran en
 * contacto con contenido (`ultimoToolResult`, `fraccionRepetida`,
 * `anatomiaDeSse`) lo devuelven SOLO como números; el texto vive en memoria el
 * tiempo de una llamada y se descarta.
 *
 * Unidad de caracteres: `String.length` (unidades UTF-16). El proxy de tokens
 * que se cita es chars/4 — es un proxy, no una medida: el contador real de
 * tokens de salida es `usage.output_tokens`, y el informe trae la razón
 * chars/token medida para calibrarlo.
 */
import type { UsoSse } from "../../gateway/medidor.js";

export { usageFusionado } from "../anillo2/nucleo.js";

/** Longitud del shingle de la heurística de repetición (caracteres). */
export const SHINGLE = 40;

/** Tipos de bloque de contenido que distinguimos; lo demás va a «otros»
 *  (redacted_thinking, server_tool_use, …). */
export type TipoBloque = "text" | "tool_use" | "thinking" | "otros";

/** El usage de un registro, con el desglose de salida que UsoSse no declara. */
export type UsoConSalida = UsoSse & { output_tokens_details?: { thinking_tokens?: number } };

/** Una respuesta reducida a números: lo único que sale del núcleo. */
export interface AnatomiaRespuesta {
  /** Caracteres por tipo de bloque. */
  chars: Record<TipoBloque, number>;
  /** Bloques por tipo. */
  bloques: Record<TipoBloque, number>;
  /** Por nombre de herramienta: llamadas y caracteres del input_json. */
  herramientas: Record<string, { llamadas: number; chars: number }>;
  stopReason: string | null;
  /** Fracción de shingles del texto para el humano ya presentes en el último
   *  tool_result de la petición; null si no procede (sin texto suficiente o
   *  sin tool_result). */
  repeticion: number | null;
  /**
   * Suma de `estimated_tokens` de los thinking_delta. Sondeado en el corpus
   * (06-09): el proveedor manda el thinking VACÍO (`thinking: ""`) con una
   * estimación de tokens por delta; el contenido no viaja, así que los
   * caracteres de thinking son 0 por construcción y la masa de thinking se
   * mide en TOKENS (usage.output_tokens_details.thinking_tokens, con esta suma
   * como contraste).
   */
  thinkingTokensEstimados: number;
  /** Caracteres de signature_delta: no son salida legible ni se facturan como
   *  salida, pero vuelven como ENTRADA (el bloque thinking firmado se reenvía)
   *  — se cuentan aparte para que nadie los confunda con texto. */
  charsFirma: number;
  /** Como `repeticion`, pero contra TODO el texto previo del cuerpo (usuario,
   *  asistente y tool_results): «repite lo ya dicho» en sentido amplio. */
  repeticionCuerpo: number | null;
  /** Nombres de tipo de los bloques «otros» (solo el nombre del tipo). */
  tiposOtros: Record<string, number>;
}

function vacia(): AnatomiaRespuesta {
  return {
    chars: { text: 0, tool_use: 0, thinking: 0, otros: 0 },
    bloques: { text: 0, tool_use: 0, thinking: 0, otros: 0 },
    herramientas: {},
    stopReason: null,
    repeticion: null,
    thinkingTokensEstimados: 0,
    charsFirma: 0,
    repeticionCuerpo: null,
    tiposOtros: {},
  };
}

function clasificar(tipo: unknown): TipoBloque {
  return tipo === "text" || tipo === "tool_use" || tipo === "thinking" ? tipo : "otros";
}

/**
 * El texto del ÚLTIMO tool_result del último mensaje del cuerpo — lo que el
 * modelo acaba de leer. `content` viene como string (Claude Code) o como lista
 * de bloques text (la API también lo admite); los bloques que no son texto
 * (imágenes, documentos) no cuentan. null si el último mensaje no cierra con
 * un tool_result: la respuesta no contesta a una herramienta y la heurística
 * no aplica.
 */
export function ultimoToolResult(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const ultimo = messages[messages.length - 1] as { content?: unknown } | null;
  if (!ultimo || !Array.isArray(ultimo.content)) return null;
  for (let i = ultimo.content.length - 1; i >= 0; i--) {
    const b = ultimo.content[i] as { type?: unknown; content?: unknown } | null;
    if (!b || b.type !== "tool_result") continue;
    if (typeof b.content === "string") return b.content;
    if (Array.isArray(b.content)) {
      return b.content
        .filter((x): x is { text: string } => x !== null && typeof x === "object" && typeof (x as { text?: unknown }).text === "string")
        .map((x) => x.text)
        .join("\n");
    }
    return null;
  }
  return null;
}

/**
 * TODO el texto previo del cuerpo, concatenado: texto del usuario, texto del
 * asistente y tool_results (string o bloques text). Los inputs de tool_use no
 * (son JSON, no prosa). Es la fuente de `repeticionCuerpo`; vive lo que dura
 * la llamada.
 */
export function textoDelCuerpo(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const trozos: string[] = [];
  for (const m of messages as { content?: unknown }[]) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.content === "string") {
      trozos.push(m.content);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as { type?: unknown; text?: unknown; content?: unknown }[]) {
      if (!b || typeof b !== "object") continue;
      if (typeof b.text === "string") trozos.push(b.text);
      else if (b.type === "tool_result") {
        if (typeof b.content === "string") trozos.push(b.content);
        else if (Array.isArray(b.content)) for (const x of b.content as { text?: unknown }[]) if (typeof x?.text === "string") trozos.push(x.text);
      }
    }
  }
  return trozos.join("\n");
}

/**
 * Heurística de «repite lo ya dicho»: fracción de los shingles DISTINTOS de
 * `n` caracteres del texto que aparecen tal cual en `fuente`. Distintos, no
 * con multiplicidad: un texto que pega una línea diez veces no vale diez.
 * Se construye el conjunto sobre el TEXTO (pequeño) y se barre la fuente una
 * sola vez: O(|texto| + |fuente|) y sin conjunto del tamaño del tool_result.
 * null si el texto no llega a un shingle.
 */
export function fraccionRepetida(texto: string, fuente: string, n = SHINGLE): number | null {
  if (texto.length < n) return null;
  const buscados = new Set<string>();
  for (let i = 0; i + n <= texto.length; i++) buscados.add(texto.slice(i, i + n));
  if (fuente.length < n) return 0;
  const hallados = new Set<string>();
  for (let i = 0; i + n <= fuente.length; i++) {
    const s = fuente.slice(i, i + n);
    if (buscados.has(s)) {
      hallados.add(s);
      if (hallados.size === buscados.size) break;
    }
  }
  return hallados.size / buscados.size;
}

/**
 * Anatomía de un cuerpo SSE crudo (la forma sondeada en las capturas:
 * content_block_start trae el tipo y, en tool_use, el `name`; los deltas
 * traen text/partial_json/thinking; message_delta trae stop_reason). Los
 * deltas se atribuyen por `index` al bloque abierto con ese índice.
 * `toolResult` es el último tool_result de la petición, para la repetición.
 */
/** Las fuentes contra las que se mide la repetición; null = no procede. */
export interface FuentesRepeticion {
  ultimoToolResult: string | null;
  cuerpo: string | null;
}

function medirRepeticion(a: AnatomiaRespuesta, texto: string[], fuentes: FuentesRepeticion | null): void {
  if (!fuentes) return;
  const t = texto.join("");
  a.repeticion = fuentes.ultimoToolResult === null ? null : fraccionRepetida(t, fuentes.ultimoToolResult);
  a.repeticionCuerpo = fuentes.cuerpo === null ? null : fraccionRepetida(t, fuentes.cuerpo);
}

export function anatomiaDeSse(utf8: string, fuentes: FuentesRepeticion | null = null): AnatomiaRespuesta {
  const a = vacia();
  const abiertos = new Map<number, { tipo: TipoBloque; nombre?: string }>();
  const texto: string[] = [];
  for (const bloque of utf8.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(bloque)?.[1];
    if (!ev || ev === "ping" || ev === "message_start" || ev === "message_stop" || ev === "content_block_stop") continue;
    const data = /^data: (.+)$/m.exec(bloque)?.[1];
    if (!data) continue;
    let d: {
      index?: number;
      content_block?: { type?: unknown; name?: unknown };
      delta?: {
        type?: unknown;
        text?: unknown;
        partial_json?: unknown;
        thinking?: unknown;
        estimated_tokens?: unknown;
        signature?: unknown;
        stop_reason?: unknown;
      };
    };
    try {
      d = JSON.parse(data) as typeof d;
    } catch {
      continue;
    }
    if (ev === "content_block_start" && typeof d.index === "number") {
      const tipo = clasificar(d.content_block?.type);
      const nombre = typeof d.content_block?.name === "string" ? d.content_block.name : undefined;
      abiertos.set(d.index, nombre !== undefined ? { tipo, nombre } : { tipo });
      a.bloques[tipo] += 1;
      if (tipo === "otros") {
        const t = typeof d.content_block?.type === "string" ? d.content_block.type : "?";
        a.tiposOtros[t] = (a.tiposOtros[t] ?? 0) + 1;
      }
      if (tipo === "tool_use") {
        const h = (a.herramientas[nombre ?? "?"] ??= { llamadas: 0, chars: 0 });
        h.llamadas += 1;
      }
    } else if (ev === "content_block_delta" && typeof d.index === "number") {
      const abierto = abiertos.get(d.index);
      const delta = d.delta ?? {};
      if (typeof delta.text === "string") {
        a.chars[abierto?.tipo ?? "text"] += delta.text.length;
        texto.push(delta.text);
      } else if (typeof delta.partial_json === "string") {
        a.chars[abierto?.tipo ?? "tool_use"] += delta.partial_json.length;
        if (abierto?.tipo === "tool_use") a.herramientas[abierto.nombre ?? "?"]!.chars += delta.partial_json.length;
      } else if (typeof delta.thinking === "string") {
        a.chars[abierto?.tipo ?? "thinking"] += delta.thinking.length;
        if (typeof delta.estimated_tokens === "number") a.thinkingTokensEstimados += delta.estimated_tokens;
      } else if (typeof delta.signature === "string") {
        a.charsFirma += delta.signature.length;
      }
    } else if (ev === "message_delta" && typeof d.delta?.stop_reason === "string") {
      a.stopReason = d.delta.stop_reason;
    }
  }
  medirRepeticion(a, texto, fuentes);
  return a;
}

/**
 * Anatomía de una respuesta JSON (`stream: false`): el mismo reparto, leído
 * del `content` ya ensamblado. El input de un tool_use es un objeto: sus
 * caracteres son los de su JSON compacto (lo que el modelo emitió, salvo
 * espacios).
 */
export function anatomiaDeJson(utf8: string, fuentes: FuentesRepeticion | null = null): AnatomiaRespuesta | null {
  const a = vacia();
  let d: { content?: unknown; stop_reason?: unknown };
  try {
    d = JSON.parse(utf8) as typeof d;
  } catch {
    return null;
  }
  if (!Array.isArray(d.content)) return null;
  const texto: string[] = [];
  for (const b of d.content as { type?: unknown; text?: unknown; thinking?: unknown; input?: unknown; name?: unknown }[]) {
    const tipo = clasificar(b?.type);
    a.bloques[tipo] += 1;
    if (tipo === "otros") {
      const t = typeof b?.type === "string" ? b.type : "?";
      a.tiposOtros[t] = (a.tiposOtros[t] ?? 0) + 1;
    }
    if (tipo === "text" && typeof b.text === "string") {
      a.chars.text += b.text.length;
      texto.push(b.text);
    } else if (tipo === "thinking" && typeof b.thinking === "string") {
      a.chars.thinking += b.thinking.length;
    } else if (tipo === "tool_use") {
      const chars = b.input === undefined ? 0 : JSON.stringify(b.input).length;
      a.chars.tool_use += chars;
      const h = (a.herramientas[typeof b.name === "string" ? b.name : "?"] ??= { llamadas: 0, chars: 0 });
      h.llamadas += 1;
      h.chars += chars;
    }
  }
  a.stopReason = typeof d.stop_reason === "string" ? d.stop_reason : null;
  medirRepeticion(a, texto, fuentes);
  return a;
}

// ── Agregación ──

/** Una petición ya reducida a números, lista para agregar. */
export interface MedidaPeticion {
  model: string;
  tokensSalida: number;
  thinkingTokens: number;
  salidaUsd: number;
  entradaUsd: number;
  /** null cuando el cuerpo de respuesta no está (omitido por el espía o ilegible). */
  anatomia: AnatomiaRespuesta | null;
}

/** El acumulador de un estrato (un modelo, o el global). */
export interface Acumulador {
  peticiones: number;
  conCuerpo: number;
  tokensSalida: number[];
  thinkingTokens: number;
  salidaUsd: number;
  entradaUsd: number;
  chars: Record<TipoBloque, number>;
  bloques: Record<TipoBloque, number>;
  herramientas: Record<string, { llamadas: number; chars: number }>;
  stopReason: Record<string, number>;
  /** Tokens de salida de las peticiones truncadas por max_tokens. */
  tokensTruncados: number;
  repeticion: number[];
  /** Peso de cada repetición (shingles del texto, ≈ chars−39): para la media ponderada. */
  repeticionPeso: number[];
  thinkingTokensEstimados: number;
  charsFirma: number;
  repeticionCuerpo: number[];
  repeticionCuerpoPeso: number[];
  tiposOtros: Record<string, number>;
  /**
   * Calibración del proxy de caracteres, MEDIDA en el propio estrato: chars y
   * tokens visibles (salida − thinking) de las respuestas casi puras de prosa
   * (text ≥ 90 % de los chars visibles) y casi puras de JSON (tool_use ≥ 90 %).
   * Sondeado el 06-09: la prosa factura ~2,3 chars/token y el JSON ~1,7 —
   * repartir el dinero por caracteres infla el texto frente al JSON.
   */
  calibracion: { prosaChars: number; prosaTokens: number; nProsa: number; jsonChars: number; jsonTokens: number; nJson: number };
  /**
   * El dinero de salida repartido por MASA, petición a petición: el thinking
   * por su cuenta de tokens (exacta), y el resto por proxy de caracteres entre
   * text / tool_use / otros. Sumado por petición para que agregue exacto por
   * modelo (el precio es constante dentro de un modelo) y el global sea la suma.
   * `sinCuerpo` = salida de peticiones sin cuerpo: no reparte.
   */
  dineroPorMasa: { thinking: number; text: number; tool_use: number; otros: number; sinCuerpo: number };
}

export function acumuladorVacio(): Acumulador {
  return {
    peticiones: 0,
    conCuerpo: 0,
    tokensSalida: [],
    thinkingTokens: 0,
    salidaUsd: 0,
    entradaUsd: 0,
    chars: { text: 0, tool_use: 0, thinking: 0, otros: 0 },
    bloques: { text: 0, tool_use: 0, thinking: 0, otros: 0 },
    herramientas: {},
    stopReason: {},
    tokensTruncados: 0,
    repeticion: [],
    repeticionPeso: [],
    thinkingTokensEstimados: 0,
    charsFirma: 0,
    repeticionCuerpo: [],
    repeticionCuerpoPeso: [],
    tiposOtros: {},
    calibracion: { prosaChars: 0, prosaTokens: 0, nProsa: 0, jsonChars: 0, jsonTokens: 0, nJson: 0 },
    dineroPorMasa: { thinking: 0, text: 0, tool_use: 0, otros: 0, sinCuerpo: 0 },
  };
}

/** Umbrales de la calibración: respuestas con al menos este número de chars
 *  visibles y esta pureza de un tipo. */
export const CALIB_MIN_CHARS = 200;
export const CALIB_PUREZA = 0.9;

/**
 * Reparte el dinero de salida de UNA petición por masa. El thinking va por
 * tokens (usage), acotado a la salida; lo visible (text/tool_use/otros) se
 * reparte por caracteres. Sin caracteres visibles ni thinking (respuesta
 * vacía), lo que quede va a «otros» para que nada se pierda.
 */
export function repartirDinero(
  m: Pick<MedidaPeticion, "tokensSalida" | "thinkingTokens" | "salidaUsd">,
  chars: Record<TipoBloque, number>,
): { thinking: number; text: number; tool_use: number; otros: number } {
  const fraccionThinking = m.tokensSalida > 0 ? Math.min(1, m.thinkingTokens / m.tokensSalida) : 0;
  const thinking = m.salidaUsd * fraccionThinking;
  const resto = m.salidaUsd - thinking;
  const visibles = chars.text + chars.tool_use + chars.otros;
  if (visibles === 0) return { thinking, text: 0, tool_use: 0, otros: resto };
  return {
    thinking,
    text: (resto * chars.text) / visibles,
    tool_use: (resto * chars.tool_use) / visibles,
    otros: (resto * chars.otros) / visibles,
  };
}

export function agregar(acum: Acumulador, m: MedidaPeticion): void {
  acum.peticiones += 1;
  acum.tokensSalida.push(m.tokensSalida);
  acum.thinkingTokens += m.thinkingTokens;
  acum.salidaUsd += m.salidaUsd;
  acum.entradaUsd += m.entradaUsd;
  const a = m.anatomia;
  if (!a) {
    acum.dineroPorMasa.sinCuerpo += m.salidaUsd;
    return;
  }
  acum.conCuerpo += 1;
  acum.thinkingTokensEstimados += a.thinkingTokensEstimados;
  acum.charsFirma += a.charsFirma;
  const reparto = repartirDinero(m, a.chars);
  acum.dineroPorMasa.thinking += reparto.thinking;
  acum.dineroPorMasa.text += reparto.text;
  acum.dineroPorMasa.tool_use += reparto.tool_use;
  acum.dineroPorMasa.otros += reparto.otros;
  for (const t of ["text", "tool_use", "thinking", "otros"] as const) {
    acum.chars[t] += a.chars[t];
    acum.bloques[t] += a.bloques[t];
  }
  for (const [nombre, h] of Object.entries(a.herramientas)) {
    const dest = (acum.herramientas[nombre] ??= { llamadas: 0, chars: 0 });
    dest.llamadas += h.llamadas;
    dest.chars += h.chars;
  }
  const stop = a.stopReason ?? "desconocido";
  acum.stopReason[stop] = (acum.stopReason[stop] ?? 0) + 1;
  if (stop === "max_tokens") acum.tokensTruncados += m.tokensSalida;
  const peso = Math.max(1, a.chars.text - SHINGLE + 1);
  if (a.repeticion !== null) {
    acum.repeticion.push(a.repeticion);
    acum.repeticionPeso.push(peso);
  }
  if (a.repeticionCuerpo !== null) {
    acum.repeticionCuerpo.push(a.repeticionCuerpo);
    acum.repeticionCuerpoPeso.push(peso);
  }
  for (const [t, n] of Object.entries(a.tiposOtros)) acum.tiposOtros[t] = (acum.tiposOtros[t] ?? 0) + n;
  const visibles = a.chars.text + a.chars.tool_use + a.chars.otros;
  const tokensVisibles = Math.max(0, m.tokensSalida - m.thinkingTokens);
  if (visibles >= CALIB_MIN_CHARS && tokensVisibles > 0) {
    const c = acum.calibracion;
    if (a.chars.text >= CALIB_PUREZA * visibles) {
      c.prosaChars += visibles;
      c.prosaTokens += tokensVisibles;
      c.nProsa += 1;
    } else if (a.chars.tool_use >= CALIB_PUREZA * visibles) {
      c.jsonChars += visibles;
      c.jsonTokens += tokensVisibles;
      c.nJson += 1;
    }
  }
}

/** Percentil por rango más cercano sobre una copia ordenada; 0 si vacío. */
export function percentil(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const orden = [...xs].sort((a, b) => a - b);
  const k = Math.min(orden.length - 1, Math.max(0, Math.ceil((p / 100) * orden.length) - 1));
  return orden[k]!;
}

const redondea = (x: number, d = 4) => Number(x.toFixed(d));
const share = (parte: number, todo: number) => (todo > 0 ? redondea(parte / todo) : 0);

/** El resumen publicable de un acumulador: solo cifras. */
export interface Resumen {
  peticiones: number;
  conCuerpo: number;
  tokensSalida: { total: number; media: number; p50: number; p95: number; max: number };
  /** Thinking en TOKENS (el contenido no viaja en el stream: chars = 0). */
  thinking: { tokens: number; shareDeSalida: number; tokensEstimadosEnDeltas: number };
  chars: {
    total: number;
    porTipo: Record<TipoBloque, number>;
    share: Record<TipoBloque, number>;
    /** Calibración del proxy chars/4: caracteres VISIBLES por token de salida
     *  NO-thinking (los tokens de thinking no tienen caracteres en el stream). */
    charsPorTokenVisible: number;
    /** Proxy de tokens = chars/4, por tipo. Es un PROXY. */
    proxyTokens: Record<TipoBloque, number>;
    /** signature_delta: ni legible ni salida facturada; vuelve como entrada. */
    firma: number;
    /** chars/token MEDIDOS en respuestas casi puras (≥90 %) de prosa y de JSON;
     *  0 si el estrato no tiene muestras de ese tipo. */
    calibracion: { prosaCharsPorToken: number; nProsa: number; jsonCharsPorToken: number; nJson: number };
  };
  bloques: Record<TipoBloque, number>;
  /** Nombres de tipo de los bloques «otros». */
  tiposOtros: Record<string, number>;
  /** Ordenadas por caracteres descendentes; share sobre los chars de tool_use. */
  herramientas: Record<string, { llamadas: number; chars: number; shareDeToolUse: number }>;
  stopReason: Record<string, number>;
  truncadas: { peticiones: number; share: number; tokensSalida: number };
  dinero: {
    salidaUsd: number;
    entradaUsd: number;
    shareSalida: number;
    /** USD de salida por masa (thinking por tokens; resto por proxy de chars). */
    porMasa: { thinking: number; text: number; tool_use: number; otros: number; sinCuerpo: number };
    /** La misma partición como fracción de la salida. */
    shareDeSalidaPorMasa: { thinking: number; text: number; tool_use: number; otros: number; sinCuerpo: number };
    /**
     * El reparto de lo VISIBLE corregido por la calibración medida (tokens ≈
     * chars/ratio de su tipo, normalizado a los tokens visibles). `calibrado`
     * es false cuando falta alguna muestra pura y se cae al proporcional.
     */
    porMasaCalibrado: { thinking: number; text: number; tool_use: number; otros: number; sinCuerpo: number; calibrado: boolean };
    shareDeSalidaPorMasaCalibrado: { thinking: number; text: number; tool_use: number; otros: number; sinCuerpo: number };
  };
  repeticion: Repeticion;
  /** La misma heurística contra todo el texto previo del cuerpo (mensajes; el
   *  system queda fuera). */
  repeticionCuerpo: Repeticion;
}

export interface Repeticion {
  n: number;
  media: number;
  /** Ponderada por shingles: la dominan las respuestas largas — ver los campos top5. */
  ponderada: number;
  p50: number;
  p95: number;
  /** Respuestas con alguna repetición (> 0). */
  conRepeticion: number;
  /** El 5 % de respuestas con más peso: cuánto peso concentran y su ponderada.
   *  Si `ponderada` está por encima de `p95`, es que vive aquí. */
  sharePesoTop5pct: number;
  ponderadaTop5pct: number;
}

function resumenRepeticion(valores: number[], pesos: number[]): Repeticion {
  const pesoTotal = pesos.reduce((a, b) => a + b, 0);
  const ponderada = pesoTotal ? valores.reduce((s, r, i) => s + r * pesos[i]!, 0) / pesoTotal : 0;
  // El 5 % de respuestas de más peso (mínimo 1): dónde vive la ponderada.
  const orden = valores.map((_, i) => i).sort((a, b) => pesos[b]! - pesos[a]! || a - b);
  const top = orden.slice(0, Math.max(1, Math.ceil(orden.length * 0.05)));
  const pesoTop = top.reduce((s, i) => s + pesos[i]!, 0);
  const ponderadaTop = pesoTop ? top.reduce((s, i) => s + valores[i]! * pesos[i]!, 0) / pesoTop : 0;
  return {
    n: valores.length,
    media: valores.length ? redondea(valores.reduce((a, b) => a + b, 0) / valores.length) : 0,
    ponderada: redondea(ponderada),
    p50: redondea(percentil(valores, 50)),
    p95: redondea(percentil(valores, 95)),
    conRepeticion: valores.filter((v) => v > 0).length,
    sharePesoTop5pct: pesoTotal ? redondea(pesoTop / pesoTotal) : 0,
    ponderadaTop5pct: redondea(ponderadaTop),
  };
}

export function resumir(acum: Acumulador): Resumen {
  const total = acum.tokensSalida.reduce((a, b) => a + b, 0);
  const charsTotal = acum.chars.text + acum.chars.tool_use + acum.chars.thinking + acum.chars.otros;
  const herramientas: Resumen["herramientas"] = {};
  for (const [nombre, h] of Object.entries(acum.herramientas).sort((a, b) => b[1].chars - a[1].chars)) {
    herramientas[nombre] = { ...h, shareDeToolUse: share(h.chars, acum.chars.tool_use) };
  }
  const truncadas = acum.stopReason["max_tokens"] ?? 0;
  const c = acum.calibracion;
  const ratioProsa = c.prosaTokens > 0 ? c.prosaChars / c.prosaTokens : 0;
  const ratioJson = c.jsonTokens > 0 ? c.jsonChars / c.jsonTokens : 0;
  const calibrado = ratioProsa > 0 && ratioJson > 0;
  // Lo visible en dinero = salida − thinking − sinCuerpo; se reparte por
  // tokens estimados con el ratio de cada tipo (o por chars si no hay calibración).
  const visibleUsd = acum.dineroPorMasa.text + acum.dineroPorMasa.tool_use + acum.dineroPorMasa.otros;
  const rp = calibrado ? ratioProsa : 1;
  const rj = calibrado ? ratioJson : 1;
  const tokText = acum.chars.text / rp;
  const tokJson = acum.chars.tool_use / rj;
  const tokOtros = acum.chars.otros / rj;
  const tokVis = tokText + tokJson + tokOtros;
  // Sin calibración, el «calibrado» ES el proporcional por petición: nada de
  // un segundo reparto agregado que difiera del primero sin motivo.
  const porMasaCalibrado = calibrado
    ? {
        thinking: acum.dineroPorMasa.thinking,
        text: tokVis > 0 ? (visibleUsd * tokText) / tokVis : 0,
        tool_use: tokVis > 0 ? (visibleUsd * tokJson) / tokVis : 0,
        otros: tokVis > 0 ? (visibleUsd * tokOtros) / tokVis : visibleUsd,
        sinCuerpo: acum.dineroPorMasa.sinCuerpo,
      }
    : { ...acum.dineroPorMasa };
  const tipos = ["text", "tool_use", "thinking", "otros"] as const;
  const proxy = {} as Record<TipoBloque, number>;
  const shares = {} as Record<TipoBloque, number>;
  for (const t of tipos) {
    proxy[t] = Math.round(acum.chars[t] / 4);
    shares[t] = share(acum.chars[t], charsTotal);
  }
  return {
    peticiones: acum.peticiones,
    conCuerpo: acum.conCuerpo,
    tokensSalida: {
      total,
      media: acum.peticiones ? redondea(total / acum.peticiones, 1) : 0,
      p50: percentil(acum.tokensSalida, 50),
      p95: percentil(acum.tokensSalida, 95),
      max: acum.tokensSalida.length ? Math.max(...acum.tokensSalida) : 0,
    },
    thinking: {
      tokens: acum.thinkingTokens,
      shareDeSalida: share(acum.thinkingTokens, total),
      tokensEstimadosEnDeltas: acum.thinkingTokensEstimados,
    },
    chars: {
      total: charsTotal,
      porTipo: { ...acum.chars },
      share: shares,
      charsPorTokenVisible: total - acum.thinkingTokens > 0 ? redondea(charsTotal / (total - acum.thinkingTokens), 2) : 0,
      proxyTokens: proxy,
      firma: acum.charsFirma,
      calibracion: {
        prosaCharsPorToken: redondea(ratioProsa, 2),
        nProsa: c.nProsa,
        jsonCharsPorToken: redondea(ratioJson, 2),
        nJson: c.nJson,
      },
    },
    bloques: { ...acum.bloques },
    tiposOtros: { ...acum.tiposOtros },
    herramientas,
    stopReason: { ...acum.stopReason },
    truncadas: { peticiones: truncadas, share: share(truncadas, acum.conCuerpo), tokensSalida: acum.tokensTruncados },
    dinero: {
      salidaUsd: redondea(acum.salidaUsd),
      entradaUsd: redondea(acum.entradaUsd),
      shareSalida: share(acum.salidaUsd, acum.salidaUsd + acum.entradaUsd),
      porMasa: Object.fromEntries(Object.entries(acum.dineroPorMasa).map(([k, v]) => [k, redondea(v)])) as Resumen["dinero"]["porMasa"],
      shareDeSalidaPorMasa: Object.fromEntries(
        Object.entries(acum.dineroPorMasa).map(([k, v]) => [k, share(v, acum.salidaUsd)]),
      ) as Resumen["dinero"]["shareDeSalidaPorMasa"],
      porMasaCalibrado: {
        ...(Object.fromEntries(Object.entries(porMasaCalibrado).map(([k, v]) => [k, redondea(v)])) as Omit<
          Resumen["dinero"]["porMasaCalibrado"],
          "calibrado"
        >),
        calibrado,
      },
      shareDeSalidaPorMasaCalibrado: Object.fromEntries(
        Object.entries(porMasaCalibrado).map(([k, v]) => [k, share(v, acum.salidaUsd)]),
      ) as Resumen["dinero"]["shareDeSalidaPorMasaCalibrado"],
    },
    repeticion: resumenRepeticion(acum.repeticion, acum.repeticionPeso),
    repeticionCuerpo: resumenRepeticion(acum.repeticionCuerpo, acum.repeticionCuerpoPeso),
  };
}

/**
 * El resumen del GLOBAL cuando hay estratos por modelo: todo sale de
 * `resumir(global)` salvo el reparto CALIBRADO, que se SUMA estrato a estrato.
 * Calibrar en agregado sobre modelos mezclados es un error de precios: el
 * texto se concentra en el modelo barato y el JSON en el caro, y un ratio
 * global movería dinero entre modelos (medido el 06-09: 19,3 % → 24,6 % de
 * texto, falso). Un estrato sin calibración aporta su proporcional; el global
 * se declara calibrado si los estratos calibrados cubren ≥ 99 % de la salida.
 */
export function resumirEstratificado(global: Acumulador, estratos: Acumulador[]): Resumen {
  const r = resumir(global);
  const suma = { thinking: 0, text: 0, tool_use: 0, otros: 0, sinCuerpo: 0 };
  let salidaCalibrada = 0;
  let salidaTotal = 0;
  for (const e of estratos) {
    const re = resumir(e);
    for (const k of Object.keys(suma) as (keyof typeof suma)[]) suma[k] += re.dinero.porMasaCalibrado[k];
    salidaTotal += e.salidaUsd;
    if (re.dinero.porMasaCalibrado.calibrado) salidaCalibrada += e.salidaUsd;
  }
  const calibrado = salidaTotal > 0 && salidaCalibrada / salidaTotal >= 0.99;
  r.dinero.porMasaCalibrado = {
    ...(Object.fromEntries(Object.entries(suma).map(([k, v]) => [k, redondea(v)])) as Omit<Resumen["dinero"]["porMasaCalibrado"], "calibrado">),
    calibrado,
  };
  r.dinero.shareDeSalidaPorMasaCalibrado = Object.fromEntries(
    Object.entries(suma).map(([k, v]) => [k, share(v, global.salidaUsd)]),
  ) as Resumen["dinero"]["shareDeSalidaPorMasaCalibrado"];
  return r;
}
