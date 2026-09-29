/**
 * EL BANCO SEMANAL · EL PLAN: qué se mide, con qué modelos y con cuánto dinero.
 * ---------------------------------------------------------------------------
 * Decisión del dueño (2026-09-29): un banco EN VIVO automático, cada semana, con
 * 50 $ como máximo, contra el FUENTE de main (licencia de desarrollo abierta,
 * como `pnpm ab`), que bloquee la release si algo empeora.
 *
 * Todo lo de este fichero es PURO: sin red, sin disco, sin reloj. Así el reparto
 * del dinero y los topes se prueban en test/banco-semanal.test.ts sin gastar un
 * céntimo, y lo que se prueba es exactamente lo que corre el workflow.
 *
 * TRES TOPES, los tres DUROS y los tres en código:
 *   1. POR CELDA (modelo × batería): se le pasa al arnés (`--presupuesto`,
 *      `--tope`), que reserva el peor caso de cada llamada ANTES de hacerla y no
 *      la hace si no cabe. Cada arnés tiene además su propio techo por familia
 *      (0,80 $ OpenAI / 1,25 $ Anthropic en la 0.4.31), y manda el MENOR.
 *   2. DEL JUEZ de MT-Bench, por celda (`--tope-juez`).
 *   3. GLOBAL, 50 $: la caja del orquestador (`CajaGlobal`) RESERVA el tope
 *      entero de una celda antes de lanzarla y solo devuelve lo que no se gastó
 *      cuando termina. Si una reserva no cabe, la celda no se lanza y el banco
 *      aborta lo que queda. Una celda que muere sin artefacto se da por gastada
 *      ENTERA: sin artefacto no hay forma de saber cuánto gastó, y la caja no
 *      puede suponer que poco.
 *
 * El reparto asigna 41,70 $ (lo que suman las celdas y el juez); los 8,30 $ que
 * faltan hasta 50 NO se asignan a nada: son el margen que hace que el tope
 * global salte por un fallo de contabilidad de un arnés, nunca por el gasto
 * previsto. `test/banco-semanal.test.ts` rompe si el reparto supera los 50 $.
 */

export const PRESUPUESTO_SEMANAL_USD = 50;
/** El mayor tope que acepta hoy cualquiera de los cuatro arneses por modelo (GSM8K rechaza más de 1,25). */
export const TECHO_DE_CELDA_USD = 1.25;
export const SEMILLA = 20260928;
export const BATERIAS = ["gsm8k", "bfcl", "xstest", "mt-bench"] as const;
export type Bateria = (typeof BATERIAS)[number];
export type Familia = "openai" | "anthropic" | "google";

/**
 * La gama decide el tope y el tamaño de la submuestra. «Cara» no es solo el
 * precio de lista: gpt-5.5 cuesta 30 $/M de salida y un Opus razona, así que en
 * los dos la misma submuestra cuesta un orden de magnitud más que en un mini.
 */
export type Gama = "barata" | "media" | "cara";

export interface ModeloDelBanco {
  /** Id con proveedor, como lo espera la capa (`openai/gpt-4o-mini`). */
  id: string;
  /** Id sin proveedor, como lo esperan XSTest y MT-Bench (`gpt-4o-mini`). */
  corto: string;
  familia: Familia;
  gama: Gama;
}

const m = (id: string, gama: Gama): ModeloDelBanco => {
  const [familia, corto] = id.split("/") as [Familia, string];
  return { id, corto, familia, gama };
};

/** Los diez modelos que decidió el dueño, en el orden en que se lanzan. */
export const MODELOS_DEL_BANCO: readonly ModeloDelBanco[] = [
  m("openai/gpt-4o-mini", "barata"),
  m("openai/gpt-5.4-mini", "barata"),
  m("openai/gpt-5.5", "cara"),
  m("openai/gpt-5.6-sol", "cara"),
  m("anthropic/claude-haiku-4-5", "barata"),
  m("anthropic/claude-sonnet-5", "media"),
  m("anthropic/claude-sonnet-5-5", "media"),
  m("anthropic/claude-opus-5-5", "cara"),
  m("google/gemini-3.8-flash", "barata"),
  m("google/gemini-3.1-pro-preview", "media"),
];

/** Tope DURO por celda (modelo × batería), en USD. */
export const TOPE_POR_GAMA_USD: Readonly<Record<Gama, number>> = { barata: 0.75, media: 1.1, cara: 1.25 };
/** Tope DURO del juez de MT-Bench (gpt-4o por AI Gateway) por modelo juzgado. */
export const TOPE_DEL_JUEZ_POR_MODELO_USD = 0.15;

/**
 * SUBMUESTRAS: estratificadas y con semilla fija DENTRO de cada arnés (BFCL por
 * categoría AST, XSTest por tipo y etiqueta, MT-Bench por categoría, GSM8K por
 * familia de problema). Lo que aquí se decide es solo el tamaño: las caras miran
 * menos preguntas para caber en su tope, y su intervalo es más ancho — lo dice
 * el resumen, no se esconde.
 *
 * BFCL multi-turn en las caras: 0. El arnés reserva el peor caso de una entrada
 * multi-turn entera (12 llamadas con el catálogo de herramientas completo y
 * 4096 tokens de salida cada una) ANTES de empezarla; con gpt-5.5 u Opus esa
 * reserva no cabe en el tope de la celda, el arnés lo marca «agotado» y ya no
 * mide ni el AST (comprobado en SECO el 2026-09-29: 0 entradas). Sin multi-turn
 * el AST de las caras sí se mide.
 */
export const SUBMUESTRA: Readonly<
  Record<Gama, { gsm8kUnicos: number; bfcl: { n: number; multi: number; repes: number }; xstestN: number | null; mtBenchPreguntas: number }>
> = {
  barata: { gsm8kUnicos: 100, bfcl: { n: 25, multi: 4, repes: 5 }, xstestN: null, mtBenchPreguntas: 40 },
  media: { gsm8kUnicos: 60, bfcl: { n: 12, multi: 2, repes: 3 }, xstestN: 200, mtBenchPreguntas: 24 },
  cara: { gsm8kUnicos: 40, bfcl: { n: 8, multi: 0, repes: 2 }, xstestN: 100, mtBenchPreguntas: 16 },
};

/** Tiempo máximo de una celda: un arnés colgado no puede comerse el trabajo entero (6 h en GitHub). */
export const PLAZO_DE_CELDA_MS = 75 * 60_000;
/** Cuántas celdas de una MISMA batería corren a la vez. GSM8K escribe siempre el mismo fichero: de una en una. */
export const CONCURRENCIA_POR_BATERIA: Readonly<Record<Bateria, number>> = { gsm8k: 1, bfcl: 2, xstest: 2, "mt-bench": 2 };

export type Modo = "vivo" | "seco";

export interface Celda {
  bateria: Bateria;
  modelo: ModeloDelBanco;
  /** Tope de generación (A + B + repeticiones), USD. */
  topeUsd: number;
  /** Tope del juez (solo MT-Bench), USD. */
  topeJuezUsd: number;
  /** Lo que la caja global reserva antes de lanzarla: los dos topes juntos. */
  reservaUsd: number;
}

export function topeDeCelda(bateria: Bateria, modelo: ModeloDelBanco): { topeUsd: number; topeJuezUsd: number } {
  return {
    topeUsd: TOPE_POR_GAMA_USD[modelo.gama],
    topeJuezUsd: bateria === "mt-bench" ? TOPE_DEL_JUEZ_POR_MODELO_USD : 0,
  };
}

/** El plan entero: una celda por modelo y batería, en orden de lanzamiento. */
export function planificar(modelos: readonly ModeloDelBanco[] = MODELOS_DEL_BANCO): Celda[] {
  const celdas: Celda[] = [];
  for (const bateria of BATERIAS) {
    for (const modelo of modelos) {
      const t = topeDeCelda(bateria, modelo);
      celdas.push({ bateria, modelo, ...t, reservaUsd: redondear(t.topeUsd + t.topeJuezUsd) });
    }
  }
  return celdas;
}

export interface Reparto {
  porModelo: Record<string, number>;
  porBateria: Record<Bateria, number>;
  juezUsd: number;
  asignadoUsd: number;
  margenUsd: number;
}

export function reparto(celdas: readonly Celda[] = planificar()): Reparto {
  const porModelo: Record<string, number> = {};
  const porBateria = Object.fromEntries(BATERIAS.map((b) => [b, 0])) as Record<Bateria, number>;
  let juezUsd = 0;
  for (const c of celdas) {
    porModelo[c.modelo.id] = redondear((porModelo[c.modelo.id] ?? 0) + c.reservaUsd);
    porBateria[c.bateria] = redondear(porBateria[c.bateria] + c.reservaUsd);
    juezUsd = redondear(juezUsd + c.topeJuezUsd);
  }
  const asignadoUsd = redondear(celdas.reduce((s, c) => s + c.reservaUsd, 0));
  return { porModelo, porBateria, juezUsd, asignadoUsd, margenUsd: redondear(PRESUPUESTO_SEMANAL_USD - asignadoUsd) };
}

/** Lo que el plan no puede incumplir; el orquestador lo comprueba antes de gastar nada. */
export function validarPlan(celdas: readonly Celda[]): string[] {
  const errores: string[] = [];
  for (const c of celdas) {
    if (!(c.topeUsd > 0) || c.topeUsd > TECHO_DE_CELDA_USD) errores.push(`${c.bateria}/${c.modelo.id}: tope ${c.topeUsd} fuera de (0, ${TECHO_DE_CELDA_USD}]`);
  }
  const total = reparto(celdas).asignadoUsd;
  if (total > PRESUPUESTO_SEMANAL_USD) errores.push(`el plan asigna ${total} $ y el presupuesto semanal es ${PRESUPUESTO_SEMANAL_USD} $`);
  return errores;
}

/**
 * Los argumentos de línea de órdenes de cada arnés para una celda. `dir` es el
 * directorio propio de la celda (BFCL, XSTest y MT-Bench escriben ahí; GSM8K
 * siempre escribe `benchmarks/out/gsm8k/`, y el orquestador copia su fichero).
 */
export function argumentosDe(c: Celda, modo: Modo, dir: string, runId: string): string[] {
  const s = SUBMUESTRA[c.modelo.gama];
  const vivo = modo === "vivo";
  const usd = (x: number) => x.toFixed(2);
  switch (c.bateria) {
    case "gsm8k":
      return [
        "benchmarks/publicados/gsm8k/arnes.ts",
        ...(vivo ? ["--desde-fuente"] : ["--seco"]),
        "--modelos",
        c.modelo.id,
        "--n-unicos",
        String(vivo ? s.gsm8kUnicos : 10),
        "--presupuesto",
        usd(c.topeUsd),
      ];
    case "bfcl":
      return [
        "benchmarks/publicados/bfcl/arnes.ts",
        "--fuente-de-main",
        ...(vivo ? [] : ["--mock"]),
        `--modelos=${c.modelo.id}`,
        `--n=${vivo ? s.bfcl.n : 2}`,
        `--multi=${vivo ? s.bfcl.multi : Math.min(1, s.bfcl.multi)}`,
        `--repes=${vivo ? s.bfcl.repes : 1}`,
        `--tope=${usd(c.topeUsd)}`,
        `--semilla=${SEMILLA}`,
        `--salida=${dir}`,
        "--nombre=bfcl",
        // Sin comparación con la tirada publicada de la 0.4.30: el banco compara A con B, no versiones.
        "--comparar=",
      ];
    case "xstest":
      return [
        "benchmarks/publicados/xstest/banco.ts",
        "--fuente-de-main",
        ...(vivo ? ["--vivo"] : []),
        `--modelos=${c.modelo.corto}`,
        ...(vivo ? (s.xstestN !== null ? [`--n=${s.xstestN}`] : []) : ["--n=12"]),
        `--tope=${usd(c.topeUsd)}`,
        `--semilla=${SEMILLA}`,
        `--salida=${dir}`,
        "--nombre=xstest",
      ];
    case "mt-bench":
      return [
        "benchmarks/publicados/mt-bench/mt-bench.ts",
        "--fuente-de-main",
        ...(vivo ? [] : ["--mock"]),
        `--modelos=${c.modelo.corto}`,
        `--max-preguntas=${vivo ? s.mtBenchPreguntas : 4}`,
        `--tope=${usd(c.topeUsd)}`,
        `--tope-juez=${usd(c.topeJuezUsd)}`,
        // Un libro de gasto nuevo por tirada y modelo: el tope de la celda es el de ESTA semana.
        `--sufijo=bs-${runId}-${c.modelo.corto.replace(/[^a-z0-9-]/gi, "")}`,
        `--salida=${dir}`,
      ];
  }
}

// ── La caja global ──────────────────────────────────────────────────────────

export class TopeGlobalAgotado extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TopeGlobalAgotado";
  }
}

/**
 * EL TOPE GLOBAL. Reserva el tope entero de una celda antes de lanzarla, y al
 * terminar la liquida con lo que de verdad gastó (o con la reserva entera si no
 * se sabe). Es por construcción que la suma de lo gastado nunca pasa de
 * `limiteUsd`: solo se lanza lo que cabe si TODAS las celdas en vuelo gastaran
 * su tope entero.
 */
export class CajaGlobal {
  private gastadoUsd = 0;
  private reservadoUsd = 0;
  private abortada: string | null = null;

  constructor(readonly limiteUsd: number = PRESUPUESTO_SEMANAL_USD) {}

  get gastado(): number {
    return redondear(this.gastadoUsd);
  }
  get reservado(): number {
    return redondear(this.reservadoUsd);
  }
  get motivoDelAborto(): string | null {
    return this.abortada;
  }

  /** Reserva o aborta. Una vez abortada, no se reserva nada más. */
  reservar(usd: number, que: string): void {
    if (this.abortada) throw new TopeGlobalAgotado(this.abortada);
    if (!(usd >= 0)) throw new Error(`reserva inválida: ${usd}`);
    if (this.gastadoUsd + this.reservadoUsd + usd > this.limiteUsd + 1e-9) {
      this.abortada =
        `tope global: ${que} reservaría ${usd.toFixed(2)} $ con ${this.gastado.toFixed(2)} $ gastados y ` +
        `${this.reservado.toFixed(2)} $ en vuelo (límite ${this.limiteUsd.toFixed(2)} $); el banco aborta lo que queda`;
      throw new TopeGlobalAgotado(this.abortada);
    }
    this.reservadoUsd += usd;
  }

  /**
   * Libera la reserva y apunta el gasto. `gastoUsd === null` (sin artefacto) se
   * cuenta como la reserva ENTERA. Un gasto por ENCIMA de la reserva se apunta
   * tal cual —la caja no esconde un exceso— y aborta lo que queda.
   */
  liquidar(reservaUsd: number, gastoUsd: number | null, que: string): void {
    this.reservadoUsd = Math.max(0, this.reservadoUsd - reservaUsd);
    const g = gastoUsd ?? reservaUsd;
    this.gastadoUsd += g;
    if (g > reservaUsd + 0.01 && !this.abortada) {
      this.abortada = `tope global: ${que} gastó ${g.toFixed(4)} $ con una reserva de ${reservaUsd.toFixed(2)} $; el banco aborta lo que queda`;
    }
    if (this.gastadoUsd > this.limiteUsd + 1e-9 && !this.abortada) {
      this.abortada = `tope global: gastados ${this.gastado.toFixed(4)} $ de ${this.limiteUsd.toFixed(2)} $`;
    }
  }
}

export function redondear(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
