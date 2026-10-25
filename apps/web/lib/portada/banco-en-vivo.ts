/**
 * LAS CIFRAS QUE LA PORTADA PUBLICA, CON SU INFORME AL LADO.
 * ---------------------------------------------------------------------------
 * Hasta el 2026-09-29 la portada decía «con el SDK tal como lo instalas desde
 * npm, la factura baja al menos un 10 %» y enseñaba libros como
 * «avoided_calls ≥ 22 %» o «eliminated_tokens ≥ 43,2 %». Todo salía de
 * `public/data/ab-live.json`: una tirada sintética del 2026-09-12 con un
 * compresor que el paquete de npm no trae. El banco público (/benchmarks) dice
 * otra cosa, y la dice con informe: con tráfico que repite peticiones la capa
 * ahorra, y sin repeticiones el ahorro es indistinguible de cero.
 *
 * La portada publica ahora SOLO esto, y condicionado:
 *   · GSM8K en vivo contra OpenAI gpt-4o-mini, flujo con un 30 % de
 *     repeticiones exactas: ahorro del brazo B (la capa con su configuración
 *     por defecto) frente a A (directo al proveedor), con su IC 95 %.
 *   · Sin repeticiones (MT-Bench, BFCL): ≈ 0. Esa frase la pinta /benchmarks
 *     con sus propias cifras; aquí solo se dice y se enlaza.
 *   · Un flujo reducido distinto contra Claude Sonnet 5: el total de B, y
 *     cuánto corresponde al efecto de caché de prefijo habilitado por la capa
 *     mediante cache_control en B, no a un descuento preexistente de Anthropic.
 *
 * Los números están escritos aquí A MANO a propósito — la portada es ISR y en
 * Vercel no puede leer `docs/` al regenerarse —, pero no sin verja:
 * `banco-en-vivo.test.ts` los compara, uno a uno, con los JSON de los informes
 * (`docs/benchmarks/2026-09-28/gsm8k-0431*.json`). Si un informe cambia o una
 * cifra de aquí se aparta de él una décima, el build se pone rojo.
 *
 * Fracciones en [0, 1]; se formatean con el idioma de la página. Los mensajes
 * no llevan dígitos: cada número llega por parámetro desde aquí.
 */

export interface Intervalo {
  /** Estimación puntual. */
  point: number;
  /** Cota inferior del IC 95 % (remuestreo por familias de problemas). */
  lower: number;
  /** Cota superior del IC 95 %. */
  upper: number;
}

export const BANCO_EN_VIVO = {
  /** Fecha de las tiradas (la de los informes). */
  fecha: "2026-09-28",
  /** Versión del SDK medida: el fuente de la etiqueta, con un dist idéntico al tarball de npm. */
  versionSdk: "0.4.31",
  /** Batería. */
  bateria: "GSM8K",
  /** Fracción de repeticiones EXACTAS del flujo (`flujo.fraccionRepeticiones`). */
  repeticiones: 0.3,
  openai: {
    informe: "docs/benchmarks/2026-09-28/gsm8k-0431.json",
    modelo: "openai/gpt-4o-mini",
    familias: 100,
    peticionesPorBrazo: 200,
    /** Ahorro medido de B frente a A (`resumen.comparaciones[B].ahorroMedido`), redondeado a la décima. */
    ahorro: { point: 0.315, lower: 0.257, upper: 0.367 } satisfies Intervalo,
  },
  anthropic: {
    informe: "docs/benchmarks/2026-09-28/gsm8k-0431-claude.json",
    modelo: "anthropic/claude-sonnet-5",
    familias: 31,
    peticionesPorBrazo: 62,
    /** Ahorro TOTAL de B frente a A, incluido el efecto de cache_control habilitado en B. */
    ahorro: { point: 0.751, lower: 0.693, upper: 0.796 } satisfies Intervalo,
    /**
     * La parte del coste de A a precios de lista atribuible al efecto de caché
     * habilitado en B (`desglose[B].prefijoNetoUsd / costeA`), redondeada a la
     * unidad hacia abajo: estimación puntual, sin intervalo propio en el informe.
     */
    prefijoDelProveedor: 0.41,
  },
} as const;

/**
 * El adaptador nativo de Gemini (`GoogleProvider`, #410) llegó en la 0.4.33.
 * Compatible no es medido: no hay cifra de AHORRO de Gemini publicada en
 * /benchmarks.
 */
export const VERSION_GEMINI_NATIVO = "0.4.33";

/**
 * LO MEDIDO DE GEMINI (2026-10-01): el primer banco semanal en vivo con Gemini
 * por su API nativa (run 1398eb, fuente de main 5bec174). Mide que la capa no
 * rompe nada ni cobra de más — fallos solo con la capa, negativas cacheadas o
 * acreditadas, informe frente a factura —, NO un porcentaje de ahorro: la
 * portada no saca de aquí ninguna cifra.
 *
 *   · `medido`: el modelo con las CUATRO baterías medidas en ese informe, sin
 *     ningún fallo de la capa y sin negativas cacheadas ni acreditadas.
 *   · `pro`: el modelo que esa tirada NO pudo medir (la cuota del proveedor:
 *     250 peticiones al día, 429 en las cuatro baterías). Desde #448 sus
 *     baterías van en dos jornadas (benchmarks/banco-semanal/plan.ts,
 *     CUOTA_DIARIA), y lo midieron dos bancos PARCIALES limitados a él
 *     (runs 36925298365 y 36977332185, fuente de main b349d7a): BFCL y
 *     MT-Bench el 1, GSM8K y XSTest el 2. Cada batería medida una vez, sin
 *     fallos de la capa ni negativas cacheadas o acreditadas.
 *
 * `portada-dice-lo-medido.test.ts` lo comprueba contra el JSON del informe: si
 * el informe deja de sostener una de las dos frases, el build se pone rojo.
 */
export const GEMINI_EN_EL_SEMANAL = {
  informe: "docs/benchmarks/2026-10-01/banco-semanal-5bec174.json",
  /** Día en que empezó la tirada (su `inicio`). */
  fecha: "2026-10-01",
  medido: { modelo: "google/gemini-3.8-flash", nombre: "Gemini 3.8 Flash" },
  pro: {
    modelo: "google/gemini-3.1-pro-preview",
    nombre: "Gemini 3.1 Pro",
    /** Los dos bancos parciales (una jornada cada uno), en orden. */
    informes: [
      "docs/benchmarks/2026-10-01/banco-semanal-b349d7a-gemini-31-pro-jornada-1.json",
      "docs/benchmarks/2026-10-02/banco-semanal-b349d7a-gemini-31-pro-jornada-2.json",
    ],
    /** Primer y último día (su `inicio`). */
    desde: "2026-10-01",
    hasta: "2026-10-02",
  },
} as const;
