/**
 * LA CIFRA DE LA TARJETA DEL GATEWAY, CON SU INFORME AL LADO.
 * ---------------------------------------------------------------------------
 * Hasta el 2026-10-03 la tarjeta del gateway iba sin número: no había ninguna
 * medición publicable de su ahorro. Ese día el banco de TTL
 * (`docs/benchmarks/2026-10-03/ttl.md`, `pnpm ttl:replay`) midió la rebaja de
 * caché de PRO (escrituras 1h → 5 min) en NETO —restados los fallos de caché
 * que ella misma provoca— y el dueño decidió publicarla, con su condición.
 *
 * Qué es y qué no:
 *   · Un REPLAY a precios de lista sobre sesiones de Claude Code de UNA sola
 *     organización (la nuestra) contra UN proveedor (Anthropic). No es una
 *     factura ni una medición en vivo con el contador del proveedor, y no es
 *     una previsión para nadie más. La tarjeta lo dice con esas palabras.
 *   · El intervalo es el IC 95 % por SESIÓN (bootstrap), el más ancho por abajo
 *     de los dos que da el informe.
 *
 * Escrito A MANO, como `banco-en-vivo.ts` (la portada es ISR y en Vercel no lee
 * `docs/`), y con su verja: `palanca-ttl.test.ts` lee el informe y exige que
 * cada número coincida. Fracciones en [0, 1]; los mensajes no llevan dígitos.
 */
export const PALANCA_TTL = {
  /** Día del informe. */
  fecha: "2026-10-03",
  /** El informe del que sale todo (ruta desde la raíz del repo). */
  informe: "docs/benchmarks/2026-10-03/ttl.md",
  /** Neto sobre la factura, con su IC 95 % por sesión. */
  neto: { point: 0.0249, lower: 0.015, upper: 0.0357 },
  /** Nivel de confianza del intervalo. */
  confianza: 0.95,
  /** Sobre qué se midió. */
  sesiones: 51,
  peticiones: 19_779,
  dias: 13,

  // -------------------------------------------------------------------------
  // LO QUE AÑADE LA SECCIÓN PÚBLICA DE /benchmarks (#gateway-ttl).
  // La tarjeta de la portada enlaza a esa sección, que cuenta el informe entero:
  // el otro intervalo, el resultado, el desglose por modelo y los límites. Los
  // mismos números, con la misma verja. Lo que NO sale del informe a la web: el
  // contraste con producción (tablas, roles y cifras de clientes), los comandos
  // y las rutas de quien midió, y los dólares por modelo o por periodo.
  // -------------------------------------------------------------------------

  /** El otro IC 95 % del informe: remuestreando por DÍA. */
  netoPorDia: { lower: 0.0173, upper: 0.0482 },
  /** Remuestreos del bootstrap de los dos intervalos. */
  remuestreos: 10_000,
  /** La regla: se rebaja cuando lo nuevo es al menos esta fracción del cuerpo. */
  umbralNuevo: 0.3,
  /**
   * Los dólares del veredicto, a precio de lista: la factura simulada y el neto.
   * El bruto y el coste de los fallos se guardan para pintarlos como fracción
   * de la factura (la página no enseña más dólares que los del veredicto).
   */
  facturaUsd: 4563.61,
  netoUsd: 113.45,
  brutoUsd: 141.58,
  costeFallosUsd: 28.14,
  /** Rebajas aplicadas y fallos de caché que provocaron. */
  rebajas: 2583,
  fallos: 124,
  /** La prima de la hora sobre la factura: el techo de cualquier política de TTL. */
  techo: 0.072,
  /** La variante conservadora del modelo de caché: su neto y los fallos que añade. */
  conservadora: { neto: 0.0248, fallosDeMas: 3 },
  /**
   * Por modelo, en el orden del informe. `neto` es la fracción de la factura de
   * ese modelo; `null` donde el informe no da porcentaje (n = 5).
   */
  porModelo: [
    { modelo: "claude-fable-5", peticiones: 1921, rebajas: 23, fallos: 1, neto: 0.0464 },
    { modelo: "claude-fable-5-1", peticiones: 2236, rebajas: 25, fallos: 0, neto: 0.0165 },
    { modelo: "claude-opus-5", peticiones: 8344, rebajas: 70, fallos: 2, neto: 0.0161 },
    { modelo: "claude-opus-4-8", peticiones: 1193, rebajas: 34, fallos: 0, neto: 0.0649 },
    { modelo: "claude-sonnet-5", peticiones: 6080, rebajas: 2427, fallos: 121, neto: 0.0134 },
    { modelo: "claude-haiku-4-5", peticiones: 5, rebajas: 4, fallos: 0, neto: null },
  ],
  /**
   * El caso feo, que se enseña: casi todas las rebajas y casi todos los fallos,
   * un neto casi nulo y, en el primer periodo de la captura, pérdida.
   */
  casoFeo: { modelo: "claude-sonnet-5", cuotaRebajas: 0.94, cuotaFallos: 0.98, netoPrimerPeriodo: -0.094 },
  /**
   * La línea base RECONSTRUIDA: las peticiones grabadas con la rebaja ya activa
   * (los periodos P2 y P3 del informe). Son la mayoría, y la sección lo dice.
   */
  reconstruidas: { peticiones: 15_593 },
  /** El único tramo con línea base firme (P1), solo: su IC 95 % por sesión, mucho más ancho. */
  primerPeriodo: { lower: 0.0029, upper: 0.0912 },
  /** Peticiones sin ninguna marca de una hora: fuera del alcance de la rebaja (el techo cambia con el cliente). */
  sinMarcaDeHora: 7_327,
  /** Versión del gateway desde la que producción resta los fallos (antes: bruto), y su fecha. */
  netoEnProduccionDesde: "0.5.1",
  netoEnProduccionFecha: "2026-10-03",
} as const;

export type PalancaTtl = typeof PALANCA_TTL;
