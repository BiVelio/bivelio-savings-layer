/**
 * Banco del ESFUERZO · el NÚCLEO (puro: sin red, sin disco, sin reloj propio).
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE. La palanca D (gateway/esfuerzo.ts) está armada y apagada
 * desde el 2026-09-10 porque es la única que puede empeorar la RESPUESTA, y
 * nunca se midió contra la verja de calidad. Apunta al único dinero que se paga
 * a precio de lista: la salida (12,2 % de la factura del corpus del dueño en 12
 * días, y dentro de ella el pensamiento es el 37,7 %: benchmarks/salida/
 * resultados/salida-por-clase-2026-09-10.json). Este banco dice, por CLASE DE
 * TAREA, si bajar el esfuerzo conserva el éxito de tarea y cuánto recorta la
 * salida, y aplica el criterio para encenderla.
 *
 * QUÉ SE COMPARA, con el MISMO corpus del anillo 1 (15 tareas agénticas con
 * verificador programático: sin juez y sin opinión) y la MISMA cola:
 *   · control       — la petición sin esfuerzo: el modelo usa su defecto;
 *   · dial-final    — EXACTAMENTE lo que manda hoy el gateway: el cuerpo de
 *                     control pasado por `aplicarEsfuerzo` (el código del
 *                     producto, no una copia) y su beta;
 *   · dial-inicial  — el mismo dial como PRIMERA entrada de `messages`. Es una
 *                     candidata, no el producto: la documentación dice que el
 *                     dial rige «from the next user turn», y el gateway lo pone
 *                     DETRÁS del último turno de usuario. Si el final no rige la
 *                     respuesta en curso, este brazo lo destapa;
 *   · raiz          — `output_config.effort` en la raíz, constante toda la
 *                     tarea: lo que haría un cliente a mano.
 *
 * FIEL AL GATEWAY. El historial que guarda el arnés es el del CLIENTE: nunca
 * lleva el dial. Cada petición se transforma por separado, igual que el gateway
 * transforma cada petición que le llega. Y la caché va ENCENDIDA (caché
 * automática, `cache_control` en la raíz) con una sal por ejecución: los turnos
 * de una ejecución se leen entre sí y dos ejecuciones jamás comparten prefijo.
 * Así el banco mide también la promesa de la palanca —«no paga peaje de
 * caché»— en vez de darla por buena.
 *
 * El dinero sale de `costeMedido` (el medidor de producción) sobre el `usage`
 * del proveedor. Nada se estima. El pensamiento se lee de
 * `usage.output_tokens_details.thinking_tokens`, el campo documentado.
 */

import { costeMedido, type UsoSse } from "../../gateway/medidor.js";
import {
  BETA_ESFUERZO,
  NIVELES,
  admiteEsfuerzoPorTurno,
  aplicarEsfuerzo,
  conBetaDeEsfuerzo,
  defectoDeEsfuerzo,
  esNivel,
  mensajeDeEsfuerzo,
  rebajaElDefecto,
  type Esfuerzo,
} from "../../gateway/esfuerzo.js";
import { precioDeLista } from "../../src/pricing/catalogo.js";
import { ejecutarHerramienta, esquemaDeHerramientas, type Tarea } from "../anillo1/tareas.js";
import {
  bootstrapDiferenciaPorTarea,
  bootstrapReduccionPctPorTarea,
  type IntervaloDeConfianza,
} from "../salida/nucleo.js";

// ── Brazos y niveles ─────────────────────────────────────────────────────────

export type Brazo = "control" | "dial-final" | "dial-inicial" | "raiz";
/** Orden estable: el arnés los corre así, seguidos, por (tarea, rep). */
export const BRAZOS: readonly Brazo[] = ["control", "dial-final", "dial-inicial", "raiz"];
/** El brazo que ES la palanca D tal como sale en npm hoy. La decisión de encenderla es la suya. */
export const BRAZO_DE_LA_PALANCA: Brazo = "dial-final";

export function esBrazo(x: string): x is Brazo {
  return (BRAZOS as readonly string[]).includes(x);
}

export type Clase = Tarea["clase"];
export const CLASES: readonly Clase[] = ["log", "codigo", "otro", "mixta"];

/** Los niveles que tiene sentido medir en un modelo: los que rebajan su defecto. */
export function nivelesQueRebajan(modelo: string): Esfuerzo[] {
  return NIVELES.filter((n) => rebajaElDefecto(modelo, n));
}

// ── La petición de un turno (pura) ───────────────────────────────────────────

/**
 * El techo de salida por petición. El pensamiento cuenta dentro de `max_tokens`
 * y la documentación pide un techo grande con thinking: 2048 (el del anillo 1)
 * cortaría el CONTROL, que piensa más, y el truncado anula la comparación.
 */
export const MAX_TOKENS_ESFUERZO = 16_000;

export interface PeticionConstruida {
  /** El cuerpo ya serializado: los bytes EXACTOS que viajan. */
  texto: string;
  cabeceras: Record<string, string>;
}

/** El cuerpo de control de un turno: sin esfuerzo, con la sal en el byte 0 del system. */
export function cuerpoDeControl(opts: { tarea: Tarea; sal: string; modelo: string; mensajes: unknown[] }): Record<string, unknown> {
  return {
    model: opts.modelo,
    max_tokens: MAX_TOKENS_ESFUERZO,
    // Caché automática: el proveedor mueve un punto de ruptura al último bloque
    // cacheable, así que cada turno lee lo que escribió el anterior.
    cache_control: { type: "ephemeral" },
    system: `[medicion-fria ${opts.sal}]\n${opts.tarea.sistema}`,
    tools: esquemaDeHerramientas(opts.tarea),
    messages: opts.mensajes,
  };
}

/**
 * La petición de un turno para un brazo. Lanza si el brazo no puede aplicarse
 * (modelo sin la palanca, nivel que no rebaja): el prevuelo lo impide antes de
 * gastar, y aquí se vuelve a comprobar porque medir un brazo que salió igual
 * que el control publicaría un «efecto nulo» falso.
 */
export function construirPeticionEsfuerzo(opts: {
  tarea: Tarea;
  brazo: Brazo;
  nivel: Esfuerzo | null;
  sal: string;
  modelo: string;
  mensajes: unknown[];
  apiKey: string;
}): PeticionConstruida {
  const cabeceras: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const control = cuerpoDeControl(opts);
  if (opts.brazo === "control") return { texto: JSON.stringify(control), cabeceras };
  const nivel = opts.nivel;
  if (nivel === null) throw new Error(`arm ${opts.brazo} needs an effort level`);
  if (!rebajaElDefecto(opts.modelo, nivel)) {
    throw new Error(`${opts.modelo}: effort "${nivel}" does not lower the model's default, so arm ${opts.brazo} would equal control`);
  }
  switch (opts.brazo) {
    case "dial-final": {
      // EL CÓDIGO DEL PRODUCTO: los mismos bytes que sacaría el gateway.
      const puesto = aplicarEsfuerzo(Buffer.from(JSON.stringify(control), "utf8"), nivel);
      if (puesto === null) throw new Error(`the gateway's aplicarEsfuerzo refused ${opts.modelo} at "${nivel}"`);
      return { texto: puesto.cuerpo.toString("utf8"), cabeceras: { ...cabeceras, "anthropic-beta": conBetaDeEsfuerzo(undefined) } };
    }
    case "dial-inicial": {
      const cuerpo = { ...control, messages: [mensajeDeEsfuerzo(nivel), ...opts.mensajes] };
      return { texto: JSON.stringify(cuerpo), cabeceras: { ...cabeceras, "anthropic-beta": BETA_ESFUERZO } };
    }
    case "raiz": {
      const cuerpo = { ...control, output_config: { effort: nivel } };
      return { texto: JSON.stringify(cuerpo), cabeceras };
    }
  }
}

// ── La respuesta del proveedor y una ejecución ───────────────────────────────

export type UsoMessages = UsoSse & { output_tokens_details?: { thinking_tokens?: number } };

export interface RespuestaMessages {
  content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }[];
  stop_reason?: string;
  usage?: UsoMessages;
  error?: { type?: string; message?: string };
}

/** El transporte: el arnés en vivo lo hace con `fetch`; el seco, con el proveedor simulado. */
export type Pedir = (p: PeticionConstruida) => Promise<RespuestaMessages>;

export interface EjecucionEsfuerzo {
  tarea: string;
  clase: Clase;
  brazo: Brazo;
  /** null en control: el defecto del modelo. */
  nivel: Esfuerzo | null;
  rep: number;
  exito: boolean;
  entregado: boolean;
  turnos: number;
  llamadas: number;
  tokens: { entrada: number; salida: number; cacheLeida: number; cacheEscrita: number };
  /** Suma de `usage.output_tokens_details.thinking_tokens`; ausente si el proveedor no lo desglosó nunca. */
  thinkingTokens?: number;
  bloquesThinking: number;
  /** La salida a precio de lista (tokens de salida × precio de salida del modelo): EL objetivo. */
  costeSalidaUsd: number;
  /** La factura entera de la ejecución (primas de caché incluidas). */
  costeTotalUsd: number;
  /** Turnos cortados por `max_tokens`: una respuesta cortada no se compara. */
  truncados: number;
  maxSalidaTurno: number;
  /** La ejecución reventó antes de terminar: su par sale de la puerta de calidad. */
  error?: string;
}

export function ejecucionVacia(tarea: Tarea, brazo: Brazo, nivel: Esfuerzo | null, rep: number): EjecucionEsfuerzo {
  return {
    tarea: tarea.id,
    clase: tarea.clase,
    brazo,
    nivel,
    rep,
    exito: false,
    entregado: false,
    turnos: 0,
    llamadas: 0,
    tokens: { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 },
    bloquesThinking: 0,
    costeSalidaUsd: 0,
    costeTotalUsd: 0,
    truncados: 0,
    maxSalidaTurno: 0,
  };
}

/**
 * El bucle de una tarea con un brazo. Es el de `benchmarks/salida/arnes.ts`
 * generalizado a un brazo de esfuerzo, con el transporte INYECTADO: así la
 * tirada en seco recorre exactamente este código, y solo cambia quién contesta.
 */
export async function ejecutarTareaEsfuerzo(opts: {
  tarea: Tarea;
  brazo: Brazo;
  nivel: Esfuerzo | null;
  rep: number;
  sal: string;
  modelo: string;
  apiKey: string;
  pedir: Pedir;
  /** Instante con el que se tarifa (epoch ms). Ausente = ahora. */
  instante?: number;
}): Promise<EjecucionEsfuerzo> {
  const { tarea } = opts;
  const estado = tarea.construir();
  // El historial del CLIENTE: jamás lleva el dial (el gateway no se lo devuelve).
  const mensajes: unknown[] = [{ role: "user", content: tarea.enunciado }];
  const ejec = ejecucionVacia(tarea, opts.brazo, opts.nivel, opts.rep);
  let respuestaFinal = "";

  while (ejec.turnos < tarea.turnosMax) {
    ejec.turnos++;
    const peticion = construirPeticionEsfuerzo({ ...opts, mensajes });
    const res = await opts.pedir(peticion);
    if (res.error) throw new Error(`API: ${res.error.type}: ${res.error.message}`);

    if (res.usage) {
      const medido = costeMedido(opts.modelo, res.usage, opts.instante);
      if (medido) {
        ejec.costeTotalUsd += medido.costeUsd;
        ejec.costeSalidaUsd += (medido.tokens.salida / 1_000) * medido.precio.outputPer1k;
        ejec.tokens.entrada += medido.tokens.entrada;
        ejec.tokens.salida += medido.tokens.salida;
        ejec.tokens.cacheLeida += medido.tokens.cacheLeida;
        ejec.tokens.cacheEscrita += medido.tokens.cacheEscrita;
      }
      const t = res.usage.output_tokens_details?.thinking_tokens;
      if (typeof t === "number") ejec.thinkingTokens = (ejec.thinkingTokens ?? 0) + t;
      if (typeof res.usage.output_tokens === "number") ejec.maxSalidaTurno = Math.max(ejec.maxSalidaTurno, res.usage.output_tokens);
    }

    const contenido = res.content ?? [];
    for (const bloque of contenido) if (bloque.type === "thinking" || bloque.type === "redacted_thinking") ejec.bloquesThinking++;
    if (res.stop_reason === "max_tokens") ejec.truncados++;
    // Los bloques de pensamiento vuelven tal cual: la documentación pide
    // devolverlos intactos en bucles de herramientas.
    mensajes.push({ role: "assistant", content: contenido });
    if (res.stop_reason !== "tool_use") break;

    const resultados: unknown[] = [];
    let entregado = false;
    for (const bloque of contenido) {
      if (bloque.type !== "tool_use" || bloque.id === undefined || bloque.name === undefined) continue;
      ejec.llamadas++;
      const r = ejecutarHerramienta(tarea, estado, { nombre: bloque.name, entrada: bloque.input ?? {} });
      resultados.push({ type: "tool_result", tool_use_id: bloque.id, content: r.contenido, ...(r.esError ? { is_error: true } : {}) });
      if (r.entrega !== undefined) {
        respuestaFinal = r.entrega;
        entregado = true;
      }
    }
    if (resultados.length === 0) break;
    mensajes.push({ role: "user", content: resultados });
    if (entregado) {
      ejec.entregado = true;
      break;
    }
  }
  ejec.exito = ejec.entregado && tarea.verificar(estado, respuestaFinal);
  return ejec;
}

// ── Prevuelo y plan ──────────────────────────────────────────────────────────

export interface Plan {
  modelo: string;
  brazos: Brazo[];
  niveles: Esfuerzo[];
  reps: number;
  tareas: string[];
  /** Ejecuciones = tareas × reps × (1 + brazos de tratamiento × niveles). */
  ejecuciones: number;
}

/**
 * Lo que tiene que ser verdad ANTES de la primera llamada. Devuelve la lista de
 * motivos para no empezar (vacía = adelante). Mismo espíritu que el prevuelo
 * del A/B: una tirada que no puede medir lo que dice no se paga.
 */
export function prevuelo(p: { modelo: string; brazos: string[]; niveles: string[]; reps: number; tareas: string[]; ahora?: number }): string[] {
  const errores: string[] = [];
  if (!precioDeLista(p.modelo, p.ahora)) errores.push(`${p.modelo} has no row in the price catalogue: its cost cannot be metered`);
  if (!admiteEsfuerzoPorTurno(p.modelo)) {
    errores.push(`${p.modelo} does not support per-turn effort, so lever D never touches it (gateway/esfuerzo.ts)`);
  }
  const malos = p.brazos.filter((b) => !esBrazo(b));
  if (malos.length) errores.push(`unknown arms: ${malos.join(", ")} (valid: ${BRAZOS.join(", ")})`);
  if (!p.brazos.includes("control")) errores.push("the arms must include «control»: every pair is compared against it");
  if (p.brazos.filter((b) => b !== "control").length === 0) errores.push("no treatment arm: nothing to compare");
  if (p.niveles.length === 0) errores.push("no effort level to measure");
  const defecto = defectoDeEsfuerzo(p.modelo);
  for (const n of p.niveles) {
    if (!esNivel(n)) errores.push(`"${n}" is not an effort level (${NIVELES.join(", ")})`);
    else if (defecto !== undefined && !rebajaElDefecto(p.modelo, n)) {
      errores.push(`"${n}" does not lower ${p.modelo}'s default effort ("${defecto}"): the lever never applies it`);
    }
  }
  if (!Number.isInteger(p.reps) || p.reps < 1) errores.push(`reps must be a positive integer (got ${p.reps})`);
  if (p.tareas.length === 0) errores.push("no task selected");
  return errores;
}

/** La lista ordenada de ejecuciones: por tarea, por rep, control primero y los brazos seguidos. */
export function ordenDeEjecucion(plan: Plan): { tarea: string; rep: number; brazo: Brazo; nivel: Esfuerzo | null }[] {
  const out: { tarea: string; rep: number; brazo: Brazo; nivel: Esfuerzo | null }[] = [];
  for (const tarea of plan.tareas) {
    for (let rep = 0; rep < plan.reps; rep++) {
      for (const brazo of BRAZOS.filter((b) => plan.brazos.includes(b))) {
        if (brazo === "control") out.push({ tarea, rep, brazo, nivel: null });
        else for (const nivel of plan.niveles) out.push({ tarea, rep, brazo, nivel });
      }
    }
  }
  return out;
}

/**
 * Lo que la tirada puede costar, dicho antes de gastar. El techo de SALIDA es
 * duro (el proveedor nunca pasa de `max_tokens` por petición); la ENTRADA no
 * tiene techo honesto sin conocer la trayectoria, así que se da la referencia
 * medida: 101.633 tokens de entrada por ejecución de media en el anillo 0 del
 * 2026-09-06 (salida-banco-2026-09-06-sonnet-4-5.json, sin caché), aquí a precio
 * pleno —con caché será menor—. El presupuesto obligatorio es el que manda.
 */
export const ENTRADA_MEDIA_MEDIDA_POR_EJECUCION = 101_633;

export function costeEsperado(
  plan: Plan,
  turnosMaxPorTarea: Record<string, number>,
  ahora?: number,
): { techoSalidaUsd: number; referenciaEntradaUsd: number } | null {
  const precio = precioDeLista(plan.modelo, ahora);
  if (!precio) return null;
  let techoSalidaUsd = 0;
  for (const e of ordenDeEjecucion(plan)) {
    techoSalidaUsd += ((turnosMaxPorTarea[e.tarea] ?? 0) * MAX_TOKENS_ESFUERZO * precio.outputPer1k) / 1_000;
  }
  const referenciaEntradaUsd = (plan.ejecuciones * ENTRADA_MEDIA_MEDIDA_POR_EJECUCION * precio.inputPer1k) / 1_000;
  return { techoSalidaUsd, referenciaEntradaUsd };
}

// ── Estadística ──────────────────────────────────────────────────────────────

/**
 * Cota superior UNILATERAL de Clopper-Pearson para una proporción binomial:
 * el p tal que P(X ≤ x | n, p) = alfa. Con x = 0 es 1 − alfa^(1/n) (≈ 3/n, la
 * «regla del tres»). Bisección sobre la CDF en espacio logarítmico: sin
 * dependencias y estable hasta miles de pares.
 */
export function cotaSuperiorClopperPearson(x: number, n: number, alfa = 0.05): number {
  if (n <= 0) return 1;
  if (x >= n) return 1;
  if (x <= 0) return 1 - Math.pow(alfa, 1 / n);
  const cdf = (p: number): number => {
    // P(X ≤ x) = Σ_{k≤x} C(n,k) p^k (1−p)^(n−k), término a término en logs.
    const lp = Math.log(p);
    const lq = Math.log1p(-p);
    let logTermino = n * lq; // k = 0
    let suma = Math.exp(logTermino);
    for (let k = 0; k < x; k++) {
      logTermino += Math.log((n - k) / (k + 1)) + lp - lq;
      suma += Math.exp(logTermino);
    }
    return suma;
  };
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > alfa) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Pares (sin pérdidas) que hacen falta para que la cota de Clopper-Pearson quede bajo el margen. */
export function paresNecesarios(margen: number, alfa = 0.05): number {
  return Math.ceil(Math.log(alfa) / Math.log(1 - margen));
}

// ── El veredicto por celda (brazo × nivel × clase) ───────────────────────────

export interface Masa {
  control: number;
  brazo: number;
  /** 100 · (1 − Σbrazo / Σcontrol), IC 95 % remuestreando TAREAS. Negativo = el brazo cuesta más. */
  reduccionPct: IntervaloDeConfianza;
}

export interface Celda {
  brazo: Brazo;
  nivel: Esfuerzo;
  clase: Clase | "todas";
  /** Tareas distintas con al menos un par sano. */
  tareas: number;
  /** Pares (tarea, rep) sin ejecución reventada. */
  paresSanos: number;
  /** Pares sanos con las dos ejecuciones tarifadas (coste > 0). */
  paresMedidos: number;
  paresConError: number;
  /** EL OBJETIVO: la salida a precio de lista. */
  salidaUsd: Masa;
  /** La misma masa contando solo los pares con doble éxito: fracasar más corto no es ahorrar. */
  salidaUsdDobleExito: Masa & { pares: number };
  tokensSalida: Masa;
  /** Tokens de pensamiento, si el proveedor los desglosó en ambos lados. */
  thinking: { control: number; brazo: number } | null;
  totalUsd: Masa;
  /** Fracción de la entrada servida desde caché, por lado: la promesa de «sin peaje de caché». */
  lecturaDeCache: { control: number; brazo: number };
  exito: {
    control: number;
    brazo: number;
    total: number;
    /** Diferencia brazo − control (fracción) con IC por tarea. */
    diferencia: IntervaloDeConfianza | null;
    /** Pares donde control resolvió y el brazo no. */
    perdidas: number;
    /** Pares donde el brazo resolvió y control no. */
    ganancias: number;
    /**
     * Cota superior (Clopper-Pearson, 95 %) de la tasa de pérdidas ENTRE LOS
     * PARES QUE CONTROL RESOLVIÓ: «de lo que funcionaba, ¿cuánto se rompe?». Sin
     * éxitos de control no hay nada que perder ni nada que acotar: vale 1.
     */
    cotaDePerdidas: number;
  };
  truncados: { control: number; brazo: number };
  turnosMedios: { control: number; brazo: number };
  llamadasMedias: { control: number; brazo: number };
}

const suma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const media = (xs: number[]): number => (xs.length === 0 ? 0 : suma(xs) / xs.length);
const claveDePar = (e: { tarea: string; rep: number }): string => `${e.tarea}\u0000${e.rep}`;

function masa(pares: { c: EjecucionEsfuerzo; b: EjecucionEsfuerzo }[], f: (e: EjecucionEsfuerzo) => number): Masa {
  const xs = pares.map((p) => ({ tarea: p.c.tarea, base: f(p.c), estilo: f(p.b) }));
  const control = suma(xs.map((x) => x.base));
  const brazo = suma(xs.map((x) => x.estilo));
  const reduccionPct =
    xs.length >= 2
      ? bootstrapReduccionPctPorTarea(xs)
      : { media: control === 0 ? 0 : 100 * (1 - brazo / control), inferior: NaN, superior: NaN };
  return { control, brazo, reduccionPct };
}

function lecturaDeCache(xs: EjecucionEsfuerzo[]): number {
  const leida = suma(xs.map((x) => x.tokens.cacheLeida));
  const total = suma(xs.map((x) => x.tokens.entrada + x.tokens.cacheLeida + x.tokens.cacheEscrita));
  return total === 0 ? 0 : leida / total;
}

/**
 * Compara un brazo (a un nivel) contra control, por PARES (tarea, rep), en una
 * clase o en todas. Determinista: se ordena antes de emparejar y el bootstrap
 * va sembrado.
 */
export function celda(ejecuciones: readonly EjecucionEsfuerzo[], brazo: Brazo, nivel: Esfuerzo, clase: Clase | "todas"): Celda {
  const dentro = (e: EjecucionEsfuerzo): boolean => clase === "todas" || e.clase === clase;
  const ordenar = (xs: EjecucionEsfuerzo[]): EjecucionEsfuerzo[] =>
    [...xs].sort((a, b) => a.tarea.localeCompare(b.tarea) || a.rep - b.rep);
  const control = new Map(ordenar(ejecuciones.filter((e) => e.brazo === "control" && dentro(e))).map((e) => [claveDePar(e), e]));
  const propias = new Map(
    ordenar(ejecuciones.filter((e) => e.brazo === brazo && e.nivel === nivel && dentro(e))).map((e) => [claveDePar(e), e]),
  );
  const pares: { c: EjecucionEsfuerzo; b: EjecucionEsfuerzo }[] = [];
  for (const k of [...control.keys()].sort()) {
    const b = propias.get(k);
    if (b) pares.push({ c: control.get(k)!, b });
  }
  const sanos = pares.filter((p) => p.c.error === undefined && p.b.error === undefined);
  const medidos = sanos.filter((p) => p.c.costeTotalUsd > 0 && p.b.costeTotalUsd > 0);
  const dobleExito = medidos.filter((p) => p.c.exito && p.b.exito);
  const perdidas = sanos.filter((p) => p.c.exito && !p.b.exito).length;
  const ganancias = sanos.filter((p) => !p.c.exito && p.b.exito).length;
  const lado = <T>(f: (xs: EjecucionEsfuerzo[]) => T): { control: T; brazo: T } => ({
    control: f(medidos.map((p) => p.c)),
    brazo: f(medidos.map((p) => p.b)),
  });
  const conThinking = medidos.length > 0 && medidos.every((p) => p.c.thinkingTokens !== undefined && p.b.thinkingTokens !== undefined);
  return {
    brazo,
    nivel,
    clase,
    tareas: new Set(sanos.map((p) => p.c.tarea)).size,
    paresSanos: sanos.length,
    paresMedidos: medidos.length,
    paresConError: pares.length - sanos.length,
    salidaUsd: masa(medidos, (e) => e.costeSalidaUsd),
    salidaUsdDobleExito: { ...masa(dobleExito, (e) => e.costeSalidaUsd), pares: dobleExito.length },
    tokensSalida: masa(medidos, (e) => e.tokens.salida),
    thinking: conThinking ? lado((xs) => suma(xs.map((x) => x.thinkingTokens ?? 0))) : null,
    totalUsd: masa(medidos, (e) => e.costeTotalUsd),
    lecturaDeCache: lado(lecturaDeCache),
    exito: {
      control: sanos.filter((p) => p.c.exito).length,
      brazo: sanos.filter((p) => p.b.exito).length,
      total: sanos.length,
      diferencia:
        sanos.length >= 2
          ? bootstrapDiferenciaPorTarea(sanos.map((p) => ({ tarea: p.c.tarea, a: p.c.exito ? 1 : 0, b: p.b.exito ? 1 : 0 })))
          : null,
      perdidas,
      ganancias,
      cotaDePerdidas: cotaSuperiorClopperPearson(perdidas, sanos.filter((p) => p.c.exito).length),
    },
    truncados: lado((xs) => suma(xs.map((x) => x.truncados))),
    turnosMedios: lado((xs) => media(xs.map((x) => x.turnos))),
    llamadasMedias: lado((xs) => media(xs.map((x) => x.llamadas))),
  };
}

// ── El criterio para encenderla ──────────────────────────────────────────────

export interface Umbrales {
  /** Pérdida de éxito de tarea tolerada (fracción): 0,05 = 5 puntos. */
  margenCalidad: number;
  /** Caída tolerada de la fracción de entrada leída de caché (fracción): 0,02 = 2 puntos. */
  toleranciaCache: number;
  /** Tareas distintas mínimas para que el IC por tarea signifique algo. */
  minTareas: number;
}

export const UMBRALES_POR_DEFECTO: Umbrales = { margenCalidad: 0.05, toleranciaCache: 0.02, minTareas: 3 };

export interface Dictamen {
  encender: boolean;
  /** Por qué NO (vacío si enciende). */
  motivos: string[];
  /** Avisos que no bloquean. */
  notas: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)} pt`;

/**
 * El criterio, entero, para UNA celda. Todo tiene que cumplirse:
 *
 *  1. Muestra: ≥ `minTareas` tareas con pares sanos.
 *  2. CALIDAD (la verja): (a) el IC 95 % por tarea de Δéxito tiene su suelo por
 *     encima de −margen, y (b) la cota de Clopper-Pearson de la tasa de
 *     PÉRDIDAS entre los pares que control resolvió (control resolvió, el brazo
 *     no) queda bajo el margen. (b) es la que impide que 6 de 6 contra 6 de 6
 *     pase por «IC [0, 0]», y que un corpus que control no resuelve pase por
 *     «cero pérdidas»: con 0 pérdidas hacen falta `paresNecesarios(margen)`
 *     pares resueltos por control (59 al 5 %). Se acota la tasa de pérdidas y no
 *     la neta porque a quien se le rompe una tarea no le consuela que a otro se
 *     le arregle.
 *  3. Ni una respuesta TRUNCADA en ningún lado: con el control cortado la
 *     comparación favorece al brazo; con el brazo cortado es media respuesta.
 *  4. OBJETIVO: el suelo del IC de la reducción de SALIDA en dólares es > 0, en
 *     todos los pares medidos y en los de doble éxito.
 *  5. No empeora: la factura TOTAL no sube en el punto, y la lectura de caché
 *     del brazo no cae más de `toleranciaCache` (la promesa de la palanca).
 *
 * Y una tirada SIMULADA jamás enciende nada: prueba la fontanería, no el modelo.
 */
export function dictaminar(c: Celda, u: Umbrales, simulado: boolean): Dictamen {
  const motivos: string[] = [];
  const notas: string[] = [];
  if (simulado) motivos.push("simulated provider: the dry run proves the plumbing, never the model");
  if (c.tareas < u.minTareas) motivos.push(`only ${c.tareas} task(s) with sound pairs (minimum ${u.minTareas})`);
  const d = c.exito.diferencia;
  if (d === null || !Number.isFinite(d.inferior)) motivos.push("no confidence interval for the success difference");
  else if (d.inferior < -u.margenCalidad) {
    motivos.push(
      `QUALITY: success difference ${pct(d.media)}, 95% CI [${pct(d.inferior)}, ${pct(d.superior)}], floor below −${pct(u.margenCalidad)}`,
    );
  }
  if (c.exito.cotaDePerdidas > u.margenCalidad) {
    motivos.push(
      `QUALITY: ${c.exito.perdidas} loss(es) among the ${c.exito.control} pairs control solved; the 95% upper bound of the loss rate is ` +
        `${pct(c.exito.cotaDePerdidas)} > ${pct(u.margenCalidad)} (with no losses it takes ${paresNecesarios(u.margenCalidad)} pairs control solved)`,
    );
  }
  if (c.truncados.control + c.truncados.brazo > 0) {
    motivos.push(`TRUNCATED responses (control ${c.truncados.control}, arm ${c.truncados.brazo}): the comparison is void`);
  }
  if (!(c.salidaUsd.reduccionPct.inferior > 0)) {
    motivos.push(`OUTPUT: the floor of the output-spend reduction does not clear zero (${c.salidaUsd.reduccionPct.inferior.toFixed(1)} %)`);
  }
  if (c.salidaUsdDobleExito.pares < 2 || !(c.salidaUsdDobleExito.reduccionPct.inferior > 0)) {
    motivos.push(
      `OUTPUT: counting only pairs where both sides succeeded (${c.salidaUsdDobleExito.pares}), the floor does not clear zero`,
    );
  }
  if (c.totalUsd.reduccionPct.media < 0) {
    motivos.push(`TOTAL: the whole bill goes UP (${c.totalUsd.reduccionPct.media.toFixed(1)} %)`);
  } else if (!(c.totalUsd.reduccionPct.inferior >= 0)) {
    notas.push(`the floor of the total-bill change is ${c.totalUsd.reduccionPct.inferior.toFixed(1)} %: it could go up`);
  }
  const caida = c.lecturaDeCache.control - c.lecturaDeCache.brazo;
  if (caida > u.toleranciaCache) {
    motivos.push(
      `CACHE: the share of input read from cache falls from ${pct(c.lecturaDeCache.control)} to ${pct(c.lecturaDeCache.brazo)} ` +
        `(tolerance ${pct(u.toleranciaCache)}): the lever pays a cache toll it promised not to`,
    );
  }
  if (c.paresConError > 0) notas.push(`${c.paresConError} pair(s) with a failed run left out of the quality gate`);
  if (c.exito.control + c.exito.brazo === 0 && c.exito.total > 0) notas.push("neither side solved any task: no quality signal");
  return { encender: motivos.length === 0, motivos, notas };
}

export interface DecisionDeClase {
  clase: Clase;
  /** El nivel que se encendería para esta clase, o null. */
  nivel: Esfuerzo | null;
  sueloSalidaPct: number | null;
  porNivel: { nivel: Esfuerzo; dictamen: Dictamen }[];
}

export interface Decision {
  simulado: boolean;
  modelo: string;
  brazo: Brazo;
  umbrales: Umbrales;
  /**
   * El nivel ÚNICO que el gateway puede poner hoy (`BVSALA_GATEWAY_EFFORT`):
   * el gateway no distingue clases, así que tiene que valer para TODAS.
   */
  global: { nivel: Esfuerzo | null; sueloSalidaPct: number | null; motivos: string[] };
  /**
   * Por clase: informativo hasta que el gateway sepa clasificar una petición
   * ANTES de mandarla (hoy la taxonomía del corpus es a posteriori).
   */
  porClase: DecisionDeClase[];
  todas: { nivel: Esfuerzo; celda: Celda; dictamen: Dictamen }[];
}

/**
 * Decide para UN brazo. Por clase: el nivel que pasa el criterio con el mayor
 * suelo de reducción de salida. Global: el nivel que pasa el criterio en el
 * conjunto Y en el que ninguna clase con datos muestra pérdida de éxito con IC
 * entero bajo cero (una clase dañada no se esconde en la media).
 */
export function decidir(
  ejecuciones: readonly EjecucionEsfuerzo[],
  opts: { brazo?: Brazo; umbrales?: Umbrales; simulado: boolean; modelo: string },
): Decision {
  const brazo = opts.brazo ?? BRAZO_DE_LA_PALANCA;
  const u = opts.umbrales ?? UMBRALES_POR_DEFECTO;
  const niveles = NIVELES.filter((n) => ejecuciones.some((e) => e.brazo === brazo && e.nivel === n));
  const mejor = (cands: { nivel: Esfuerzo; suelo: number }[]): { nivel: Esfuerzo; suelo: number } | null =>
    cands.sort((a, b) => b.suelo - a.suelo || NIVELES.indexOf(b.nivel) - NIVELES.indexOf(a.nivel))[0] ?? null;

  const porClase: DecisionDeClase[] = CLASES.filter((k) => ejecuciones.some((e) => e.clase === k)).map((clase) => {
    const porNivel = niveles.map((nivel) => ({ nivel, c: celda(ejecuciones, brazo, nivel, clase) }));
    const dict = porNivel.map((x) => ({ nivel: x.nivel, dictamen: dictaminar(x.c, u, opts.simulado) }));
    const gan = mejor(
      porNivel.filter((_, i) => dict[i]!.dictamen.encender).map((x) => ({ nivel: x.nivel, suelo: x.c.salidaUsd.reduccionPct.inferior })),
    );
    return { clase, nivel: gan?.nivel ?? null, sueloSalidaPct: gan?.suelo ?? null, porNivel: dict };
  });

  const todas = niveles.map((nivel) => {
    const c = celda(ejecuciones, brazo, nivel, "todas");
    return { nivel, celda: c, dictamen: dictaminar(c, u, opts.simulado) };
  });
  const motivosGlobales: string[] = [];
  const candidatos: { nivel: Esfuerzo; suelo: number }[] = [];
  if (niveles.length === 0) motivosGlobales.push(`no run of arm ${brazo}`);
  for (const t of todas) {
    const danadas = porClase
      .map((k) => ({ clase: k.clase, c: celda(ejecuciones, brazo, t.nivel, k.clase) }))
      .filter((k) => k.c.exito.diferencia !== null && k.c.exito.diferencia.superior < 0)
      .map((k) => k.clase);
    if (!t.dictamen.encender) motivosGlobales.push(`${t.nivel}: ${t.dictamen.motivos.join("; ")}`);
    else if (danadas.length) motivosGlobales.push(`${t.nivel}: task success drops with the whole CI below zero in ${danadas.join(", ")}`);
    else candidatos.push({ nivel: t.nivel, suelo: t.celda.salidaUsd.reduccionPct.inferior });
  }
  const g = mejor(candidatos);
  return {
    simulado: opts.simulado,
    modelo: opts.modelo,
    brazo,
    umbrales: u,
    global: { nivel: g?.nivel ?? null, sueloSalidaPct: g?.suelo ?? null, motivos: g ? [] : motivosGlobales },
    porClase,
    todas,
  };
}

/**
 * El diagnóstico de COLOCACIÓN: si el dial al final no mueve la salida y la
 * raíz sí, el problema no es el esfuerzo sino dónde lo pone el gateway.
 */
export function diagnosticoDeColocacion(ejecuciones: readonly EjecucionEsfuerzo[]): string[] {
  const notas: string[] = [];
  for (const nivel of NIVELES) {
    const hay = (b: Brazo) => ejecuciones.some((e) => e.brazo === b && e.nivel === nivel);
    if (!hay("dial-final")) continue;
    const final = celda(ejecuciones, "dial-final", nivel, "todas");
    for (const otro of ["raiz", "dial-inicial"] as const) {
      if (!hay(otro)) continue;
      const c = celda(ejecuciones, otro, nivel, "todas");
      if (!(final.tokensSalida.reduccionPct.inferior > 0) && c.tokensSalida.reduccionPct.inferior > 0) {
        notas.push(
          `${nivel}: the dial appended at the end does not move output (floor ${final.tokensSalida.reduccionPct.inferior.toFixed(1)} %) ` +
            `while ${otro} does (floor ${c.tokensSalida.reduccionPct.inferior.toFixed(1)} %): the gateway's placement, not the effort level, is the problem`,
        );
      }
    }
  }
  return notas;
}
