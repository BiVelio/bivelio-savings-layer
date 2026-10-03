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
} as const;
