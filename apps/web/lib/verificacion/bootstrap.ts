/**
 * EL BOOTSTRAP DE «TU PROPIO BANCO», en puro. Port de `benchmarks/stats.ts`
 * (mulberry32, el percentil, la media y el recorrido de
 * `bootstrapRatioCIEstratificado`), para que la web no importe del banco.
 *
 * La diferencia con el banco publicado es UNA y está en los pesos: el banco
 * pondera todos sus escenarios por igual porque los eligió a mano; con tráfico
 * real, un estrato raro con pesos iguales dominaría la cifra (el lado
 * halagüeño). Aquí cada estrato pesa su cuota de población N_h/N, contada por
 * el SDK. Con todos los pesos a 1 el resultado es, BIT A BIT, el del banco
 * (test/verificacion-bootstrap.test.ts).
 */

export interface CI {
  point: number;
  lower: number;
  upper: number;
}

/** Un estrato con su peso. `a` = coste de la copia sin capa, `b` = coste optimizado, pareados por índice. */
export interface EstratoPonderado {
  peso: number;
  a: number[];
  b: number[];
}

export interface OpcionesDeBootstrap {
  remuestreos: number;
  /** Error a dos colas: 0,05 → IC del 95 %. */
  alfa: number;
  semilla: number;
}

/** PRNG determinista (mulberry32), igual que el del banco. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function media(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function suma(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function percentil(ordenados: number[], p: number): number {
  if (ordenados.length === 0) return 0;
  const idx = Math.min(ordenados.length - 1, Math.max(0, Math.floor(p * (ordenados.length - 1))));
  return ordenados[idx]!;
}

const fraccion = (aSum: number, bSum: number): number => (aSum <= 0 ? 0 : 1 - bSum / aSum);

/**
 * Bootstrap percentil ESTRATIFICADO Y PONDERADO de la fracción ahorrada
 *   f = 1 − Σ_h w_h·media(b_h) / Σ_h w_h·media(a_h)
 * y de la diferencia media por petición
 *   d = Σ_h w_h·(media(a_h) − media(b_h)) / Σ_h w_h.
 *
 * Se remuestrea DENTRO de cada estrato (n_h tiradas con reemplazo de sus
 * propios n_h pares), recorriéndolos en orden, igual que el banco: el peso de
 * un estrato no cambia entre remuestreos.
 */
export function bootstrapEstratificadoPonderado(
  estratos: readonly EstratoPonderado[],
  o: OpcionesDeBootstrap,
): { fraccion: CI; diferencia: CI } {
  const vivos = estratos
    .map((e) => {
      const n = Math.min(e.a.length, e.b.length);
      return { n, peso: e.peso, a: e.a.slice(0, n), b: e.b.slice(0, n) };
    })
    .filter((e) => e.n >= 1 && e.peso > 0);
  if (vivos.length === 0) {
    const cero = { point: 0, lower: 0, upper: 0 };
    return { fraccion: cero, diferencia: cero };
  }
  let W = 0;
  let aW = 0;
  let bW = 0;
  for (const e of vivos) {
    W += e.peso;
    aW += e.peso * (suma(e.a) / e.n);
    bW += e.peso * (suma(e.b) / e.n);
  }
  const fPunto = fraccion(aW, bW);
  const dPunto = (aW - bW) / W;
  if (!vivos.some((e) => e.n >= 2)) {
    return {
      fraccion: { point: fPunto, lower: fPunto, upper: fPunto },
      diferencia: { point: dPunto, lower: dPunto, upper: dPunto },
    };
  }

  const rng = mulberry32(o.semilla);
  const fs: number[] = new Array(o.remuestreos);
  const ds: number[] = new Array(o.remuestreos);
  for (let r = 0; r < o.remuestreos; r++) {
    let aTot = 0;
    let bTot = 0;
    for (const e of vivos) {
      let aSum = 0;
      let bSum = 0;
      for (let i = 0; i < e.n; i++) {
        const j = (rng() * e.n) | 0;
        aSum += e.a[j]!;
        bSum += e.b[j]!;
      }
      aTot += e.peso * (aSum / e.n);
      bTot += e.peso * (bSum / e.n);
    }
    fs[r] = fraccion(aTot, bTot);
    ds[r] = (aTot - bTot) / W;
  }
  fs.sort((x, y) => x - y);
  ds.sort((x, y) => x - y);
  return {
    fraccion: { point: fPunto, lower: percentil(fs, o.alfa / 2), upper: percentil(fs, 1 - o.alfa / 2) },
    diferencia: { point: dPunto, lower: percentil(ds, o.alfa / 2), upper: percentil(ds, 1 - o.alfa / 2) },
  };
}

/** Bootstrap percentil de la media de una muestra (port de `bootstrapMeanCI`), para el IC por estrato. */
export function bootstrapMediaCI(d: readonly number[], o: OpcionesDeBootstrap): CI {
  const n = d.length;
  const point = media(d);
  if (n < 2) return { point, lower: point, upper: point };
  const rng = mulberry32(o.semilla);
  const medias: number[] = new Array(o.remuestreos);
  for (let r = 0; r < o.remuestreos; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[(rng() * n) | 0]!;
    medias[r] = s / n;
  }
  medias.sort((x, y) => x - y);
  return { point, lower: percentil(medias, o.alfa / 2), upper: percentil(medias, 1 - o.alfa / 2) };
}
