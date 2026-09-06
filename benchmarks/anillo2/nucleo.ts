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
 * ¿Este `context_management` es EL NUESTRO? La palanca S4a SUSTITUYE el bloque
 * entero por configDeDiales() (gateway/palanca.ts), así que la firma son los
 * tres diales exactos — el de fábrica de Claude Code lleva otros valores (en
 * 1.952 peticiones del corpus no disparó ni una vez). Si el barrido del anillo
 * 2 cambia los diales, esta detección lo sigue: lee del módulo, no de copias.
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
    }
  }
  return borrados > 0 ? { borrados, tokensLimpiados: tokens } : null;
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
}

/** Bootstrap de DOS MUESTRAS (una por brazo) sobre la métrica por día:
 *  IC 95 % de media(control) − media(palanca). PRNG sembrado (determinista). */
export function bootstrapDosMuestras(
  control: number[],
  palanca: number[],
  reps = 10_000,
  semilla = 20260906,
): { media: number; inferior: number; superior: number } {
  const mediaDe = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let estado = semilla >>> 0;
  const azar = () => {
    estado |= 0;
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/** El informe entero a partir de los turnos ya clasificados. */
export function resumir(turnos: TurnoAnillo2[]) {
  const porBrazo = new Map<Brazo, Acumulado>([
    ["control", vacio()],
    ["palanca", vacio()],
  ]);
  const porDia = new Map<string, Map<Brazo, Acumulado>>();
  const porModelo = new Map<string, Map<Brazo, Acumulado>>();
  for (const t of turnos) {
    suma(porBrazo.get(t.brazo)!, t);
    const d = porDia.get(t.dia) ?? porDia.set(t.dia, new Map()).get(t.dia)!;
    suma(d.get(t.brazo) ?? d.set(t.brazo, vacio()).get(t.brazo)!, t);
    const m = porModelo.get(t.model) ?? porModelo.set(t.model, new Map()).get(t.model)!;
    suma(m.get(t.brazo) ?? m.set(t.brazo, vacio()).get(t.brazo)!, t);
  }

  // Métrica por día y brazo (solo días con salida — sin denominador no hay dato).
  const metricaPorDia = (brazo: Brazo): number[] =>
    [...porDia.values()]
      .map((d) => d.get(brazo))
      .filter((a): a is Acumulado => !!a && a.salidaTokens > 0)
      .map((a) => a.entradaUsd / (a.salidaTokens / 1000));

  const control = metricaPorDia("control");
  const palanca = metricaPorDia("palanca");
  const brazoP = porBrazo.get("palanca")!;

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
    const mediaControl = control.reduce((a, x) => a + x, 0) / control.length;
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

  // Verja por modelo: dónde la palanca sale PEOR que el control (misma métrica).
  const modelos = Object.fromEntries(
    [...porModelo.entries()].map(([modelo, brazos]) => {
      const c = brazos.get("control");
      const p = brazos.get("palanca");
      const mc = c && c.salidaTokens > 0 ? c.entradaUsd / (c.salidaTokens / 1000) : null;
      const mp = p && p.salidaTokens > 0 ? p.entradaUsd / (p.salidaTokens / 1000) : null;
      return [
        modelo,
        {
          control: c ? publica(c) : null,
          palanca: p ? publica(p) : null,
          ahorroPct: mc !== null && mp !== null && mc > 0 ? Math.round(((mc - mp) / mc) * 1000) / 10 : null,
          peorConPalanca: mc !== null && mp !== null ? mp > mc : null,
        },
      ];
    }),
  );

  return {
    veredicto,
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
    porModelo: modelos,
    doctrina:
      "anillo 2: DESCRIPTIVO — días no pareados por carga (el IC bootstrap trata cada día como unidad); normalizador primario €/kTok de salida porque la elisión no toca la salida; jamás base de comisión, jamás sumado a measured",
  };
}
