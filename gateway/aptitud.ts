/**
 * LA VERJA POR MODELO de la elisión — qué modelos ganan con v0 y cuáles pierden.
 *
 * POR QUÉ EXISTE. v0 no rinde igual en todos los modelos, y en algunos CUESTA
 * dinero. Medido el 2026-09-07 por dos caminos independientes que coinciden:
 *
 *   · Replay del corpus (`pnpm sombra:corpus`, 7,8 GB, 4.232 turnos, 45 sesiones;
 *     artefacto benchmarks/out/sombra-corpus-2026-09-07.json):
 *         claude-fable-5    +27,4 %      claude-sonnet-5     0,0 %
 *         claude-opus-4-8    −3,6 %      claude-opus-5      −0,4 %
 *   · Carril sombra EN VIVO (bvsala.usage_daily, 2.288 peticiones): el 05-09,
 *     con un 72,7 % del coste en opus-4-8, el día entero dio −3,6 %. El mismo
 *     número que el replay predijo para ese modelo, por otro método.
 *
 * Sin verja, v0 sale a +18,15 % agregado pero con días de −28,3 %. Con verja,
 * los días negativos se neutralizan: ≈22 % y ninguna jornada en rojo.
 *
 * POR QUÉ NO ES UNA LISTA SUELTA. Este repositorio se ha quemado dos veces con
 * cifras tecleadas fuera de una fuente fechada: un script tarifó el corpus con
 * fable-5 al precio de Haiku ($279 en vez de $1.232,91), y PRIMA_1H/PRIMA_5M
 * multiplican cada euro de comisión desde fuera del catálogo y fuera del vigía.
 * Aquí cada entrada lleva su cifra, su fecha y su fuente, y una medición vieja
 * deja de valer sola.
 *
 * DOCTRINA DE LA DUDA. Un modelo del que no hay medición NO se elide. La
 * elisión actúa solo donde hay evidencia positiva y fresca; ante cualquier
 * duda —modelo desconocido, medición caducada, margen flojo— el tráfico pasa
 * intacto. Es la misma dirección segura que el resto del gateway: no ahorrar
 * de menos nunca cuesta credibilidad; ahorrar de más, sí.
 */

/** Una medición de aptitud, con su procedencia. Sin fuente no entra. */
export interface Aptitud {
  /** Ahorro de v0 sobre ese modelo, en tanto por ciento de su coste simulado. */
  pct: number;
  /** Día UTC de la medición (YYYY-MM-DD). */
  medidoEn: string;
  /** De dónde sale la cifra: artefacto, tabla o consulta. Verificable. */
  fuente: string;
}

/**
 * Margen mínimo para encender la elisión en un modelo. Un +0,5 % no compensa:
 * la política invalida prefijo de caché y ese coste ya está descontado en la
 * cifra, pero un margen tan fino se lo come cualquier deriva del tráfico.
 */
export const UMBRAL_APTITUD_PCT = 2;

/**
 * Una medición deja de valer a los 90 días. No es una fecha caprichosa: el
 * precio de lectura de caché de una familia cambió entre fable-5 y fable-5-1
 * (0,001 → 0,00025, catalogo.ts:94 frente a :101) y eso solo mueve la aptitud
 * de v0. Caducada, el modelo vuelve a «desconocido» y deja de elidirse.
 */
export const APTITUD_CADUCA_TRAS_DIAS = 90;

/**
 * LA TABLA. Solo modelos MEDIDOS. Un modelo que no está aquí no se elide.
 *
 * Para refrescarla: `pnpm sombra:corpus` y copiar `porModelo[<modelo>].v0.ahorroPct`
 * del artefacto, con su fecha y el nombre del fichero como fuente.
 */
export const APTITUD_V0: Readonly<Record<string, Aptitud>> = {
  "claude-fable-5": {
    pct: 27.4,
    medidoEn: "2026-09-07",
    fuente: "benchmarks/out/sombra-corpus-2026-09-07.json · porModelo · 1.068,65 → 776,12 USD",
  },
  "claude-opus-4-8": {
    pct: -3.6,
    medidoEn: "2026-09-07",
    fuente: "benchmarks/out/sombra-corpus-2026-09-07.json · porModelo · 233,08 → 241,43 USD",
  },
  "claude-opus-5": {
    pct: -0.4,
    medidoEn: "2026-09-07",
    fuente: "benchmarks/out/sombra-corpus-2026-09-07.json · porModelo · 29,40 → 29,52 USD",
  },
  "claude-sonnet-5": {
    pct: 0,
    medidoEn: "2026-09-07",
    fuente: "benchmarks/out/sombra-corpus-2026-09-07.json · porModelo · 46,64 → 46,64 USD",
  },
  "claude-haiku-4-5-20251001": {
    pct: 0,
    medidoEn: "2026-09-07",
    fuente: "benchmarks/out/sombra-corpus-2026-09-07.json · porModelo · 0,35 → 0,35 USD",
  },
};

/** Por qué un modelo no pasa la verja. Sirve para explicarlo en el log y en los tests. */
export type MotivoVerja = "apto" | "sin-medicion" | "medicion-caducada" | "margen-insuficiente" | "pierde-dinero";

export interface Veredicto {
  aplica: boolean;
  motivo: MotivoVerja;
  /** La medición usada, si había alguna. */
  aptitud?: Aptitud;
}

/**
 * ¿Se elide en este modelo? `hoyUtcIso` se pasa siempre (nada de relojes
 * escondidos: el llamante decide qué día es, y así el test es determinista).
 */
export function veredictoDeVerja(model: string, hoyUtcIso: string): Veredicto {
  const aptitud = APTITUD_V0[model];
  if (!aptitud) return { aplica: false, motivo: "sin-medicion" };

  if (diasEntre(aptitud.medidoEn, hoyUtcIso) > APTITUD_CADUCA_TRAS_DIAS) {
    return { aplica: false, motivo: "medicion-caducada", aptitud };
  }
  if (aptitud.pct < 0) return { aplica: false, motivo: "pierde-dinero", aptitud };
  if (aptitud.pct < UMBRAL_APTITUD_PCT) return { aplica: false, motivo: "margen-insuficiente", aptitud };
  return { aplica: true, motivo: "apto", aptitud };
}

/** Atajo para el camino caliente, donde el motivo no interesa. */
export function eliden(model: string, hoyUtcIso: string): boolean {
  return veredictoDeVerja(model, hoyUtcIso).aplica;
}

/** Días naturales entre dos fechas YYYY-MM-DD. Negativo si `hasta` es anterior. */
function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}
