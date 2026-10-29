/**
 * LAS CUENTAS DEL BANCO GSM8K — puras, sin red: de los ensayos al resumen.
 *
 * Doctrina (la de `benchmarks/README.md`, sección A/B):
 *   · MEDIDO es lo que sale del `usage` del proveedor en los dos brazos, al
 *     precio de lista del catálogo del SDK. Es la única cifra de ahorro de aquí.
 *   · Lo que la capa DICE que ahorró (su `SavingsReport`, por base `reference` /
 *     `measured` / `estimated`) se publica aparte y nunca se suma a lo medido.
 *   · Los intervalos se remuestrean por FAMILIA (un problema con sus repeticiones
 *     y paráfrasis), porque dentro de una familia los ensayos no son
 *     independientes: una repetición servida de caché copia a su original.
 */
import { bootstrapProporcionPorGrupos, bootstrapRatioCI, type CI } from "../../stats.js";
import type { MuestraLatenciaF1 } from "../../b2/latencia.js";
import { esErrorNoMedibleDelProveedor } from "../cuota.js";
import { CLASES, CLASES_CON_ORO, CLASES_VARIANTE, type ClaseDePeticion } from "./flujo.js";

export type Brazo = "A" | "B" | "S" | "E";
export const DESCRIPCION_DE_BRAZOS: Record<Brazo, string> = {
  A: "directo al proveedor (sin capa), mismo prompt, mismo tope de salida (maxOutputTokens 1024) y mismo muestreo",
  B: "a través de la capa 0.4.31 con la configuración por defecto del README (caché exacta, resolvers, colocación fija de la caché de prefijo) y SavingsRequest.maxOutputTokens 1024",
  S: "B + caché semántica CALIBRADA (InMemorySemanticCache({ calibration: { maxErrorRate: 0.02, judge: misma cifra final } })), encendida con createSavingsLayer({ semanticCacheStore, semanticCacheDefault: true })",
  E: "B + caché semántica TAL COMO SE ENVÍA (new InMemorySemanticCache() con sus umbrales por defecto), encendida con createSavingsLayer({ semanticCacheStore, semanticCacheDefault: true })",
};

export interface Ensayo {
  pos: number;
  familia: number;
  clase: ClaseDePeticion;
  oro: number | null;
  /** Hash corto del texto preguntado: dos peticiones con el mismo texto tienen el mismo. */
  huella: string;
  brazo: Brazo;
  numero: number | null;
  correcto: boolean | null;
  /** Dólares al precio de lista, desde el `usage` de TODAS las llamadas que hizo el brazo para esta petición. */
  coste: number;
  llamadas: number;
  /** Peticiones al proveedor, respondidas o no (un 429 cuenta); los artefactos de antes no lo traen. */
  peticiones?: number;
  entrada: number;
  cacheada: number;
  escrita: number;
  salida: number;
  latenciaMs: number;
  /** Campo legacy: tiempo anidado de proveedor; 0 cuando la respuesta salió sin llamada. */
  proveedorMs?: number;
  /** Evidencia B2-F1; opcional solo al releer artefactos F0 o anteriores. */
  latency?: MuestraLatenciaF1;
  /** De dónde salió la respuesta: `provider`, `exact_cache`, `semantic_cache`, `coalesced`, `deterministic`. */
  fuente: string;
  /** Solo en los brazos con capa: lo que dice su informe. */
  base?: string;
  lineaBaseCapa?: number;
  realCapa?: number;
  similitud?: number;
  comprimidos?: number;
  finishReason?: string;
  error?: string;
}

function percentil(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i]!;
}

export interface ResumenDeBrazo {
  peticiones: number;
  errores: number;
  exactitud: { aciertos: number; n: number; ic95: CI | null };
  exactitudPorClase: Partial<Record<ClaseDePeticion, { aciertos: number; n: number }>>;
  costeUsd: number;
  llamadasAlProveedor: number;
  fuentes: Record<string, number>;
  tokens: { entrada: number; cacheada: number; escrita: number; salida: number; comprimidos: number };
  /** Fracción de la entrada que el proveedor leyó de su caché de prefijo. */
  fraccionEntradaCacheada: number;
  latenciaMs: { p50: number | null; p95: number | null; p50Proveedor: number | null; p50Cache: number | null };
  /** Solo brazos con capa: el ahorro que la capa se atribuye, por base. Declarado, no medido por el banco. */
  ahorroDeclaradoPorBase?: Record<string, { peticiones: number; usd: number }>;
  truncadas: number;
}

export interface Comparacion {
  brazo: Brazo;
  /** B − A en exactitud, remuestreado por familia. */
  diferenciaExactitud: CI | null;
  /** 1 − coste(brazo)/coste(A), MEDIDO, remuestreado por familia. */
  ahorroMedido: CI;
  costeA: number;
  costeBrazo: number;
}

export interface Hallazgo {
  brazo: Brazo;
  pos: number;
  familia: number;
  clase: ClaseDePeticion;
  fuente: string;
  similitud?: number;
  numeroServido: number | null;
  numeroA: number | null;
  numeroDelOriginal: number | null;
}

export interface Resumen {
  brazos: Partial<Record<Brazo, ResumenDeBrazo>>;
  comparaciones: Comparacion[];
  /**
   * Variantes (otra respuesta) servidas de caché sin que antes se hubiera
   * preguntado ese mismo texto: la respuesta es, por construcción, la de OTRA
   * pregunta. Cada una es un hallazgo grave.
   */
  variantesServidasDeOtra: Hallazgo[];
  variantesPorBrazo: Partial<Record<Brazo, { n: number; deCache: number; deOtra: number }>>;
}

export function resumir(ensayos: readonly Ensayo[]): Resumen {
  const brazos = [...new Set(ensayos.map((e) => e.brazo))].sort() as Brazo[];
  const porBrazo = (b: Brazo) => ensayos.filter((e) => e.brazo === b).sort((x, y) => x.pos - y.pos);
  const out: Resumen = { brazos: {}, comparaciones: [], variantesServidasDeOtra: [], variantesPorBrazo: {} };

  for (const b of brazos) {
    const es = porBrazo(b);
    const conOro = es.filter((e) => CLASES_CON_ORO.includes(e.clase) && e.correcto !== null);
    const grupos = new Map<number, { num: number; den: number }>();
    for (const e of conOro) {
      const g = grupos.get(e.familia) ?? { num: 0, den: 0 };
      g.num += e.correcto ? 1 : 0;
      g.den += 1;
      grupos.set(e.familia, g);
    }
    const porClase: ResumenDeBrazo["exactitudPorClase"] = {};
    for (const c of CLASES) {
      const xs = es.filter((e) => e.clase === c && e.correcto !== null);
      if (xs.length && CLASES_CON_ORO.includes(c)) porClase[c] = { aciertos: xs.filter((e) => e.correcto).length, n: xs.length };
    }
    const fuentes: Record<string, number> = {};
    for (const e of es) fuentes[e.fuente] = (fuentes[e.fuente] ?? 0) + 1;
    const suma = (f: (e: Ensayo) => number) => es.reduce((s, e) => s + f(e), 0);
    const entrada = suma((e) => e.entrada);
    const cacheada = suma((e) => e.cacheada);
    const resumen: ResumenDeBrazo = {
      peticiones: es.length,
      errores: es.filter((e) => e.error).length,
      exactitud: {
        aciertos: conOro.filter((e) => e.correcto).length,
        n: conOro.length,
        ic95: bootstrapProporcionPorGrupos([...grupos.values()], { seed: 0x65a8 }),
      },
      exactitudPorClase: porClase,
      costeUsd: suma((e) => e.coste),
      llamadasAlProveedor: suma((e) => e.llamadas),
      fuentes,
      tokens: { entrada, cacheada, escrita: suma((e) => e.escrita), salida: suma((e) => e.salida), comprimidos: suma((e) => e.comprimidos ?? 0) },
      fraccionEntradaCacheada: entrada > 0 ? cacheada / entrada : 0,
      latenciaMs: {
        p50: percentil(es.map((e) => e.latenciaMs), 0.5),
        p95: percentil(es.map((e) => e.latenciaMs), 0.95),
        p50Proveedor: percentil(es.filter((e) => e.fuente === "provider").map((e) => e.latenciaMs), 0.5),
        p50Cache: percentil(es.filter((e) => e.fuente !== "provider").map((e) => e.latenciaMs), 0.5),
      },
      truncadas: es.filter((e) => e.finishReason === "length").length,
    };
    if (b !== "A") {
      const porBase: Record<string, { peticiones: number; usd: number }> = {};
      for (const e of es) {
        if (e.base === undefined) continue;
        const f = (porBase[e.base] ??= { peticiones: 0, usd: 0 });
        f.peticiones++;
        f.usd += (e.lineaBaseCapa ?? 0) - (e.realCapa ?? 0);
      }
      resumen.ahorroDeclaradoPorBase = porBase;
    }
    out.brazos[b] = resumen;
  }

  // Comparaciones pareadas contra A, por familia.
  const A = porBrazo("A");
  if (A.length) {
    const aPorPos = new Map(A.map((e) => [e.pos, e]));
    for (const b of brazos.filter((x) => x !== "A")) {
      // Una posición con un 429 por cuota (run 36786990486) o un 529 por
      // sobrecarga (run 36998187601) del proveedor en A o en este brazo no se
      // compara en ninguno de los dos: su `correcto: false` sería de la clave o
      // del proveedor en ese minuto, no del modelo ni de la capa (../cuota.ts).
      const es = porBrazo(b).filter(
        (e) => aPorPos.has(e.pos) && !esErrorNoMedibleDelProveedor(e.error) && !esErrorNoMedibleDelProveedor(aPorPos.get(e.pos)!.error),
      );
      const fam = new Map<number, { a: number; b: number; num: number; den: number }>();
      for (const e of es) {
        const a = aPorPos.get(e.pos)!;
        const f = fam.get(e.familia) ?? { a: 0, b: 0, num: 0, den: 0 };
        f.a += a.coste;
        f.b += e.coste;
        if (CLASES_CON_ORO.includes(e.clase) && e.correcto !== null && a.correcto !== null) {
          f.num += (e.correcto ? 1 : 0) - (a.correcto ? 1 : 0);
          f.den += 1;
        }
        fam.set(e.familia, f);
      }
      const fs = [...fam.values()];
      out.comparaciones.push({
        brazo: b,
        diferenciaExactitud: bootstrapProporcionPorGrupos(
          fs.map((f) => ({ num: f.num, den: f.den })),
          { seed: 0xd1f },
        ),
        ahorroMedido: bootstrapRatioCI(
          fs.map((f) => f.a),
          fs.map((f) => f.b),
          { seed: 0xa11 },
        ),
        costeA: fs.reduce((s, f) => s + f.a, 0),
        costeBrazo: fs.reduce((s, f) => s + f.b, 0),
      });
    }
  }

  // Seguridad: variantes servidas de caché sin que su texto se hubiera preguntado antes.
  for (const b of brazos.filter((x) => x !== "A")) {
    const es = porBrazo(b);
    const vistos = new Set<string>();
    const numeroDelOriginal = new Map<number, number | null>();
    for (const e of es) if (e.clase === "original") numeroDelOriginal.set(e.familia, e.numero);
    let n = 0;
    let deCache = 0;
    let deOtra = 0;
    for (const e of es) {
      if (CLASES_VARIANTE.includes(e.clase)) {
        n++;
        if (e.fuente !== "provider") {
          deCache++;
          if (!vistos.has(e.huella)) {
            deOtra++;
            out.variantesServidasDeOtra.push({
              brazo: b,
              pos: e.pos,
              familia: e.familia,
              clase: e.clase,
              fuente: e.fuente,
              ...(e.similitud !== undefined ? { similitud: e.similitud } : {}),
              numeroServido: e.numero,
              numeroA: aPorPos(A, e.pos)?.numero ?? null,
              numeroDelOriginal: numeroDelOriginal.get(e.familia) ?? null,
            });
          }
        }
      }
      vistos.add(e.huella);
    }
    out.variantesPorBrazo[b] = { n, deCache, deOtra };
  }
  return out;
}

function aPorPos(A: readonly Ensayo[], pos: number): Ensayo | undefined {
  return A.find((e) => e.pos === pos);
}

/** Precio de lista que necesita el desglose (el del catálogo del SDK, vía `precioYPrima`). */
export interface PrecioDelDesglose {
  inputPer1k: number;
  cachedInputPer1k: number;
  /** Multiplicador de la escritura de caché sobre la entrada (1,25 en Anthropic a 5 min). */
  prima: number;
}

export interface DesgloseDeBrazo {
  brazo: Brazo;
  /** coste(A) − coste(brazo) en las posiciones que completaron los dos. MEDIDO. */
  ahorroTotalUsd: number;
  /** Lo que A pagó en las posiciones que el brazo sirvió SIN llamar (caché exacta, semántica…). MEDIDO. */
  ahorroPorNoLlamarUsd: number;
  /** El resto: posiciones en que el brazo sí llamó (caché de prefijo del proveedor + ruido de la salida). MEDIDO. */
  ahorroEnLlamadasUsd: number;
  /**
   * La parte de la caché de prefijo, a precio de lista y SOLO desde tokens:
   * lecturas × (entrada − lectura) − escrituras × entrada × (prima − 1). Sin
   * ruido de salida; es la cifra que responde «cuánto vale la caché de prefijo».
   */
  prefijoNetoUsd: number;
  llamadas: number;
  llamadasConLectura: number;
  llamadasConEscritura: number;
  tokensLeidos: number;
  tokensEscritos: number;
  /** Entrada media por llamada, para ver si el prefijo supera el mínimo cacheable del modelo. */
  entradaMediaPorLlamada: number;
}

/**
 * DE DÓNDE SALE EL AHORRO de cada brazo frente a A: lo que no llamó (caché de la
 * capa) y lo que ahorró en las llamadas que sí hizo (caché de prefijo). Puro.
 */
export function desgloseDelAhorro(ensayos: readonly Ensayo[], precio: PrecioDelDesglose): DesgloseDeBrazo[] {
  const A = new Map(ensayos.filter((e) => e.brazo === "A").map((e) => [e.pos, e]));
  const brazos = [...new Set(ensayos.map((e) => e.brazo))].sort() as Brazo[];
  return brazos.map((b) => {
    const es = ensayos.filter((e) => e.brazo === b);
    const pareados = es.filter((e) => A.has(e.pos));
    let total = 0;
    let noLlamar = 0;
    for (const e of pareados) {
      const a = A.get(e.pos)!;
      total += a.coste - e.coste;
      if (e.llamadas === 0) noLlamar += a.coste - e.coste;
    }
    const leidos = es.reduce((s, e) => s + e.cacheada, 0);
    const escritos = es.reduce((s, e) => s + e.escrita, 0);
    const llamadas = es.reduce((s, e) => s + e.llamadas, 0);
    return {
      brazo: b,
      ahorroTotalUsd: b === "A" ? 0 : total,
      ahorroPorNoLlamarUsd: b === "A" ? 0 : noLlamar,
      ahorroEnLlamadasUsd: b === "A" ? 0 : total - noLlamar,
      prefijoNetoUsd:
        (leidos / 1000) * (precio.inputPer1k - precio.cachedInputPer1k) - (escritos / 1000) * precio.inputPer1k * (precio.prima - 1),
      llamadas,
      llamadasConLectura: es.filter((e) => e.cacheada > 0).length,
      llamadasConEscritura: es.filter((e) => e.escrita > 0).length,
      tokensLeidos: leidos,
      tokensEscritos: escritos,
      entradaMediaPorLlamada: llamadas ? es.reduce((s, e) => s + e.entrada, 0) / llamadas : 0,
    };
  });
}
