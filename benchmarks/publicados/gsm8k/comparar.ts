/**
 * 0.4.30 → 0.4.31: LA MISMA TIRADA, OTRA VERSIÓN. Puro, sin red.
 *
 * El flujo es determinista dada la semilla y el número de únicos (`flujo.ts`),
 * así que con los mismos únicos por modelo las dos tiradas preguntan lo mismo en
 * el mismo orden. Esto lo COMPRUEBA (la huella de cada petición, posición a
 * posición) antes de comparar nada, y compara solo las posiciones que las dos
 * tiradas completaron: si la nueva se cortó por la caja, la vieja se recorta al
 * mismo prefijo y las dos cuentas salen de `resumir`, la misma función.
 *
 * Lo que cambia entre las dos tiradas además de la versión, y el documento lo
 * dice: el tope de salida (ninguno → 1024, que no habría cortado ninguna
 * respuesta de la 0.4.30) y el mecanismo que enciende la caché semántica
 * (`savings.semanticCache` por petición → `semanticCacheDefault` en la capa).
 */
import { resumir, type Brazo, type Ensayo, type Resumen } from "./medir.js";

export interface ArtefactoComparable {
  procedencia: { version: string };
  runId: string;
  modelos: { modelo: string; nUnicos?: number; ensayos?: Ensayo[]; gasto: { totalUsd: number } }[];
  sinRed?: { preguntas: number; resultados: { config: string; llamadasAlProveedor: number; peticiones: number; erroneas: number; porClase: Record<string, { semantica: number; exacta: number }> }[] };
}

export interface FilaComparada {
  brazo: Brazo;
  antes: CifrasDeBrazo;
  despues: CifrasDeBrazo;
}

export interface CifrasDeBrazo {
  aciertos: number;
  n: number;
  costeUsd: number;
  /** 1 − coste/coste(A), el punto del mismo cálculo que el resumen (MEDIDO). */
  ahorro: number | null;
  semanticas: number;
  exactas: number;
  variantes: number;
  variantesDeCache: number;
  /** Variantes servidas con la respuesta de OTRA pregunta: el fallo grave. */
  deOtra: number;
}

export interface ComparacionDeModelo {
  modelo: string;
  nUnicosAntes: number | null;
  nUnicosDespues: number | null;
  /** Posiciones completadas por las dos tiradas (prefijo común del mismo flujo). */
  posiciones: number;
  /** ¿Preguntaron las dos lo mismo en cada posición comparada? (huella del texto). */
  mismoFlujo: boolean;
  discrepancias: number;
  filas: FilaComparada[];
}

export interface ComparacionSinRed {
  config: string;
  antes: { llamadas: number; semantica: number; erroneas: number } | null;
  despues: { llamadas: number; semantica: number; erroneas: number } | null;
}

export interface Comparacion0430 {
  versionAntes: string;
  runAntes: string;
  versionDespues: string;
  modelos: ComparacionDeModelo[];
  sinRed: { preguntasAntes: number | null; preguntasDespues: number | null; filas: ComparacionSinRed[] };
}

function cifras(r: Resumen, b: Brazo): CifrasDeBrazo {
  const x = r.brazos[b]!;
  const c = r.comparaciones.find((k) => k.brazo === b);
  const v = r.variantesPorBrazo[b];
  return {
    aciertos: x.exactitud.aciertos,
    n: x.exactitud.n,
    costeUsd: x.costeUsd,
    ahorro: b === "A" ? null : (c?.ahorroMedido.point ?? null),
    semanticas: x.fuentes["semantic_cache"] ?? 0,
    exactas: x.fuentes["exact_cache"] ?? 0,
    variantes: v?.n ?? 0,
    variantesDeCache: v?.deCache ?? 0,
    deOtra: v?.deOtra ?? 0,
  };
}

export function compararModelo(modelo: string, antes: Ensayo[], despues: Ensayo[], nAntes: number | null, nDespues: number | null): ComparacionDeModelo {
  const posDespues = new Set(despues.map((e) => e.pos));
  const posAntes = new Set(antes.map((e) => e.pos));
  const comunes = [...posDespues].filter((p) => posAntes.has(p));
  const huellaA = (es: Ensayo[]) => new Map(es.filter((e) => e.brazo === "A").map((e) => [e.pos, e.huella]));
  const hA = huellaA(antes);
  const hD = huellaA(despues);
  const discrepancias = comunes.filter((p) => hA.get(p) !== hD.get(p)).length;
  const enComun = new Set(comunes);
  const rA = resumir(antes.filter((e) => enComun.has(e.pos)));
  const rD = resumir(despues.filter((e) => enComun.has(e.pos)));
  const brazos = (["A", "B", "S", "E"] as Brazo[]).filter((b) => rA.brazos[b] && rD.brazos[b]);
  return {
    modelo,
    nUnicosAntes: nAntes,
    nUnicosDespues: nDespues,
    posiciones: comunes.length,
    mismoFlujo: nAntes === nDespues && discrepancias === 0,
    discrepancias,
    filas: brazos.map((b) => ({ brazo: b, antes: cifras(rA, b), despues: cifras(rD, b) })),
  };
}

export function comparar(antes: ArtefactoComparable, despues: ArtefactoComparable): Comparacion0430 {
  const modelos: ComparacionDeModelo[] = [];
  for (const m of despues.modelos) {
    const v = antes.modelos.find((x) => x.modelo === m.modelo);
    if (!v?.ensayos?.length || !m.ensayos?.length) continue;
    modelos.push(compararModelo(m.modelo, v.ensayos, m.ensayos, v.nUnicos ?? null, m.nUnicos ?? null));
  }
  const sem = (r: NonNullable<ArtefactoComparable["sinRed"]>["resultados"][number] | undefined) =>
    r ? { llamadas: r.llamadasAlProveedor, semantica: Object.values(r.porClase).reduce((s, f) => s + f.semantica, 0), erroneas: r.erroneas } : null;
  const configs = [...new Set([...(antes.sinRed?.resultados ?? []), ...(despues.sinRed?.resultados ?? [])].map((r) => r.config))];
  return {
    versionAntes: antes.procedencia.version,
    runAntes: antes.runId,
    versionDespues: despues.procedencia.version,
    modelos,
    sinRed: {
      preguntasAntes: antes.sinRed?.preguntas ?? null,
      preguntasDespues: despues.sinRed?.preguntas ?? null,
      filas: configs.map((config) => ({
        config,
        antes: sem(antes.sinRed?.resultados.find((r) => r.config === config)),
        despues: sem(despues.sinRed?.resultados.find((r) => r.config === config)),
      })),
    },
  };
}
