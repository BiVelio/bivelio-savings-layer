/**
 * EL INFORME DE «TU PROPIO BANCO», en puro: de los recuentos, el resumen exacto
 * y los pares a las cifras que pinta el panel. Sin red, sin React.
 *
 * Reglas (especificación, decisiones D9-D12):
 *   · TITULAR = el SUELO del IC 95 % de la fracción ahorrada, por bootstrap
 *     estratificado como el banco publicado — nunca la estimación puntual.
 *   · PESOS = la cuota de población de cada estrato (N_h), contada por el SDK.
 *     N_h = max(conteo del estrato, filas de muestra del estrato): toda fila de
 *     muestra es una petición elegible, así que un conteo perdido no la achica.
 *   · Un estrato entra en el titular con ≥ 10 pares; si no, se marca «aún sin
 *     pares suficientes» y baja la COBERTURA. Menos de 30 pares en total: no hay
 *     intervalo («reuniendo»).
 *   · PEOR CASO PARA LA CAPA (D10): cada copia valorada como si TODA su entrada
 *     se hubiera leído de caché (a la tarifa cacheada, o gratis sin ella). Es una
 *     cota con nombre propio, no una medición.
 *   · Nada de esto se factura ni se suma a ninguna cifra del extracto.
 */
import {
  bootstrapEstratificadoPonderado,
  bootstrapMediaCI,
  media,
  type CI,
  type EstratoPonderado,
} from "./bootstrap";
import { ESTRATOS, EXCLUSIONES, RESULTADOS, type Estrato, type Exclusion, type Resultado } from "./wire";

export const NIVEL = 0.95;
export const MIN_PARES = 30;
export const MIN_PARES_POR_ESTRATO = 10;
export const MAX_PARES_EN_INFORME = 20_000;
export const POR_CADA = 1000;

/** Una fila de `bvsala.verification_summary`, ya en números. */
export interface FilaDeResumen {
  outcome: string;
  stratum: string;
  samples: number;
  naiveCost: number;
  naiveTruncated: number;
  naiveContractMissed: number;
}

/** Un par `paired`, en números. */
export interface Par {
  stratum: string;
  naiveCost: number;
  optimizedCost: number;
  naiveInputTokens: number;
  naiveOutputTokens: number;
  cachedInputPer1k: number | null;
  outputPer1k: number;
}

export interface EstratoDelInforme {
  estrato: Estrato;
  elegibles: number;
  pares: number;
  mediaSinCapa: number | null;
  mediaConCapa: number | null;
  cubierto: boolean;
  /** Diferencia media (sin capa − con capa) por petición, con su IC; solo si está cubierto. */
  diferencia?: CI;
}

export interface InformeDelBancoPropio {
  estado: "sin_datos" | "reuniendo" | "listo";
  paresTotales: number;
  paresUsados: number;
  submuestreado: boolean;
  elegibles: number;
  cobertura: number;
  tasaLograda: number;
  remuestreos: number;
  semilla: number;
  titular?: { fraccion: CI; diferencia: CI };
  peorCaso?: { fraccion: CI };
  estratos: EstratoDelInforme[];
  exclusiones: Array<{ motivo: Exclusion; peticiones: number }>;
  resultados: Array<{ resultado: Exclude<Resultado, "paired">; muestras: number }>;
  calidad: { truncadas: number; incumplidas: number };
  coste: { usd: number; copias: number; sinCoste: number };
}

/** `min(10 000, max(1 000, ⌊4·10⁷ / n⌋))`: el trabajo del bootstrap acotado con muchos pares. */
export function remuestreosPara(n: number): number {
  if (n <= 0) return 1000;
  return Math.min(10_000, Math.max(1_000, Math.floor(4e7 / n)));
}

/** El coste de la copia en el peor caso para la capa: toda su entrada leída de caché. */
export function costePeorCaso(p: Par): number {
  const conCache = (p.naiveInputTokens / 1000) * (p.cachedInputPer1k ?? 0) + (p.naiveOutputTokens / 1000) * p.outputPer1k;
  return Math.min(p.naiveCost, conCache);
}

export function informeDelBancoPropio(e: {
  conteos: Partial<Record<string, number>>;
  resumen: readonly FilaDeResumen[];
  pares: readonly Par[];
  totalPares: number;
  semilla: number;
  /** Solo tests: fija los remuestreos en vez de la fórmula. */
  remuestreos?: number;
}): InformeDelBancoPropio {
  const conteo = (k: string) => Math.max(0, Number(e.conteos[k] ?? 0));
  const filasDelEstrato = (h: string) => e.resumen.filter((f) => f.stratum === h).reduce((n, f) => n + f.samples, 0);
  const filasTotales = e.resumen.reduce((n, f) => n + f.samples, 0);
  const pairedDelResumen = e.resumen.filter((f) => f.outcome === "paired").reduce((n, f) => n + f.samples, 0);
  const paresTotales = Math.max(e.totalPares, pairedDelResumen);

  const N: Record<string, number> = {};
  for (const h of ESTRATOS) N[h] = Math.max(conteo(h), filasDelEstrato(h));
  const elegibles = ESTRATOS.reduce((n, h) => n + N[h]!, 0);

  const porEstrato = new Map<string, Par[]>();
  for (const p of e.pares) {
    if (!porEstrato.has(p.stratum)) porEstrato.set(p.stratum, []);
    porEstrato.get(p.stratum)!.push(p);
  }
  const cubiertos = ESTRATOS.filter((h) => (porEstrato.get(h)?.length ?? 0) >= MIN_PARES_POR_ESTRATO && N[h]! > 0);
  const nCubiertos = cubiertos.reduce((n, h) => n + porEstrato.get(h)!.length, 0);
  const cobertura = elegibles > 0 ? cubiertos.reduce((n, h) => n + N[h]!, 0) / elegibles : 0;
  const remuestreos = e.remuestreos ?? remuestreosPara(nCubiertos);
  // 0,05 exacto (1 − 0,95 en coma flotante no lo es).
  const alfa = Math.round((1 - NIVEL) * 1e6) / 1e6;

  const exclusiones = EXCLUSIONES.map((motivo) => ({ motivo, peticiones: conteo(motivo) })).filter((x) => x.peticiones > 0);
  const resultados = RESULTADOS.filter((r): r is Exclude<Resultado, "paired"> => r !== "paired")
    .map((resultado) => ({
      resultado,
      muestras: e.resumen.filter((f) => f.outcome === resultado).reduce((n, f) => n + f.samples, 0),
    }))
    .filter((x) => x.muestras > 0);
  const deResultado = (r: string) => e.resumen.filter((f) => f.outcome === r);
  const calidad = {
    truncadas: deResultado("paired").reduce((n, f) => n + f.naiveTruncated, 0),
    incumplidas: deResultado("paired").reduce((n, f) => n + f.naiveContractMissed, 0),
  };
  const coste = {
    usd: e.resumen.reduce((n, f) => n + f.naiveCost, 0),
    copias: pairedDelResumen,
    sinCoste: [...deResultado("check_unmeasured"), ...deResultado("abandoned")].reduce((n, f) => n + f.samples, 0),
  };

  const estratos: EstratoDelInforme[] = ESTRATOS.map((h, i) => {
    const ps = porEstrato.get(h) ?? [];
    const cubierto = cubiertos.includes(h);
    return {
      estrato: h,
      elegibles: N[h]!,
      pares: ps.length,
      mediaSinCapa: ps.length ? media(ps.map((p) => p.naiveCost)) : null,
      mediaConCapa: ps.length ? media(ps.map((p) => p.optimizedCost)) : null,
      cubierto,
      ...(cubierto
        ? {
            diferencia: bootstrapMediaCI(
              ps.map((p) => p.naiveCost - p.optimizedCost),
              { remuestreos, alfa, semilla: e.semilla + i + 1 },
            ),
          }
        : {}),
    };
  });

  const sumaConteos = [...ESTRATOS, ...EXCLUSIONES].reduce((n, k) => n + conteo(k), 0);
  const estado: InformeDelBancoPropio["estado"] =
    sumaConteos === 0 && filasTotales === 0
      ? "sin_datos"
      : paresTotales < MIN_PARES || cubiertos.length === 0
        ? "reuniendo"
        : "listo";

  const base: InformeDelBancoPropio = {
    estado,
    paresTotales,
    paresUsados: e.pares.length,
    submuestreado: e.totalPares > e.pares.length,
    elegibles,
    cobertura,
    tasaLograda: elegibles > 0 ? filasTotales / elegibles : 0,
    remuestreos,
    semilla: e.semilla,
    estratos,
    exclusiones,
    resultados,
    calidad,
    coste,
  };
  if (estado !== "listo") return base;

  const tal: EstratoPonderado[] = cubiertos.map((h) => ({
    peso: N[h]!,
    a: porEstrato.get(h)!.map((p) => p.naiveCost),
    b: porEstrato.get(h)!.map((p) => p.optimizedCost),
  }));
  const peor: EstratoPonderado[] = cubiertos.map((h) => ({
    peso: N[h]!,
    a: porEstrato.get(h)!.map(costePeorCaso),
    b: porEstrato.get(h)!.map((p) => p.optimizedCost),
  }));
  const o = { remuestreos, alfa, semilla: e.semilla };
  const titular = bootstrapEstratificadoPonderado(tal, o);
  const p = bootstrapEstratificadoPonderado(peor, o).fraccion;
  // El peor caso NUNCA por encima de lo medido. Por construcción ya lo está
  // (cada copia vale ≤ y los remuestreos son los mismos), salvo en un borde: si
  // la copia en el peor caso sale gratis entera (Σ = 0), la convención del banco
  // da fracción 0 y eso podría quedar por ENCIMA de un titular negativo. Se
  // acota: ante la duda, el suelo más bajo.
  const peorCaso = {
    fraccion: {
      point: Math.min(p.point, titular.fraccion.point),
      lower: Math.min(p.lower, titular.fraccion.lower),
      upper: Math.min(p.upper, titular.fraccion.upper),
    },
  };
  return { ...base, titular, peorCaso };
}
