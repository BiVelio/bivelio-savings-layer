/**
 * Banco de SALIDA · anillo 0 · el NÚCLEO (puro: sin red, sin disco, sin reloj).
 *
 * Por qué existe: toda la semana se midió la ENTRADA (elisión, caché, diales).
 * La salida es el 0,3 % de los tokens del corpus del dueño pero el 11,6 % del
 * dinero (se paga ×5 y jamás viene de caché); en el banco A/B propio llegó a
 * ser el 63,7 % de la factura. Aquí se compara lo único que reduce la salida
 * sin tocar el algoritmo: el ESTILO que se le pide al modelo.
 *
 * Tres estilos, mismo corpus (las 15 tareas agénticas deterministas del
 * anillo 1, con su verificador programático), misma cola, mismo momento:
 *   · «base»          — el system de la tarea tal cual;
 *   · «savings-mode»  — + el cuerpo de skills/savings-mode/SKILL.md;
 *   · «caveman»       — + las reglas del skill público caveman (MIT), nivel full.
 *
 * Reglas heredadas del anillo 1, y sus porqués:
 *   · SAL DE FRÍO en el byte 0 del system por (tirada, tarea, estilo, rep): dos
 *     ejecuciones jamás comparten prefijo de caché; cada coste es el suyo.
 *   · PAREADO por (tarea, rep): el bootstrap remuestrea PARES, no ejecuciones.
 *   · Se publica el SUELO del IC 95 %, jamás el punto (docs/SKILL-MODO-AHORRO.md).
 *   · QUALITY_FLOOR: un estilo que pierde éxito de tarea fuera del IC no vale,
 *     por mucha salida que ahorre.
 *   · SIN context_management: aquí se mide salida, no entrada. Ni beta ni diales.
 *
 * Lo que este fichero NO hace: pedir a la API, leer ficheros, escribir
 * artefactos. Eso es del arnés (arnes.ts). Todo lo de aquí se verifica sin red.
 */

import { esquemaDeHerramientas, prng, type Tarea } from "../anillo1/tareas.js";

// ── Estilos ──

export type Estilo = "base" | "savings-mode" | "caveman";

/** Orden estable de los estilos: el arnés los ejecuta así, seguidos, por (tarea, rep). */
export const ESTILOS: readonly Estilo[] = ["base", "savings-mode", "caveman"];

export function esEstilo(x: string): x is Estilo {
  return (ESTILOS as readonly string[]).includes(x);
}

/** Los textos que se añaden al system; «base» no lleva ninguno por definición. */
export type TextosDeEstilo = Record<Exclude<Estilo, "base">, string>;

/**
 * El system de la tarea con el estilo aplicado. «base» devuelve el system
 * INTACTO (ni un byte: es la línea de referencia); los demás lo extienden con
 * el texto del estilo separado por una línea en blanco — el skill se lee como
 * una sección más del system, que es como lo instala un usuario real.
 */
export function systemConEstilo(sistemaTarea: string, estilo: Estilo, textos: TextosDeEstilo): string {
  if (estilo === "base") return sistemaTarea;
  return `${sistemaTarea}\n\n${textos[estilo]}`;
}

// ── La petición de un turno (pura) ──

/** Igual que el anillo 1: el techo de salida no cambia entre estilos. */
export const MAX_TOKENS_SALIDA = 2048;

export interface PeticionConstruida {
  cuerpo: Record<string, unknown>;
  cabeceras: Record<string, string>;
}

/**
 * La petición de un turno. Exportada para que las verjas comprueben sin red
 * que la sal es el PRIMER byte del system, que el estilo va donde debe y que
 * NO viaja context_management (ni su cabecera beta): el banco de salida no
 * toca la entrada.
 */
export function construirPeticionSalida(opts: {
  tarea: Tarea;
  estilo: Estilo;
  sal: string;
  modelo: string;
  mensajes: unknown[];
  apiKey: string;
  textos: TextosDeEstilo;
}): PeticionConstruida {
  const cuerpo: Record<string, unknown> = {
    model: opts.modelo,
    max_tokens: MAX_TOKENS_SALIDA,
    // La sal es el PRIMER byte del prompt: la divergencia de caché empieza en 0.
    system: `[medicion-fria ${opts.sal}]\n${systemConEstilo(opts.tarea.sistema, opts.estilo, opts.textos)}`,
    tools: esquemaDeHerramientas(opts.tarea),
    messages: opts.mensajes,
  };
  const cabeceras: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
  };
  return { cuerpo, cabeceras };
}

// ── Textos de estilo: limpieza pura de lo que se lee del disco ──

/**
 * Quita el frontmatter YAML (`---` … `---`) del principio de un skill: son
 * metadatos del instalador (name/description), no instrucciones para el modelo.
 */
export function sinFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/**
 * Quita la cabecera de atribución (un comentario HTML al principio del fichero)
 * que guardamos con el skill de terceros. La atribución es para el repo; al
 * modelo le llega el skill literal, que es lo que hace la medición reproducible.
 */
export function sinCabeceraDeAtribucion(md: string): string {
  const m = /^\s*<!--[\s\S]*?-->[ \t]*\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/** Cabecera de atribución → frontmatter → texto limpio (en ese orden). */
export function textoDeSkill(md: string): string {
  return sinFrontmatter(sinCabeceraDeAtribucion(md)).trim();
}

// ── Una ejecución ──

export interface EjecucionSalida {
  tarea: string;
  clase: Tarea["clase"];
  estilo: Estilo;
  rep: number;
  exito: boolean;
  entregado: boolean;
  turnos: number;
  llamadas: number;
  relecturas: number;
  tokens: { entrada: number; salida: number; cacheLeida: number; cacheEscrita: number };
  /** = tokens.salida, a la vista: es LA cifra de este banco. */
  tokensSalida: number;
  /** La parte de la factura que es salida (tokensSalida × precio de salida del modelo). */
  costeSalidaUsd: number;
  /** La factura entera de la ejecución (medidor de producción, primas de caché incluidas). */
  costeTotalUsd: number;
  /** Longitud (chars) de lo que el modelo entregó con `entregar`. Solo la cifra. */
  charsEntrega: number;
  /** Chars de prosa (bloques de texto) emitidos en todos los turnos. Solo la cifra. */
  charsTexto: number;
  /** Solo si el usage del proveedor lo desglosa; Messages no suele hacerlo. */
  thinkingTokens?: number;
  /** Turnos cortados por max_tokens: una salida truncada no se compara, se declara. */
  truncados?: number;
  /** Tokens de salida del turno más largo: prueba de que nadie rozó el techo. */
  maxSalidaTurno?: number;
  /** Bloques `thinking` vistos: en un modelo con thinking adaptativo la salida
   *  llevaría razonamiento invisible y el banco mediría otra cosa. */
  bloquesThinking?: number;
  /** La ejecución reventó (HTTP/red) antes de terminar: se conserva el gasto
   *  parcial y el par sale de la puerta de éxito (no es un fracaso del estilo). */
  error?: string;
}

/** La ejecución de una tarea que reventó antes de medir nada: cuenta como fracaso, coste 0. */
export function ejecucionVacia(tarea: Tarea, estilo: Estilo, rep: number): EjecucionSalida {
  return {
    tarea: tarea.id,
    clase: tarea.clase,
    estilo,
    rep,
    exito: false,
    entregado: false,
    turnos: 0,
    llamadas: 0,
    relecturas: 0,
    tokens: { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 },
    tokensSalida: 0,
    costeSalidaUsd: 0,
    costeTotalUsd: 0,
    charsEntrega: 0,
    charsTexto: 0,
  };
}

// ── Estadística: bootstrap sobre PARES (tarea, rep), PRNG sembrado ──

export interface IntervaloDeConfianza {
  media: number;
  inferior: number;
  superior: number;
}

/** La semilla fija: dos veredictos sobre las mismas ejecuciones son byte-idénticos. */
export const SEMILLA_BOOTSTRAP = 20260906;
export const REPS_BOOTSTRAP = 10_000;

/**
 * Media de (b − a) sobre pares remuestreados con reemplazo; IC 95 % por
 * percentiles. Es la misma función que `bootstrapDiferencia` del anillo 1,
 * COPIADA a propósito: `benchmarks/anillo1/arnes.ts` arranca su `main()` cuando
 * `process.argv[1]` contiene «arnes», así que importarlo desde un fichero que
 * también se llama arnes.ts dispararía la tirada del anillo 1 al ejecutar esta.
 */
export function bootstrapDiferencia(
  pares: { a: number; b: number }[],
  reps = REPS_BOOTSTRAP,
  semilla = SEMILLA_BOOTSTRAP,
): IntervaloDeConfianza {
  const n = pares.length;
  const diffs = pares.map((p) => p.b - p.a);
  const media = diffs.reduce((x, y) => x + y, 0) / n;
  const azar = prng(semilla);
  const medias: number[] = [];
  for (let i = 0; i < reps; i++) {
    let suma = 0;
    for (let j = 0; j < n; j++) suma += diffs[Math.floor(azar() * n)]!;
    medias.push(suma / n);
  }
  medias.sort((x, y) => x - y);
  return { media, inferior: medias[Math.floor(reps * 0.025)]!, superior: medias[Math.floor(reps * 0.975)]! };
}

/**
 * Reducción en % de una MASA (tokens o dólares): 100 · (1 − Σestilo / Σbase)
 * sobre pares remuestreados. Se remuestrea la razón de sumas y no la media de
 * razones por pareja porque lo que se factura es la masa: una tarea de 2.000
 * tokens de salida pesa lo que pesa, y la media de porcentajes por pareja
 * dejaría que una tarea de 50 tokens la anulara. Negativo = el estilo EMPEORA.
 */
export function bootstrapReduccionPct(
  pares: { base: number; estilo: number }[],
  reps = REPS_BOOTSTRAP,
  semilla = SEMILLA_BOOTSTRAP,
): IntervaloDeConfianza {
  const n = pares.length;
  const reduccion = (xs: { base: number; estilo: number }[]): number => {
    let b = 0;
    let e = 0;
    for (const p of xs) {
      b += p.base;
      e += p.estilo;
    }
    return b === 0 ? 0 : 100 * (1 - e / b);
  };
  const media = reduccion(pares);
  const azar = prng(semilla);
  const muestras: number[] = [];
  for (let i = 0; i < reps; i++) {
    const remuestreo: { base: number; estilo: number }[] = [];
    for (let j = 0; j < n; j++) remuestreo.push(pares[Math.floor(azar() * n)]!);
    muestras.push(reduccion(remuestreo));
  }
  muestras.sort((x, y) => x - y);
  return { media, inferior: muestras[Math.floor(reps * 0.025)]!, superior: muestras[Math.floor(reps * 0.975)]! };
}

/**
 * El mismo remuestreo, pero por TAREA (clúster): las reps de una tarea
 * comparten fixture byte-idéntico (tareas.ts construye sin semilla por rep),
 * así que 15 tareas × 2 reps no son 30 unidades independientes. Remuestrear
 * pares infla la n efectiva, estrecha el IC y regala suelo (medido 06-09: ~3
 * puntos). Aquí cada remuestreo coge la tarea ENTERA con todas sus reps.
 */
export function bootstrapReduccionPctPorTarea(
  pares: { tarea: string; base: number; estilo: number }[],
  reps = REPS_BOOTSTRAP,
  semilla = SEMILLA_BOOTSTRAP,
): IntervaloDeConfianza {
  const grupos = new Map<string, { base: number; estilo: number }[]>();
  for (const p of pares) (grupos.get(p.tarea) ?? grupos.set(p.tarea, []).get(p.tarea)!).push(p);
  const tareas = [...grupos.keys()].sort().map((t) => grupos.get(t)!);
  const n = tareas.length;
  const reduccion = (xs: { base: number; estilo: number }[][]): number => {
    let b = 0;
    let e = 0;
    for (const g of xs) for (const p of g) {
      b += p.base;
      e += p.estilo;
    }
    return b === 0 ? 0 : 100 * (1 - e / b);
  };
  const media = reduccion(tareas);
  if (n < 2) return { media, inferior: NaN, superior: NaN };
  const azar = prng(semilla);
  const muestras: number[] = [];
  for (let i = 0; i < reps; i++) {
    const remuestreo: { base: number; estilo: number }[][] = [];
    for (let j = 0; j < n; j++) remuestreo.push(tareas[Math.floor(azar() * n)]!);
    muestras.push(reduccion(remuestreo));
  }
  muestras.sort((x, y) => x - y);
  return { media, inferior: muestras[Math.floor(reps * 0.025)]!, superior: muestras[Math.floor(reps * 0.975)]! };
}

/** Diferencia media (b − a) con IC, remuestreando TAREAS enteras (mismo motivo). */
export function bootstrapDiferenciaPorTarea(
  pares: { tarea: string; a: number; b: number }[],
  reps = REPS_BOOTSTRAP,
  semilla = SEMILLA_BOOTSTRAP,
): IntervaloDeConfianza {
  const grupos = new Map<string, number[]>();
  for (const p of pares) (grupos.get(p.tarea) ?? grupos.set(p.tarea, []).get(p.tarea)!).push(p.b - p.a);
  const tareas = [...grupos.keys()].sort().map((t) => grupos.get(t)!);
  const n = tareas.length;
  const mediaDe = (xs: number[][]): number => {
    let s = 0;
    let c = 0;
    for (const g of xs) for (const d of g) {
      s += d;
      c += 1;
    }
    return c === 0 ? 0 : s / c;
  };
  const media = mediaDe(tareas);
  if (n < 2) return { media, inferior: NaN, superior: NaN };
  const azar = prng(semilla);
  const medias: number[] = [];
  for (let i = 0; i < reps; i++) {
    const remuestreo: number[][] = [];
    for (let j = 0; j < n; j++) remuestreo.push(tareas[Math.floor(azar() * n)]!);
    medias.push(mediaDe(remuestreo));
  }
  medias.sort((x, y) => x - y);
  return { media, inferior: medias[Math.floor(reps * 0.025)]!, superior: medias[Math.floor(reps * 0.975)]! };
}

// ── El veredicto ──

export interface MasaComparada {
  base: number;
  estilo: number;
  /** IC 95 % de la reducción en %, remuestreando TAREAS; se publica `inferior`, nunca `media`. */
  reduccionPct: IntervaloDeConfianza;
  /** El IC por pares (tarea, rep), más estrecho de lo honesto: solo para comparar. */
  reduccionPctPorPares: IntervaloDeConfianza;
}

export interface VeredictoDeEstilo {
  estilo: Estilo;
  /** Pares (tarea, rep) con AMBAS ejecuciones medidas (coste > 0). */
  pares: number;
  /** Pares con ambas ejecuciones presentes (las reventadas cuentan como fracaso). */
  paresDeExito: number;
  tokensSalida: MasaComparada;
  /**
   * La misma masa contando SOLO los pares donde ambos brazos resolvieron la
   * tarea: un estilo que fracasa más corto «ahorra» tokens de trabajo inútil.
   * `publicable` usa el MENOR de los dos suelos.
   */
  tokensSalidaDobleExito: MasaComparada & { pares: number };
  costeSalida: MasaComparada;
  /**
   * La factura ENTERA. El texto del estilo engorda la entrada de cada turno, y
   * en trabajo agéntico la entrada manda: puede salir NEGATIVO aunque la salida
   * baje. `empeora` lo dice sin rodeos.
   */
  costeTotal: MasaComparada & { empeora: boolean };
  tokensEntrada: { base: number; estilo: number };
  /** De dónde sale el ahorro TOTAL en dólares: salida (lo que este banco mide)
   *  y entrada (las reglas de tool calls del estilo, en régimen SIN caché). */
  descomposicionAhorroUsd: { salida: number; entrada: number };
  truncados: { base: number; estilo: number };
  /** Pares con alguna ejecución reventada: fuera de la puerta de éxito. */
  paresConError: number;
  /** Tareas sin ningún éxito en ninguno de los dos brazos: sin señal de calidad. */
  tareasSinSenal: string[];
  exito: {
    base: number;
    estilo: number;
    total: number;
    /** Diferencia estilo − base en fracción (0,1 = 10 puntos) con su IC. */
    diferencia: IntervaloDeConfianza | null;
    /** El estilo no pierde éxito fuera del IC (superior ≥ 0): la regla del anillo 1. */
    puerta: boolean;
  };
  relecturasPorLlamada: { base: number; estilo: number };
  turnosMedios: { base: number; estilo: number };
  charsEntregaMedios: { base: number; estilo: number };
  charsTextoMedios: { base: number; estilo: number };
  thinkingTokens: { base: number; estilo: number } | null;
  /** Suelo del IC de tokens de salida > 0 Y puerta de éxito. Nada más publica. */
  publicable: boolean;
  /** Por qué no es publicable, o avisos aunque lo sea (coste total negativo). */
  notas: string[];
}

export interface Veredicto {
  base: { ejecuciones: number; exitos: number; tokensSalida: number; costeTotalUsd: number };
  estilos: VeredictoDeEstilo[];
}

const clave = (e: { tarea: string; rep: number }): string => `${e.tarea} ${e.rep}`;
const suma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const media = (xs: number[]): number => (xs.length === 0 ? 0 : suma(xs) / xs.length);

/** Sin dos pares no hay IC: la razón de sumas sola, con los extremos a NaN para que nadie la publique. */
function masaSinIC(xs: { base: number; estilo: number }[]): IntervaloDeConfianza {
  const b = suma(xs.map((x) => x.base));
  const e = suma(xs.map((x) => x.estilo));
  return { media: b === 0 ? 0 : 100 * (1 - e / b), inferior: NaN, superior: NaN };
}

/**
 * Compara cada estilo ≠ base contra base por PARES (tarea, rep). Determinista:
 * el orden de entrada de `ejecuciones` no cambia ni un decimal (se ordena por
 * (tarea, rep, estilo) antes de emparejar y el PRNG del bootstrap va sembrado).
 */
export function veredicto(ejecuciones: EjecucionSalida[], estilos: readonly Estilo[]): Veredicto {
  const ordenadas = [...ejecuciones].sort(
    (x, y) => x.tarea.localeCompare(y.tarea) || x.rep - y.rep || ESTILOS.indexOf(x.estilo) - ESTILOS.indexOf(y.estilo),
  );
  const porEstilo = new Map<Estilo, Map<string, EjecucionSalida>>();
  for (const e of ordenadas) {
    if (!porEstilo.has(e.estilo)) porEstilo.set(e.estilo, new Map());
    porEstilo.get(e.estilo)!.set(clave(e), e);
  }
  const base = porEstilo.get("base") ?? new Map<string, EjecucionSalida>();
  const clavesBase = [...base.keys()].sort();
  const todasBase = clavesBase.map((k) => base.get(k)!);

  const resultado: Veredicto = {
    base: {
      ejecuciones: todasBase.length,
      exitos: todasBase.filter((e) => e.exito).length,
      tokensSalida: suma(todasBase.map((e) => e.tokensSalida)),
      costeTotalUsd: suma(todasBase.map((e) => e.costeTotalUsd)),
    },
    estilos: [],
  };

  for (const estilo of estilos) {
    if (estilo === "base") continue;
    const propias = porEstilo.get(estilo) ?? new Map<string, EjecucionSalida>();
    const pares: { b: EjecucionSalida; e: EjecucionSalida }[] = [];
    for (const k of clavesBase) {
      const e = propias.get(k);
      if (e) pares.push({ b: base.get(k)!, e });
    }
    const sanos = pares.filter((p) => p.b.error === undefined && p.e.error === undefined);
    const medidos = sanos.filter((p) => p.b.costeTotalUsd > 0 && p.e.costeTotalUsd > 0);
    const dobleExito = medidos.filter((p) => p.b.exito && p.e.exito);
    const notas: string[] = [];

    const masa = (xs0: { b: EjecucionSalida; e: EjecucionSalida }[], f: (x: EjecucionSalida) => number): MasaComparada => {
      const xs = xs0.map((p) => ({ tarea: p.b.tarea, base: f(p.b), estilo: f(p.e) }));
      return {
        base: suma(xs.map((x) => x.base)),
        estilo: suma(xs.map((x) => x.estilo)),
        reduccionPct: xs.length >= 2 ? bootstrapReduccionPctPorTarea(xs) : masaSinIC(xs),
        reduccionPctPorPares: xs.length >= 2 ? bootstrapReduccionPct(xs) : masaSinIC(xs),
      };
    };
    const tokensSalida = masa(medidos, (x) => x.tokensSalida);
    const tokensSalidaDobleExito = { ...masa(dobleExito, (x) => x.tokensSalida), pares: dobleExito.length };
    const costeSalida = masa(medidos, (x) => x.costeSalidaUsd);
    const costeTotalMasa = masa(medidos, (x) => x.costeTotalUsd);
    const costeTotal = { ...costeTotalMasa, empeora: costeTotalMasa.reduccionPct.media < 0 };
    const descomposicionAhorroUsd = {
      salida: costeSalida.base - costeSalida.estilo,
      entrada: costeTotalMasa.base - costeTotalMasa.estilo - (costeSalida.base - costeSalida.estilo),
    };

    const diferencia =
      sanos.length >= 2
        ? bootstrapDiferenciaPorTarea(sanos.map((p) => ({ tarea: p.b.tarea, a: p.b.exito ? 1 : 0, b: p.e.exito ? 1 : 0 })))
        : null;
    const puerta = diferencia !== null && diferencia.superior >= 0;

    const relecturas = (xs: EjecucionSalida[]): number => {
      const llamadas = suma(xs.map((x) => x.llamadas));
      return llamadas === 0 ? 0 : suma(xs.map((x) => x.relecturas)) / llamadas;
    };
    const lado = <T>(f: (xs: EjecucionSalida[]) => T): { base: T; estilo: T } => ({
      base: f(medidos.map((p) => p.b)),
      estilo: f(medidos.map((p) => p.e)),
    });
    const conThinking = medidos.some((p) => p.b.thinkingTokens !== undefined || p.e.thinkingTokens !== undefined);
    const truncados = lado((xs) => suma(xs.map((x) => x.truncados ?? 0)));
    const bloquesThinking = lado((xs) => suma(xs.map((x) => x.bloquesThinking ?? 0)));
    const tareasSinSenal = [...new Set(sanos.filter((p) => !p.b.exito && !p.e.exito).map((p) => p.b.tarea))]
      .filter((t) => !sanos.some((p) => p.b.tarea === t && (p.b.exito || p.e.exito)))
      .sort();

    if (medidos.length < 2) notas.push(`solo ${medidos.length} par(es) medido(s): sin IC, nada que publicar`);
    else if (!(tokensSalida.reduccionPct.inferior > 0))
      notas.push(
        `el suelo del IC de tokens de salida no separa de cero (${tokensSalida.reduccionPct.inferior.toFixed(1)} %): no se publica`,
      );
    if (dobleExito.length >= 2 && !(tokensSalidaDobleExito.reduccionPct.inferior > 0))
      notas.push(
        `contando solo los pares con doble éxito (${dobleExito.length}) el suelo no separa de cero (${tokensSalidaDobleExito.reduccionPct.inferior.toFixed(1)} %): no se publica`,
      );
    if (dobleExito.length < 2 && medidos.length >= 2) notas.push("menos de 2 pares con doble éxito: sin masa limpia que publicar");
    if (diferencia === null) notas.push("sin pares suficientes para la puerta de éxito");
    else if (!puerta)
      notas.push(
        `pierde éxito de tarea fuera del IC (${(diferencia.media * 100).toFixed(1)} pt, IC95 [${(diferencia.inferior * 100).toFixed(1)}, ${(diferencia.superior * 100).toFixed(1)}]): QUALITY_FLOOR`,
      );
    if (costeTotal.empeora)
      notas.push(
        `el coste TOTAL empeora (${costeTotal.reduccionPct.media.toFixed(1)} %): el texto del estilo cuesta más entrada de lo que ahorra en salida`,
      );
    const ahorroTotal = descomposicionAhorroUsd.salida + descomposicionAhorroUsd.entrada;
    if (ahorroTotal > 0 && descomposicionAhorroUsd.entrada / ahorroTotal > 0.5)
      notas.push(
        `el ${((descomposicionAhorroUsd.entrada / ahorroTotal) * 100).toFixed(0)} % del ahorro TOTAL es ENTRADA (menos lecturas), en régimen SIN caché: no transferible a producción, donde la entrada va a precio de caché`,
      );
    if (truncados.base + truncados.estilo > 0)
      notas.push(`salidas TRUNCADAS por max_tokens (base ${truncados.base}, estilo ${truncados.estilo}): la comparación no vale, no se publica`);
    if (bloquesThinking.base + bloquesThinking.estilo > 0)
      notas.push(`bloques thinking vistos (base ${bloquesThinking.base}, estilo ${bloquesThinking.estilo}): la salida lleva razonamiento invisible, no se publica`);
    if (pares.length - sanos.length > 0) notas.push(`${pares.length - sanos.length} par(es) con ejecución reventada: fuera de la puerta de éxito`);
    if (tareasSinSenal.length) notas.push(`sin señal de calidad en ${tareasSinSenal.join(", ")}: ningún brazo las resuelve`);

    const publicable =
      medidos.length >= 2 &&
      dobleExito.length >= 2 &&
      tokensSalida.reduccionPct.inferior > 0 &&
      tokensSalidaDobleExito.reduccionPct.inferior > 0 &&
      puerta &&
      truncados.base + truncados.estilo === 0 &&
      bloquesThinking.base + bloquesThinking.estilo === 0;

    resultado.estilos.push({
      estilo,
      pares: medidos.length,
      paresDeExito: sanos.length,
      tokensSalida,
      tokensSalidaDobleExito,
      costeSalida,
      costeTotal,
      tokensEntrada: lado((xs) => suma(xs.map((x) => x.tokens.entrada + x.tokens.cacheLeida + x.tokens.cacheEscrita))),
      descomposicionAhorroUsd,
      truncados,
      paresConError: pares.length - sanos.length,
      tareasSinSenal,
      exito: {
        base: sanos.filter((p) => p.b.exito).length,
        estilo: sanos.filter((p) => p.e.exito).length,
        total: sanos.length,
        diferencia,
        puerta,
      },
      relecturasPorLlamada: lado(relecturas),
      turnosMedios: lado((xs) => media(xs.map((x) => x.turnos))),
      charsEntregaMedios: lado((xs) => media(xs.map((x) => x.charsEntrega))),
      charsTextoMedios: lado((xs) => media(xs.map((x) => x.charsTexto))),
      thinkingTokens: conThinking ? lado((xs) => suma(xs.map((x) => x.thinkingTokens ?? 0))) : null,
      publicable,
      notas,
    });
  }
  return resultado;
}
