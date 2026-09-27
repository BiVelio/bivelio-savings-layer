/**
 * EL BANCO EN SECO DE LA COMPACTACIÓN DE LA COLA.
 *
 * Pregunta: ¿cuánto dinero de ENTRADA ahorra compactar las salidas de
 * herramienta, y cuánto depende de CUÁNDO se compacta? Se responde sin red y sin
 * gastar un céntimo, con dos piezas que ya existen y están calibradas:
 *
 *  · el compactador que viaja en npm (`src/compression/cola.ts`), con la MISMA
 *    selección que usa el pipeline (`seleccionarCompactables`);
 *  · el simulador de caché de prefijo del carril sombra
 *    (`gateway/sombra.ts`, `CadenaDeSimulacion`), el que se calibró contra el
 *    contador real del proveedor (error de escritura 66 % → 3 %, PR #236).
 *
 * Cuatro brazos sobre las MISMAS sesiones:
 *
 *  · `base`   — nada se compacta.
 *  · `cola`   — lo que hace la capa: cada tool_result se compacta el turno en
 *               que nace y se reenvía igual después.
 *  · `vieja`  — el patrón que midieron JetBrains, Quesma y Barker y que perdió
 *               en el replay propio (v1): el resultado más nuevo viaja entero y
 *               se compacta cuando ya está en el historial. Mismo compactador,
 *               mismos tokens quitados: solo cambia el MOMENTO.
 *  · `mitad`  — la capa encendida a mitad de sesión: el primer turno compacta el
 *               historial que salió sin compactar. Es el único caso en que la
 *               regla pura rompe el prefijo, y aquí se mide cuánto cuesta.
 *
 * LOS TOKENS SE CUENTAN CON o200k_base (gpt-tokenizer) y el precio es el del
 * catálogo para modelos de Anthropic (escritura 1,25× con TTL de 5 min; lectura
 * 0,1× en Sonnet 5 y 0,05× en Opus 5.5). o200k no es el tokenizador de
 * Anthropic: los PORCENTAJES entre brazos son la cifra, los dólares absolutos
 * son ilustrativos. El truco de unidades: el simulador reparte `entradaReal`
 * entre bloques por peso en bytes; aquí el peso de cada bloque ES su cuenta de
 * tokens, así que el reparto es exacto.
 *
 * LO QUE ESTE BANCO NO MIDE, y es justo donde las mediciones de 2026 vieron
 * perder dinero: si el modelo, con la salida compactada, hace MÁS turnos o
 * repite herramientas. Aquí la trayectoria es fija por construcción. El
 * argumento de que no cambia es la verja de fidelidad (todo reversible o igual
 * a lo que enseña un terminal); la medición es un A/B vivo, que queda para el
 * dueño. La salida tampoco se simula: la compactación no la toca.
 *
 * Uso: `pnpm compactacion:banco` escribe
 * `benchmarks/evidencia/compactacion-de-cola-2026-09-27.json`; la verja
 * `test/banco-compactacion-de-cola.test.ts` lo recalcula y exige que coincida.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encode } from "gpt-tokenizer/encoding/o200k_base";

import {
  CadenaDeSimulacion,
  type BloqueSombra,
  type CosteSimulado,
  type TurnoSombra,
} from "../../gateway/sombra.js";
import { compactToolOutput, seleccionarCompactables } from "../../src/compression/cola.js";
import type { ChatMessage } from "../../src/contracts/types.js";
import { MEZCLA, sesiones, type ClaseDeSalida, type Perfil, type Sesion } from "./sesiones.js";

export const BRAZOS = ["base", "cola", "vieja", "mitad"] as const;
export type Brazo = (typeof BRAZOS)[number];

export const MODELOS = ["claude-sonnet-5", "claude-opus-5-5"] as const;
export const PERFILES: readonly Perfil[] = ["app-con-api", "agente-de-codigo", "agente-de-operaciones"];
export const SESIONES_POR_PERFIL = 20;
const SEMILLA = 20_260_927;
/** Instante fijo para tarifar: el catálogo tiene vigencias. */
const AHORA = Date.UTC(2026, 8, 27, 12, 0, 0);
/** Segundos entre turnos: dentro del TTL de 5 min, como un agente activo. */
const PASO_MS = 30_000;

const tokens = (t: string): number => encode(t).length;

/** Lo que el proveedor tokeniza de un mensaje (contenido + llamadas). */
function textoDeMensaje(m: ChatMessage): string {
  const llamadas = (m.toolCalls ?? []).map((tc) => `${tc.name}${tc.arguments}`).join("");
  return `${m.content}${llamadas}`;
}

function tipoDe(m: ChatMessage): string {
  if (m.role === "system") return "system";
  if (m.role === "tool") return "user:tool_result";
  if (m.role === "assistant") return m.toolCalls?.length ? "assistant:tool_use" : "assistant:text";
  return "user:text";
}

interface SesionMedida {
  sesion: Sesion;
  /** Tokens de cada mensaje, original. */
  originales: number[];
  /** Tokens del mensaje compactado, o null si no se compacta. */
  compactados: (number | null)[];
}

function medirSesion(sesion: Sesion): SesionMedida {
  const eleccion = seleccionarCompactables(sesion.mensajes);
  const compactados: (number | null)[] = sesion.mensajes.map(() => null);
  for (const c of eleccion.compactados) compactados[c.indice] = tokens(c.texto);
  return { sesion, originales: sesion.mensajes.map((m) => tokens(textoDeMensaje(m))), compactados };
}

/** Coste de entrada simulado de UNA sesión con un brazo. */
function simular(m: SesionMedida, modelo: string, brazo: Brazo): CosteSimulado & { tokensEnviados: number } {
  const n = m.sesion.mensajes.length;
  const turnos = (n - 2) / 2;
  const encendidaDesde = Math.floor(turnos / 2);
  let tokensEnviados = 0;

  const cadena = new CadenaDeSimulacion((bloques, _estado, turno) =>
    bloques.map((b, i) => {
      const c = m.compactados[i];
      const original = { clave: b.clave, bytes: b.bytes };
      if (c == null) return original;
      const compacto = { clave: `${b.clave}:c`, bytes: c };
      const ultimo = i === bloques.length - 1;
      switch (brazo) {
        case "base":
          return original;
        case "cola":
          return compacto;
        case "vieja":
          return ultimo ? original : compacto;
        case "mitad":
          return turno >= encendidaDesde ? compacto : original;
      }
    }),
  );

  for (let t = 0; t < turnos; t++) {
    const hasta = 2 + 2 * (t + 1);
    const bloques: BloqueSombra[] = m.sesion.mensajes.slice(0, hasta).map((msg, i) => ({
      clave: `m${i}`,
      tipo: tipoDe(msg),
      // Dos puntos de ruptura, como un cliente cuidadoso (y como Claude Code):
      // uno fijo al final del `system` y el automático, que se mueve al último
      // bloque. El del `system` hace la comparación MÁS benévola con `vieja`:
      // aunque el resto falle, las instrucciones siguen leyéndose de caché.
      marca: i === hasta - 1 || i === 0 ? "5m" : null,
      bytes: m.originales[i]!,
      bytesV1: m.originales[i]!,
      clase: "otro",
      esError: false,
    }));
    const turno: TurnoSombra = {
      bloques,
      at: AHORA + t * PASO_MS,
      model: modelo,
      entradaReal: bloques.reduce((s, b) => s + b.bytes, 0),
      escritura1h: false,
    };
    const antes = cadena.acumulado.tokensLeidos + cadena.acumulado.tokensEscritos + cadena.acumulado.tokensEntrada;
    cadena.paso(turno);
    tokensEnviados += cadena.acumulado.tokensLeidos + cadena.acumulado.tokensEscritos + cadena.acumulado.tokensEntrada - antes;
  }
  return { ...cadena.acumulado, tokensEnviados };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (parte: number, total: number) => (total > 0 ? r2((parte / total) * 100) : 0);

export interface ResultadoBrazo {
  usd: number;
  ahorroPct: number;
  tokensEnviados: number;
  reduccionTokensPct: number;
  invalidacionUsd: number;
  tokensInvalidados: number;
  /** Sesiones en las que el brazo salió MÁS caro que `base`. */
  sesionesPeores: number;
}

export interface ArtefactoCompactacion {
  fecha: string;
  metodo: string;
  tokenizador: string;
  sesionesPorPerfil: number;
  mezcla: typeof MEZCLA;
  perfiles: Record<
    string,
    {
      turnos: number;
      /** Qué parte del coste de entrada de `base` es escritura (lo nuevo de cada turno). */
      escrituraSobreEntradaPct: Record<string, number>;
      /** Qué parte de los TOKENS de entrada de `base` se lee de caché (la «ley del 95 %»). */
      lecturaSobreTokensPct: number;
      porModelo: Record<string, Record<Brazo, ResultadoBrazo>>;
    }
  >;
  porClase: Record<string, { salidas: number; compactadas: number; tokensOriginales: number; tokensCompactados: number; reduccionPct: number; transformaciones: Record<string, number> }>;
  limites: string[];
}

export function medirCompactacionDeCola(sesionesPorPerfil = SESIONES_POR_PERFIL): ArtefactoCompactacion {
  const perfiles: ArtefactoCompactacion["perfiles"] = {};
  const porClase: ArtefactoCompactacion["porClase"] = {};

  PERFILES.forEach((perfil, p) => {
    const medidas = sesiones(perfil, sesionesPorPerfil, SEMILLA + p).map(medirSesion);

    // Por clase: la misma decisión que el pipeline (vistas de fichero fuera).
    for (const m of medidas) {
      m.sesion.salidas.forEach((s, t) => {
        const i = 2 + 2 * t + 1;
        const fila = (porClase[s.clase] ??= { salidas: 0, compactadas: 0, tokensOriginales: 0, tokensCompactados: 0, reduccionPct: 0, transformaciones: {} });
        fila.salidas += 1;
        fila.tokensOriginales += tokens(s.contenido);
        const c = m.compactados[i];
        fila.tokensCompactados += c ?? tokens(s.contenido);
        if (c != null) {
          fila.compactadas += 1;
          for (const tr of compactToolOutput(s.contenido).applied) fila.transformaciones[tr] = (fila.transformaciones[tr] ?? 0) + 1;
        }
      });
    }

    const porModelo: Record<string, Record<Brazo, ResultadoBrazo>> = {};
    const escrituraSobreEntradaPct: Record<string, number> = {};
    for (const modelo of MODELOS) {
      const totales = {} as Record<Brazo, ResultadoBrazo>;
      const porSesion = medidas.map((m) => Object.fromEntries(BRAZOS.map((b) => [b, simular(m, modelo, b)])) as Record<Brazo, CosteSimulado & { tokensEnviados: number }>);
      const base = porSesion.reduce((s, x) => s + x.base.totalUsd, 0);
      const baseTokens = porSesion.reduce((s, x) => s + x.base.tokensEnviados, 0);
      escrituraSobreEntradaPct[modelo] = pct(porSesion.reduce((s, x) => s + x.base.escrituraUsd, 0), base);
      for (const brazo of BRAZOS) {
        const usd = porSesion.reduce((s, x) => s + x[brazo].totalUsd, 0);
        const enviados = porSesion.reduce((s, x) => s + x[brazo].tokensEnviados, 0);
        totales[brazo] = {
          usd: r6(usd),
          ahorroPct: pct(base - usd, base),
          tokensEnviados: enviados,
          reduccionTokensPct: pct(baseTokens - enviados, baseTokens),
          invalidacionUsd: r6(porSesion.reduce((s, x) => s + x[brazo].invalidacionUsd, 0)),
          tokensInvalidados: Math.round(porSesion.reduce((s, x) => s + x[brazo].tokensInvalidados, 0)),
          // Tolerancia de redondeo de coma flotante, no de dinero.
          sesionesPeores: porSesion.filter((x) => x[brazo].totalUsd > x.base.totalUsd + 1e-12).length,
        };
      }
      porModelo[modelo] = totales;
    }
    const baseSonnet = medidas.map((m) => simular(m, MODELOS[0], "base"));
    perfiles[perfil] = {
      turnos: medidas.reduce((s, m) => s + (m.sesion.mensajes.length - 2) / 2, 0),
      escrituraSobreEntradaPct,
      lecturaSobreTokensPct: pct(
        baseSonnet.reduce((s, x) => s + x.tokensLeidos, 0),
        baseSonnet.reduce((s, x) => s + x.tokensEnviados, 0),
      ),
      porModelo,
    };
  });

  for (const fila of Object.values(porClase)) {
    fila.reduccionPct = pct(fila.tokensOriginales - fila.tokensCompactados, fila.tokensOriginales);
  }
  const clasesOrdenadas = Object.fromEntries(
    (Object.keys(porClase) as ClaseDeSalida[]).sort().map((k) => [k, porClase[k]!]),
  );

  return {
    fecha: "2026-09-27",
    metodo:
      "dry bench: synthetic agent sessions (seeded), the npm compactor with the pipeline's own selection, " +
      "and the shadow-lane prefix-cache simulator (breakpoints on the system prompt and on the last block, 5m TTL). " +
      "Input cost only; trajectories are fixed, so extra turns caused by compaction are NOT measured here.",
    tokenizador: "o200k_base (gpt-tokenizer); percentages between arms are the result, absolute USD is illustrative",
    sesionesPorPerfil,
    mezcla: MEZCLA,
    perfiles,
    porClase: clasesOrdenadas,
    limites: [
      "synthetic sessions: the class mix is an assumption, published per profile and per class",
      "no live provider: the cache model is the shadow simulator calibrated at 3% write error on Anthropic traffic",
      "second-order effects (extra turns, re-running tools) are not measured; fidelity is the argument, not a measurement",
      "output tokens are not simulated; compaction does not touch them",
    ],
  };
}

// --- CLI ---------------------------------------------------------------------------

const RUTA = fileURLToPath(new URL("../evidencia/compactacion-de-cola-2026-09-27.json", import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = medirCompactacionDeCola();
  writeFileSync(RUTA, `${JSON.stringify(a, null, 2)}\n`);
  for (const [perfil, datos] of Object.entries(a.perfiles)) {
    for (const [modelo, brazos] of Object.entries(datos.porModelo)) {
      const fila = BRAZOS.map((b) => `${b} ${brazos[b].ahorroPct.toFixed(2)}% (tok ${brazos[b].reduccionTokensPct.toFixed(1)}%, inval $${brazos[b].invalidacionUsd.toFixed(4)}, peores ${brazos[b].sesionesPeores})`);
      console.log(`${perfil.padEnd(22)} ${modelo.padEnd(16)} ${fila.join(" | ")}`);
    }
  }
  console.log(`\nescrito ${RUTA}`);
}
