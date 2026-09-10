/**
 * ANILLO 2 · NÚCLEO PURO — el A/B de días alternos que convierte el «% de
 * tokens borrados» del anillo 0 en «% de FACTURA» (docs/PLAN-S4-PALANCA.md § 4,
 * días 8–14). Todo lo de este fichero es puro y determinista: la lectura de
 * capturas y la escritura del artefacto viven en arnes.ts.
 *
 * El diseño de la comparación, y por qué es así:
 *
 * - Un DÍA es la unidad experimental (así se opera la palanca: días alternos
 *   con/sin BVSALA_GATEWAY_ELISION). Los días NO están pareados por carga, así
 *   que el veredicto usa un bootstrap de DOS MUESTRAS sobre la métrica por día,
 *   no el bootstrap de pares del anillo 1.
 *
 * - El normalizador primario es €/kTok de SALIDA: la elisión solo toca la
 *   entrada, así que los tokens de salida son un proxy de trabajo hecho que la
 *   propia palanca no puede sesgar. €/turno se publica como secundario. Los
 *   tokens de ENTRADA jamás normalizan: son exactamente lo que la palanca
 *   reduce, y usarlos escondería el ahorro.
 *
 * - La verja POR MODELO viene del replay del 06-09 (sombra-corpus): v0 daba
 *   +28 % en fable-5 y −3,9 % en opus-4-8 — un dial global puede perder dinero
 *   en un modelo mientras gana en otro. El informe la trae de serie.
 *
 * Doctrina: DESCRIPTIVO. Jamás base de comisión, jamás sumado a "measured".
 */
import {
  DIAL_CLEAR_AT_LEAST_INPUT_TOKENS,
  DIAL_KEEP_TOOL_USES,
  DIAL_TRIGGER_INPUT_TOKENS,
} from "../../gateway/diales.js";
import { elisionDeContextManagement, type ElisionAplicada, type UsoSse } from "../../gateway/medidor.js";

export type Brazo = "palanca" | "control";

/** Mínimo de días por brazo para emitir veredicto; por debajo, «insuficiente». */
export const MIN_DIAS_POR_BRAZO = 3;

/**
 * El protocolo del dueño (06-09-2026): el día natural UTC PAR es de palanca y
 * el IMPAR de control. La auditoría de paridad compara lo que este protocolo
 * esperaba con lo que el cuerpo de cada petición dice, y lista las fisuras.
 */
export const PROTOCOLO_PARIDAD = "día natural UTC par = palanca, impar = control";

/**
 * El protocolo VIGENTE desde el 2026-09-10: el brazo se asigna por SESIÓN, con
 * el mismo hash determinista que usa el gateway (gateway/anillo2.ts →
 * `brazoDeSesion`). La unidad auditable pasa a ser la sesión, no el día.
 */
export const PROTOCOLO_SESION = "brazo por hash de sesión (FNV-1a), una sesión = un brazo entero";

/** El mismo hash que `brazoDeSesion` del gateway. Los dos tienen que coincidir
 *  o el auditor clasificaría en un brazo distinto del que se sirvió. */
/**
 * La mezcla final de murmur3 (fmix32). NO es adorno: sin ella, el bit 0 de
 * FNV-1a es degenerado. Su último paso multiplica por un primo impar, así que
 * el bit 0 del resultado es solo el XOR de los bits bajos de los caracteres —
 * con identificadores secuenciales o con sufijo común reparte 0 % / 100 % en
 * vez de mitad y mitad. Lo cazó el test de reparto antes de salir de aquí.
 */
function mezclar(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function brazoDeSesion(sesion: string): Brazo {
  let h = 0x811c9dc5;
  for (let i = 0; i < sesion.length; i++) {
    h ^= sesion.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (mezclar(h) & 1) === 0 ? "palanca" : "control";
}

/**
 * AUDITORÍA POR SESIÓN — la que sustituye a la de paridad de días.
 *
 * Una sesión es la unidad de asignación, así que la única fisura posible es que
 * los turnos de UNA sesión no compartan brazo. Un día con dos brazos ya no es
 * una fisura: es lo normal, porque las sesiones se reparten al 50 %.
 *
 * `observado` sale del cuerpo de cada petición (lo que de verdad se sirvió) y
 * `asignado` del hash. Cuando difieren, la palanca no hizo lo que el protocolo
 * mandaba, y eso sí es una fisura que hay que ver.
 */
export interface SesionAuditada {
  sesion: string;
  asignado: Brazo;
  observado: { control: number; palanca: number };
  limpia: boolean;
  dias: string[];
  turnos: number;
}

export function auditarPorSesion(turnos: TurnoAnillo2[]): {
  protocolo: string;
  sesiones: SesionAuditada[];
  fisuras: string[];
  reparto: { control: number; palanca: number };
} {
  const porSesion = new Map<string, { control: number; palanca: number; dias: Set<string> }>();
  for (const t of turnos) {
    const a = porSesion.get(t.sesion) ?? porSesion.set(t.sesion, { control: 0, palanca: 0, dias: new Set() }).get(t.sesion)!;
    a[t.brazo] += 1;
    a.dias.add(t.dia);
  }
  const sesiones: SesionAuditada[] = [];
  const fisuras: string[] = [];
  const reparto = { control: 0, palanca: 0 };
  for (const [sesion, a] of [...porSesion.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const asignado = brazoDeSesion(sesion);
    const turnosTotales = a.control + a.palanca;
    // Limpia = todos los turnos de la sesión en el brazo que le tocaba.
    const limpia = a[asignado] === turnosTotales;
    reparto[asignado] += turnosTotales;
    sesiones.push({ sesion, asignado, observado: { control: a.control, palanca: a.palanca }, limpia, dias: [...a.dias].sort(), turnos: turnosTotales });
    if (!limpia) {
      fisuras.push(
        `sesión ${sesion}: asignada a ${asignado} pero sirvió ${a.control} turnos de control y ${a.palanca} de palanca` +
          (a.dias.size > 1 ? ` (cruza ${a.dias.size} días: ${[...a.dias].sort().join(", ")})` : ""),
      );
    }
  }
  return { protocolo: PROTOCOLO_SESION, sesiones, fisuras, reparto };
}

export function brazoEsperado(dia: string): Brazo {
  return Number(dia.slice(8, 10)) % 2 === 0 ? "palanca" : "control";
}

/**
 * Qué `context_management` traía el CLIENTE, aparte de nuestro edit: la
 * palanca fusiona (conserva clear_thinking y cualquier estrategia ajena), así
 * que un cuerpo de palanca lleva el nuestro Y lo del cliente. Se devuelve un
 * conjunto ordenado de clases («clear_thinking», «clear_tool_uses_ajeno»,
 * «otra») unido por «+», o «ninguna».
 */
export function configDelCliente(cm: unknown): string {
  if (cm === null || typeof cm !== "object") return "ninguna";
  const edits = (cm as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) return "ninguna";
  const clases = new Set<string>();
  for (const e of edits) {
    if (e === null || typeof e !== "object") continue;
    if (esDialNuestro({ edits: [e] })) continue;
    const tipo = (e as { type?: unknown }).type;
    if (tipo === "clear_thinking_20251015") clases.add("clear_thinking");
    else if (tipo === "clear_tool_uses_20250919") clases.add("clear_tool_uses_ajeno");
    else clases.add("otra");
  }
  return clases.size ? [...clases].sort().join("+") : "ninguna";
}

/**
 * ¿Este `context_management` lleva EL NUESTRO? La palanca S4a FUSIONA su edit
 * de tool_uses con la config del cliente (gateway/palanca.ts: conserva su
 * clear_thinking en posición 0 y sustituye/añade el nuestro), así que la firma
 * es «algún edit con los tres diales exactos» — el de fábrica de Claude Code
 * no lleva trigger (hoy manda clear_thinking keep:"all"; el clear_tool_uses de
 * fábrica de otras versiones traía otros valores y no disparó ni una vez en
 * 1.952 peticiones). Si el barrido del anillo 2 cambia los diales, esta
 * detección lo sigue: lee del módulo, no de copias.
 */
export function esDialNuestro(cm: unknown): boolean {
  if (cm === null || typeof cm !== "object") return false;
  const edits = (cm as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) return false;
  return edits.some((e) => {
    if (e === null || typeof e !== "object") return false;
    const ed = e as {
      type?: unknown;
      trigger?: { value?: unknown };
      keep?: { value?: unknown };
      clear_at_least?: { value?: unknown };
    };
    return (
      ed.type === "clear_tool_uses_20250919" &&
      ed.trigger?.value === DIAL_TRIGGER_INPUT_TOKENS &&
      ed.keep?.value === DIAL_KEEP_TOOL_USES &&
      ed.clear_at_least?.value === DIAL_CLEAR_AT_LEAST_INPUT_TOKENS
    );
  });
}

/**
 * Los applied_edits de una respuesta SSE cruda. El espía NO los extrae a
 * `sse.usage` (solo guarda usage), pero sí guarda el cuerpo completo — aquí se
 * barren los eventos message_start/message_delta y se suma lo declarado.
 * La forma sondeada en vivo (04-09): streaming en message_delta, message_start
 * trae null.
 */
export function elisionDeCuerpoSse(utf8: string): ElisionAplicada | null {
  let borrados = 0;
  let tokens = 0;
  let deToolUses = 0;
  for (const bloque of utf8.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(bloque)?.[1];
    if (ev !== "message_start" && ev !== "message_delta") continue;
    const data = /^data: (.+)$/m.exec(bloque)?.[1];
    if (!data) continue;
    let d: { context_management?: unknown; message?: { context_management?: unknown } };
    try {
      d = JSON.parse(data) as typeof d;
    } catch {
      continue;
    }
    const e = elisionDeContextManagement(d.context_management ?? d.message?.context_management);
    if (e) {
      borrados += e.borrados;
      tokens += e.tokensLimpiados;
      deToolUses += e.tokensLimpiadosToolUses;
    }
  }
  return borrados > 0 ? { borrados, tokensLimpiados: tokens, tokensLimpiadosToolUses: deToolUses } : null;
}

/**
 * El usage definitivo de un registro del espía: los eventos se FUSIONAN y el
 * desglose anidado de cache_creation también (la regla del ObservadorSse del
 * gateway, reproducida sobre la lista ya extraída que guarda la captura).
 */
export function usageFusionado(eventos: { usage: UsoSse }[]): UsoSse | null {
  if (!eventos.length) return null;
  let uso: UsoSse = {};
  let tuvoDesglose = false;
  let desglose: NonNullable<UsoSse["cache_creation"]> = {};
  for (const { usage } of eventos) {
    if (usage.cache_creation) {
      tuvoDesglose = true;
      desglose = { ...desglose, ...usage.cache_creation };
    }
    uso = { ...uso, ...usage };
  }
  if (tuvoDesglose) uso.cache_creation = desglose;
  return uso;
}

/** Día natural UTC de un timestamp ISO — la unidad del A/B. */
export function diaDe(atIso: string): string | null {
  const dia = atIso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : null;
}

export interface TurnoAnillo2 {
  dia: string;
  brazo: Brazo;
  model: string;
  sesion: string;
  entradaUsd: number;
  salidaUsd: number;
  entradaTokens: number;
  salidaTokens: number;
  /** Borrado DECLARADO por el proveedor en la respuesta (su contador). */
  borrados: number;
  tokensLimpiados: number;
  /** true si el cuerpo de respuesta superó el tope del espía: los applied_edits
   *  de ese turno son irrecuperables y el saneamiento lo cuenta. */
  respuestaOmitida: boolean;
  /** Cliente que envió el turno (primer token del user-agent, p.ej.
   *  «claude-cli/2.1.260»): una versión que cambia a mitad del A/B es un
   *  confundidor que la auditoría debe enseñar. Opcional: los tests viejos
   *  no lo traen. */
  cliente?: string;
  /** Lo que traía el cliente en context_management aparte de nuestro edit
   *  (configDelCliente). Opcional por la misma razón. */
  configCliente?: string;
}

/** PRNG sembrado (mulberry32): el mismo de todo el banco, determinista. */
function azarSembrado(semilla: number): () => number {
  let estado = semilla >>> 0;
  return () => {
    estado |= 0;
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mediaDe = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Bootstrap de DOS MUESTRAS (una por brazo) sobre la métrica por día:
 *  IC 95 % de media(control) − media(palanca). PRNG sembrado (determinista). */
export function bootstrapDosMuestras(
  control: number[],
  palanca: number[],
  reps = 10_000,
  semilla = 20260906,
): { media: number; inferior: number; superior: number } {
  const azar = azarSembrado(semilla);
  const remuestra = (xs: number[]) => {
    let suma = 0;
    for (let i = 0; i < xs.length; i++) suma += xs[Math.floor(azar() * xs.length)]!;
    return suma / xs.length;
  };
  const medias: number[] = [];
  for (let i = 0; i < reps; i++) medias.push(remuestra(control) - remuestra(palanca));
  medias.sort((a, b) => a - b);
  return {
    media: mediaDe(control) - mediaDe(palanca),
    inferior: medias[Math.floor(reps * 0.025)]!,
    superior: medias[Math.floor(reps * 0.975)]!,
  };
}

/** Un estrato del bootstrap estratificado: un modelo, con su peso (gasto de
 *  entrada del control, en USD) y sus métricas por día en cada brazo. */
export interface Estrato {
  peso: number;
  control: number[];
  palanca: number[];
}

/**
 * Bootstrap ESTRATIFICADO por modelo: en cada réplica se remuestrean los días
 * de cada brazo DENTRO de cada modelo y se agrega el ahorro como
 *   Σ_m peso_m · (media_c,m − media_p,m) / Σ_m peso_m · media_c,m
 * — el % de la factura de entrada del control que la palanca habría ahorrado,
 * ponderado por lo que cada modelo pesa en esa factura. Así la mezcla de
 * modelos de cada día (que mueve la métrica por día ×10 entre opus-4-8 y
 * sonnet-5) no puede fabricar ni esconder un efecto. Devuelve % (0–100) con
 * IC 95 %. Determinista.
 */
export function bootstrapEstratificado(
  estratos: Estrato[],
  reps = 10_000,
  semilla = 20260906,
): { ahorroPct: number; inferior: number; superior: number } {
  const azar = azarSembrado(semilla);
  const remuestra = (xs: number[]) => {
    let suma = 0;
    for (let i = 0; i < xs.length; i++) suma += xs[Math.floor(azar() * xs.length)]!;
    return suma / xs.length;
  };
  const agrega = (mc: (e: Estrato) => number, mp: (e: Estrato) => number): number => {
    let num = 0;
    let den = 0;
    for (const e of estratos) {
      const c = mc(e);
      num += e.peso * (c - mp(e));
      den += e.peso * c;
    }
    return den > 0 ? (num / den) * 100 : 0;
  };
  const punto = agrega((e) => mediaDe(e.control), (e) => mediaDe(e.palanca));
  const replicas: number[] = [];
  for (let i = 0; i < reps; i++) replicas.push(agrega((e) => remuestra(e.control), (e) => remuestra(e.palanca)));
  replicas.sort((a, b) => a - b);
  return {
    ahorroPct: punto,
    inferior: replicas[Math.floor(reps * 0.025)]!,
    superior: replicas[Math.floor(reps * 0.975)]!,
  };
}

interface Acumulado {
  turnos: number;
  sesiones: Set<string>;
  entradaUsd: number;
  salidaUsd: number;
  entradaTokens: number;
  salidaTokens: number;
  borrados: number;
  tokensLimpiados: number;
  omitidas: number;
}

const vacio = (): Acumulado => ({
  turnos: 0,
  sesiones: new Set(),
  entradaUsd: 0,
  salidaUsd: 0,
  entradaTokens: 0,
  salidaTokens: 0,
  borrados: 0,
  tokensLimpiados: 0,
  omitidas: 0,
});

function suma(a: Acumulado, t: TurnoAnillo2): void {
  a.turnos += 1;
  a.sesiones.add(t.sesion);
  a.entradaUsd += t.entradaUsd;
  a.salidaUsd += t.salidaUsd;
  a.entradaTokens += t.entradaTokens;
  a.salidaTokens += t.salidaTokens;
  a.borrados += t.borrados;
  a.tokensLimpiados += t.tokensLimpiados;
  if (t.respuestaOmitida) a.omitidas += 1;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

function publica(a: Acumulado) {
  return {
    turnos: a.turnos,
    sesiones: a.sesiones.size,
    entradaUsd: r2(a.entradaUsd),
    salidaUsd: r2(a.salidaUsd),
    entradaTokensM: Math.round(a.entradaTokens / 1e5) / 10,
    salidaTokens: a.salidaTokens,
    borrados: a.borrados,
    tokensLimpiadosM: Math.round(a.tokensLimpiados / 1e5) / 10,
    /** Primario: la salida es trabajo hecho que la elisión no puede sesgar. */
    usdEntradaPorKTokSalida: a.salidaTokens > 0 ? r4(a.entradaUsd / (a.salidaTokens / 1000)) : null,
    usdEntradaPorTurno: a.turnos > 0 ? r4(a.entradaUsd / a.turnos) : null,
    respuestasOmitidas: a.omitidas,
  };
}

/** Métrica primaria de un acumulado: € de entrada por kTok de salida (null sin denominador). */
const metricaDe = (a: Acumulado | undefined): number | null =>
  a && a.salidaTokens > 0 ? a.entradaUsd / (a.salidaTokens / 1000) : null;

/** Cuenta ocurrencias en un mapa. */
function cuenta<K>(m: Map<K, number>, k: K, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

const objetoOrdenado = <V>(m: Map<string, V>): Record<string, V> =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * AUDITORÍA DE PARIDAD (protocolo HISTÓRICO, hasta el 2026-09-09): por día, lo
 * que el protocolo esperaba frente a lo que el cuerpo de cada petición dice,
 * más los confundidores (cliente, config, modelos, sesiones) y las fisuras en
 * texto llano. Un día es LIMPIO si solo tiene un brazo y es el esperado.
 *
 * Se conserva para poder releer el corpus recogido bajo aquel protocolo. Para
 * el tráfico nuevo la auditoría que vale es `auditarPorSesion`: la asignación
 * por día se retiró porque una sesión que cruza la medianoche arrastra el brazo
 * anterior y ensucia el día entero.
 */
export interface DiaAuditado {
  dia: string;
  esperado: Brazo;
  observado: { control: number; palanca: number };
  limpio: boolean;
  sesiones: number;
  borradosPalanca: number;
  tokensLimpiadosPalancaM: number;
  clientes: Record<string, number>;
  configCliente: Record<string, number>;
  modelos: Record<string, number>;
  fisuras: string[];
}

export function auditarParidad(turnos: TurnoAnillo2[]): { protocolo: string; dias: DiaAuditado[]; fisuras: string[] } {
  interface Acc {
    control: number;
    palanca: number;
    sesiones: Set<string>;
    borrados: number;
    limpiados: number;
    clientes: Map<string, number>;
    config: Map<string, number>;
    modelos: Map<string, number>;
  }
  const porDia = new Map<string, Acc>();
  for (const t of turnos) {
    const a =
      porDia.get(t.dia) ??
      porDia
        .set(t.dia, {
          control: 0,
          palanca: 0,
          sesiones: new Set(),
          borrados: 0,
          limpiados: 0,
          clientes: new Map(),
          config: new Map(),
          modelos: new Map(),
        })
        .get(t.dia)!;
    a[t.brazo] += 1;
    a.sesiones.add(t.sesion);
    if (t.brazo === "palanca") {
      a.borrados += t.borrados;
      a.limpiados += t.tokensLimpiados;
    }
    cuenta(a.clientes, t.cliente ?? "?");
    cuenta(a.config, t.configCliente ?? "?");
    cuenta(a.modelos, t.model);
  }

  const dias: DiaAuditado[] = [];
  const globales: string[] = [];
  const ordenados = [...porDia.keys()].sort();
  for (const dia of ordenados) {
    const a = porDia.get(dia)!;
    const esperado = brazoEsperado(dia);
    const fisuras: string[] = [];
    const mezclado = a.control > 0 && a.palanca > 0;
    if (mezclado)
      fisuras.push(
        `día mezclado: ${a.control} turnos control + ${a.palanca} palanca — la unidad «día» no es limpia (¿bandera cambiada a mitad de día?)`,
      );
    if (esperado === "palanca" && a.palanca === 0)
      fisuras.push(
        "día PAR sin palanca: ninguna petición ajustada — bandera apagada, sesión sin encadenar al espía, o entitlement context_elision caído (fail-closed)",
      );
    if (esperado === "control" && a.palanca > 0)
      fisuras.push(`día IMPAR con ${a.palanca} turnos de palanca: bandera encendida en día de control`);
    if (a.palanca > 0 && a.borrados === 0)
      fisuras.push("palanca sin disparos: peticiones ajustadas pero el proveedor no declaró ningún borrado (sesiones bajo el trigger o applied_edits irrecuperables)");
    if (a.clientes.size > 1)
      fisuras.push(`${a.clientes.size} versiones de cliente en el mismo día: ${[...a.clientes.keys()].sort().join(", ")}`);
    const limpio = !mezclado && (esperado === "palanca" ? a.palanca > 0 : a.control > 0);
    dias.push({
      dia,
      esperado,
      observado: { control: a.control, palanca: a.palanca },
      limpio,
      sesiones: a.sesiones.size,
      borradosPalanca: a.borrados,
      tokensLimpiadosPalancaM: Math.round(a.limpiados / 1e5) / 10,
      clientes: objetoOrdenado(a.clientes),
      configCliente: objetoOrdenado(a.config),
      modelos: objetoOrdenado(a.modelos),
      fisuras,
    });
  }

  // Huecos del calendario entre el primer y el último día con tráfico.
  if (ordenados.length >= 2) {
    const primero = new Date(`${ordenados[0]}T00:00:00Z`).getTime();
    const ultimo = new Date(`${ordenados[ordenados.length - 1]}T00:00:00Z`).getTime();
    const huecos: string[] = [];
    for (let t = primero; t <= ultimo; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!porDia.has(d)) huecos.push(d);
    }
    if (huecos.length) globales.push(`días sin tráfico en la ventana: ${huecos.join(", ")}`);
  }
  const limpiosPalanca = dias.filter((d) => d.limpio && d.esperado === "palanca").length;
  const limpiosControl = dias.filter((d) => d.limpio && d.esperado === "control").length;
  if (limpiosPalanca < MIN_DIAS_POR_BRAZO)
    globales.push(`solo ${limpiosPalanca} días limpios de palanca (mínimo ${MIN_DIAS_POR_BRAZO})`);
  if (limpiosControl < MIN_DIAS_POR_BRAZO)
    globales.push(`solo ${limpiosControl} días limpios de control (mínimo ${MIN_DIAS_POR_BRAZO})`);
  const clientes = new Set(dias.flatMap((d) => Object.keys(d.clientes)));
  if (clientes.size > 1)
    globales.push(`el cliente cambió de versión dentro de la ventana (${[...clientes].sort().join(", ")}): confundidor a declarar`);

  return { protocolo: PROTOCOLO_PARIDAD, dias, fisuras: globales };
}

/** El informe entero a partir de los turnos ya clasificados. */
export function resumir(turnos: TurnoAnillo2[]) {
  const porBrazo = new Map<Brazo, Acumulado>([
    ["control", vacio()],
    ["palanca", vacio()],
  ]);
  const porDia = new Map<string, Map<Brazo, Acumulado>>();
  const porModelo = new Map<string, Map<Brazo, Acumulado>>();
  /** modelo → día → brazo: la unidad del veredicto estratificado. */
  const porModeloDia = new Map<string, Map<string, Map<Brazo, Acumulado>>>();
  for (const t of turnos) {
    suma(porBrazo.get(t.brazo)!, t);
    const d = porDia.get(t.dia) ?? porDia.set(t.dia, new Map()).get(t.dia)!;
    suma(d.get(t.brazo) ?? d.set(t.brazo, vacio()).get(t.brazo)!, t);
    const m = porModelo.get(t.model) ?? porModelo.set(t.model, new Map()).get(t.model)!;
    suma(m.get(t.brazo) ?? m.set(t.brazo, vacio()).get(t.brazo)!, t);
    const md = porModeloDia.get(t.model) ?? porModeloDia.set(t.model, new Map()).get(t.model)!;
    const mdd = md.get(t.dia) ?? md.set(t.dia, new Map()).get(t.dia)!;
    suma(mdd.get(t.brazo) ?? mdd.set(t.brazo, vacio()).get(t.brazo)!, t);
  }

  // Métrica por día y brazo (solo días con salida — sin denominador no hay dato).
  // Los días van ORDENADOS antes de tocar el PRNG: el orden de inserción de un
  // Map es el de lectura de las capturas, y con él bailaban los límites del IC
  // (cazado el 06-09: −26,1 vs −25,8 con la misma entrada invertida).
  const metricaPorDia = (dias: Map<string, Map<Brazo, Acumulado>>, brazo: Brazo): number[] =>
    [...dias.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, d]) => metricaDe(d.get(brazo)))
      .filter((x): x is number => x !== null);

  const control = metricaPorDia(porDia, "control");
  const palanca = metricaPorDia(porDia, "palanca");
  const brazoP = porBrazo.get("palanca")!;

  // ── Veredicto GLOBAL por día (secundario: la mezcla de modelos del día lo mueve) ──
  let veredicto:
    | { estado: "insuficiente"; diasControl: number; diasPalanca: number; minimo: number }
    | { estado: "palanca-sin-disparos"; nota: string }
    | {
        estado: "ok";
        diasControl: number;
        diasPalanca: number;
        ahorroPctFactura: number;
        ci95Pct: { inferior: number; superior: number };
        significativo: boolean;
      };
  if (control.length < MIN_DIAS_POR_BRAZO || palanca.length < MIN_DIAS_POR_BRAZO) {
    veredicto = {
      estado: "insuficiente",
      diasControl: control.length,
      diasPalanca: palanca.length,
      minimo: MIN_DIAS_POR_BRAZO,
    };
  } else if (brazoP.tokensLimpiados === 0) {
    veredicto = {
      estado: "palanca-sin-disparos",
      nota: "hay días de palanca pero el proveedor no declaró NINGÚN borrado — sesiones bajo el trigger o palanca mal armada; el A/B no compara nada",
    };
  } else {
    const b = bootstrapDosMuestras(control, palanca);
    const mediaControl = mediaDe(control);
    veredicto = {
      estado: "ok",
      diasControl: control.length,
      diasPalanca: palanca.length,
      ahorroPctFactura: mediaControl > 0 ? Math.round((b.media / mediaControl) * 1000) / 10 : 0,
      ci95Pct:
        mediaControl > 0
          ? {
              inferior: Math.round((b.inferior / mediaControl) * 1000) / 10,
              superior: Math.round((b.superior / mediaControl) * 1000) / 10,
            }
          : { inferior: 0, superior: 0 },
      significativo: b.inferior > 0,
    };
  }

  // ── Veredicto ESTRATIFICADO por modelo (primario) ──
  const estratos: Estrato[] = [];
  const modelosIncluidos: string[] = [];
  const modelosExcluidos: { modelo: string; motivo: string }[] = [];
  const modelos = Object.fromEntries(
    // Mismo motivo: los estratos alimentan el PRNG en este orden.
    [...porModelo.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([modelo, brazos]) => {
      const c = brazos.get("control");
      const p = brazos.get("palanca");
      const mc = metricaDe(c);
      const mp = metricaDe(p);
      const dias = porModeloDia.get(modelo)!;
      const diasC = metricaPorDia(dias, "control");
      const diasP = metricaPorDia(dias, "palanca");
      let ic: { ahorroPct: number; ci95Pct: { inferior: number; superior: number }; significativo: boolean } | null = null;
      if (diasC.length >= MIN_DIAS_POR_BRAZO && diasP.length >= MIN_DIAS_POR_BRAZO && c && c.entradaUsd > 0) {
        const b = bootstrapEstratificado([{ peso: c.entradaUsd, control: diasC, palanca: diasP }]);
        ic = {
          ahorroPct: Math.round(b.ahorroPct * 10) / 10,
          ci95Pct: { inferior: Math.round(b.inferior * 10) / 10, superior: Math.round(b.superior * 10) / 10 },
          significativo: b.inferior > 0,
        };
        estratos.push({ peso: c.entradaUsd, control: diasC, palanca: diasP });
        modelosIncluidos.push(modelo);
      } else {
        modelosExcluidos.push({
          modelo,
          motivo: `${diasC.length} días control / ${diasP.length} días palanca (mínimo ${MIN_DIAS_POR_BRAZO} cada uno)`,
        });
      }
      return [
        modelo,
        {
          control: c ? publica(c) : null,
          palanca: p ? publica(p) : null,
          diasControl: diasC.length,
          diasPalanca: diasP.length,
          ahorroPct: mc !== null && mp !== null && mc > 0 ? Math.round(((mc - mp) / mc) * 1000) / 10 : null,
          peorConPalanca: mc !== null && mp !== null ? mp > mc : null,
          ...(ic ?? {}),
        },
      ];
    }),
  );
  let veredictoPorModelo:
    | { estado: "insuficiente"; modelosIncluidos: string[]; modelosExcluidos: typeof modelosExcluidos }
    | { estado: "palanca-sin-disparos"; nota: string }
    | {
        estado: "ok";
        ahorroPctFactura: number;
        ci95Pct: { inferior: number; superior: number };
        significativo: boolean;
        pesoUsdControlIncluido: number;
        pesoUsdControlTotal: number;
        modelosIncluidos: string[];
        modelosExcluidos: typeof modelosExcluidos;
      };
  if (!estratos.length) {
    veredictoPorModelo = { estado: "insuficiente", modelosIncluidos, modelosExcluidos };
  } else if (brazoP.tokensLimpiados === 0) {
    veredictoPorModelo = {
      estado: "palanca-sin-disparos",
      nota: "hay días de palanca por modelo pero el proveedor no declaró NINGÚN borrado; el A/B no compara nada",
    };
  } else {
    const b = bootstrapEstratificado(estratos);
    veredictoPorModelo = {
      estado: "ok",
      ahorroPctFactura: Math.round(b.ahorroPct * 10) / 10,
      ci95Pct: { inferior: Math.round(b.inferior * 10) / 10, superior: Math.round(b.superior * 10) / 10 },
      significativo: b.inferior > 0,
      pesoUsdControlIncluido: r2(estratos.reduce((s, e) => s + e.peso, 0)),
      pesoUsdControlTotal: r2(porBrazo.get("control")!.entradaUsd),
      modelosIncluidos,
      modelosExcluidos,
    };
  }

  return {
    veredicto,
    veredictoPorModelo,
    // La auditoría histórica (por día) se conserva para releer el corpus viejo;
    // la que manda desde el 2026-09-10 es la de sesión.
    paridad: auditarParidad(turnos),
    sesiones: auditarPorSesion(turnos),
    porBrazo: {
      control: publica(porBrazo.get("control")!),
      palanca: publica(brazoP),
    },
    porDia: Object.fromEntries(
      [...porDia.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([dia, brazos]) => [
          dia,
          Object.fromEntries([...brazos.entries()].map(([brazo, a]) => [brazo, publica(a)])),
        ]),
    ),
    porDiaModelo: Object.fromEntries(
      [...porDia.keys()].sort().map((dia) => [
        dia,
        Object.fromEntries(
          [...porModeloDia.entries()]
            .filter(([, dias]) => dias.has(dia))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([modelo, dias]) => [
              modelo,
              Object.fromEntries([...dias.get(dia)!.entries()].map(([brazo, a]) => [brazo, publica(a)])),
            ]),
        ),
      ]),
    ),
    porModelo: modelos,
    doctrina:
      "anillo 2: DESCRIPTIVO — días no pareados por carga (el IC bootstrap trata cada día como unidad); PRIMARIO el veredicto estratificado por modelo (la mezcla de modelos mueve la métrica por día ×10: ponderado por gasto de entrada del control, modelos con <3 días por brazo excluidos y declarados); el veredicto global por día queda como secundario; normalizador €/kTok de salida porque la elisión no toca la salida; jamás base de comisión, jamás sumado a measured",
  };
}
