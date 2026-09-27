import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  CalibrationStateError,
  EstadoDeCalibracion,
  escribirEstado,
  leerEstado,
  mulberry32,
  umbralDeIndice,
  type IdentidadDeCalibracion,
} from "../src/cache/calibracion.js";
import { calibrateSemanticFloor, type SemanticCalibrationState } from "../src/cache/calibration.js";
import { vectorLocal } from "../src/cache/embedder-local.js";
import { InMemorySemanticCache, type SemanticCacheOptions } from "../src/cache/semantic.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { CachedAnswer } from "../src/cache/exact.js";
import { reiniciarPorJson, simular } from "../benchmarks/cache-semantica/simulacion.js";

/**
 * EL ESTADO DE LA CALIBRACIÓN SOBREVIVE A UN REINICIO, Y LA GARANTÍA CON ÉL.
 *
 * En serverless (y en cada despliegue) el proceso muere y la calibración, que
 * vivía en memoria, volvía a empezar: miles de etiquetas de arranque en frío
 * pagadas otra vez. `exportCalibration` / `importCalibration` guardan el
 * experimento ENTERO. Lo que se fija aquí:
 *
 *   1. Reiniciar no cambia nada: con reinicios a intervalos al azar, los suelos
 *      salen idénticos, etiqueta a etiqueta, a los de no haber parado nunca. Y
 *      por eso la cota se cumple igual (Monte Carlo con verdad conocida).
 *   2. El gasto de α NO se puede reempezar: un estado con menos miradas de las
 *      que sus etiquetas ya gastaron se rechaza, y también uno que mueva
 *      etiquetas de la mitad retenida a la de selección.
 *   3. Un estado de otro embebedor, verificador, juez o configuración se
 *      rechaza con un error que dice qué campo no cuadra.
 */

const ID: IdentidadDeCalibracion = {
  embedder: "built_in:prueba",
  verifier: null,
  judge: "built_in:prueba",
  maxErrorRate: 0.05,
  confidence: 0.9,
  similarityThreshold: 0.6,
};

// Verdad conocida, la misma curva que `pnpm cache-semantica:simulacion`.
const qVerdad = (s: number) => 0.5 / (1 + Math.exp(40 * (s - 0.85)));
function tasaVerdadera(t: number): number {
  const a = Math.max(0.6, t);
  const pasos = 2000;
  let s = 0;
  for (let i = 0; i < pasos; i++) s += qVerdad(a + ((i + 0.5) * (1 - a)) / pasos);
  return s / pasos;
}

/** Un estado en línea alimentado con `n` etiquetas de la verdad conocida. */
function alimentado(n: number, semilla: number, delta = 0.05, alfa = 0.1): EstadoDeCalibracion {
  const e = new EstadoDeCalibracion(delta, alfa);
  const rng = mulberry32(semilla);
  for (let i = 0; i < n; i++) {
    const s = 0.6 + 0.4 * rng();
    e.anotar(s, rng() >= qVerdad(s));
  }
  return e;
}

const exportado = (e: EstadoDeCalibracion, id = ID) =>
  JSON.parse(JSON.stringify(escribirEstado(id, new Map([["single_shot", e]])))) as SemanticCalibrationState;

// ─── 1. Reiniciar no cambia nada, y la cota se cumple a través de reinicios ─────

describe("la garantía a través de reinicios (Monte Carlo con verdad conocida)", () => {
  // α = 0,10 para que un fallo del método se VEA en 300 tiradas (como en
  // cache-semantica-calibrada.test.ts): sin garantía rondaría o pasaría de 30.
  const DELTA = 0.05;
  const ALFA = 0.1;
  const TIRADAS = 300;

  it("con reinicios al azar (export → JSON → import), cada suelo es el de no haber parado nunca, y 0 tiradas incumplen la cota", () => {
    let conViolacion = 0;
    let certificadas = 0;
    let reinicios = 0;
    let divergencias = 0;
    for (let t = 0; t < TIRADAS; t++) {
      const rng = mulberry32(5000 + t);
      const cuando = mulberry32(90_000 + t);
      const sinParar = new EstadoDeCalibracion(DELTA, 1 - 0.9);
      let reiniciado = new EstadoDeCalibracion(DELTA, 1 - 0.9);
      // De 1 a 1.000 etiquetas entre reinicios: cae antes, en y después de las miradas.
      let siguiente = 1 + Math.floor(cuando() * 1000);
      let violo = false;
      let previo: number | null = null;
      for (let i = 0; i < 8000; i++) {
        const s = 0.6 + 0.4 * rng();
        const correcta = rng() >= qVerdad(s);
        sinParar.anotar(s, correcta);
        reiniciado.anotar(s, correcta);
        if (i + 1 === siguiente) {
          reiniciado = reiniciarPorJson(reiniciado, DELTA, ALFA);
          reinicios++;
          siguiente = i + 1 + 1 + Math.floor(cuando() * 1000);
        }
        if (reiniciado.suelo !== sinParar.suelo) divergencias++;
        const suelo = reiniciado.suelo;
        if (suelo != null && suelo !== previo && tasaVerdadera(umbralDeIndice(suelo)) > DELTA) violo = true;
        previo = suelo;
      }
      expect(reiniciado.resumen()).toEqual(sinParar.resumen());
      if (reiniciado.suelo != null) certificadas++;
      if (violo) conViolacion++;
    }
    expect(reinicios).toBeGreaterThan(TIRADAS * 10);
    expect(divergencias).toBe(0);
    // La cota formal es α·TIRADAS (con margen de muestreo); medido con estas
    // semillas, ninguna tirada la incumple, igual que sin reinicios.
    expect(conViolacion).toBeLessThanOrEqual(ALFA * TIRADAS + 3 * Math.sqrt(TIRADAS * ALFA * (1 - ALFA)));
    expect(conViolacion).toBe(0);
    expect(certificadas).toBeGreaterThan(TIRADAS * 0.85);
  });

  it("`pnpm cache-semantica:simulacion --reinicios` da lo mismo que sin reinicios (tirada corta)", () => {
    const sin = simular(0.05, 0.1, 20, 6000);
    const con = simular(0.05, 0.1, 20, 6000, 300);
    expect(con.reinicios!.total).toBeGreaterThan(20 * 5);
    expect(con.reinicios!.tiradasQueDivergieron).toBe(0);
    expect(con.enLinea).toEqual(sin.enLinea);
    expect(con.enLinea.tiradasConAlgunaViolacion).toBe(0);
  });

  it("un reinicio justo después de certificar conserva el suelo: se sigue sirviendo sin volver a calibrar", () => {
    const e = alimentado(6000, 11);
    expect(e.suelo).not.toBeNull();
    const r = reiniciarPorJson(e, 0.05, 0.1);
    expect(r.suelo).toBe(e.suelo);
    expect(r.resumen()).toEqual(e.resumen());
  });
});

// ─── 2. El gasto de α y la mitad retenida no se pueden reempezar ─────────────

describe("un estado que reempezaría el gasto de α se rechaza", () => {
  const e = alimentado(6000, 11);

  it("menos miradas de las que las etiquetas ya gastaron → error que lo explica", () => {
    const s = exportado(e);
    expect(s.segments.single_shot!.looks).toBeGreaterThan(1);
    s.segments.single_shot!.looks = 0;
    expect(() => leerEstado(s, ID)).toThrow(CalibrationStateError);
    expect(() => leerEstado(s, ID)).toThrow(/already spent \d+ tests of the confidence budget/);
  });

  it("menos etiquetas de las que hay en las mitades (para volver a la primera mirada) → error", () => {
    const s = exportado(e);
    s.segments.single_shot!.labeled = 10;
    s.segments.single_shot!.looks = 0;
    expect(() => leerEstado(s, ID)).toThrow(/split by arrival order/);
  });

  it("etiquetas movidas de la mitad retenida a la de selección → error", () => {
    const s = exportado(e);
    const seg = s.segments.single_shot!;
    const fila = seg.heldOut.pop()!;
    const misma = seg.selection.find((f) => f[0] === fila[0]);
    if (misma) {
      misma[1] += fila[1];
      misma[2] += fila[2];
    } else {
      seg.selection.push(fila);
      seg.selection.sort((a, b) => a[0] - b[0]);
    }
    expect(() => leerEstado(s, ID)).toThrow(/split by arrival order/);
  });

  it("un certificado que no pasa su propio test, o con más retenidas de las que había → error", () => {
    const a = exportado(e);
    a.segments.single_shot!.certified!.wrong = a.segments.single_shot!.certified!.heldOut;
    expect(() => leerEstado(a, ID)).toThrow(CalibrationStateError);
    const b = exportado(e);
    b.segments.single_shot!.certified!.heldOut += 1_000_000;
    expect(() => leerEstado(b, ID)).toThrow(/more held-out labels than there were/);
    const c = exportado(e);
    c.segments.single_shot!.previousCandidate = null;
    expect(() => leerEstado(c, ID)).toThrow(/previousCandidate/);
  });

  it("histogramas mal formados → error, nunca un estado a medias", () => {
    for (const romper of [
      (s: SemanticCalibrationState) => void (s.segments.single_shot!.selection[0]![2] = 1e9),
      (s: SemanticCalibrationState) => void (s.segments.single_shot!.selection[0]![0] = 1001),
      (s: SemanticCalibrationState) => void s.segments.single_shot!.selection.reverse(),
      (s: SemanticCalibrationState) => void ((s.segments.single_shot as unknown as Record<string, unknown>)["heldOut"] = "x"),
    ]) {
      const s = exportado(e);
      romper(s);
      expect(() => leerEstado(s, ID)).toThrow(CalibrationStateError);
    }
  });
});

// ─── 3. La caché: formato autodescrito, identidad y todo-o-nada ──────────────

const canon = (texto: string, tenantId = "t") =>
  canonicalize({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: texto }], context: { tenantId } });
const resp = (text: string): CachedAnswer => ({ text, data: text, storedAtMs: 0 });
const CAL_RAPIDA = { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 } as const;
const PREGUNTA = "summarize the quarterly report for the board";

async function certificar(cache: InMemorySemanticCache, n = 40): Promise<void> {
  await cache.store(canon(PREGUNTA), resp("the summary"));
  for (let i = 0; i < n; i++) {
    const { probe } = await cache.lookup(canon(PREGUNTA));
    if (!probe) break;
    await cache.observe(probe, resp("the summary"));
  }
  await cache.settled();
}

describe("exportCalibration / importCalibration", () => {
  it("el estado es JSON autodescrito: formato, versión, embebedor, juez, configuración y segmento", async () => {
    const cache = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(cache);
    const s = cache.exportCalibration();
    expect(s.format).toBe("bvsala.semantic-calibration");
    expect(s.version).toBe(1);
    expect(s.embedder).toBe("built_in:lexical-256-v1");
    expect(s.verifier).toBeNull();
    expect(s.judge).toBe("built_in:same-answer-v1");
    expect(s.config).toEqual({ maxErrorRate: 0.5, confidence: 0.9, similarityThreshold: 0.72, grid: 1000 });
    expect(Object.keys(s.segments)).toEqual(["single_shot"]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("⛔ tras reiniciar, el suelo sigue certificado: la instancia nueva sirve sin volver a calibrar, con la misma cota", async () => {
    const vieja = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(vieja);
    const guardado = JSON.stringify(vieja.exportCalibration());

    const nueva = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    nueva.importCalibration(guardado); // el texto JSON tal cual también vale
    const otra = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    otra.importCalibration(JSON.parse(guardado));
    expect(otra.calibrationStatus()).toEqual(nueva.calibrationStatus());
    expect(() => otra.importCalibration("{no es json")).toThrow(CalibrationStateError);
    expect(nueva.calibrationStatus()).toEqual(vieja.calibrationStatus());
    await nueva.store(canon(PREGUNTA), resp("the summary"));
    const { hit, probe } = await nueva.lookup(canon(PREGUNTA));
    expect(probe).toBeNull();
    expect(hit!.calibration!.floor).toBe(vieja.calibrationStatus()!.floor);
    // Sin importar, la misma consulta solo habría sido una sonda.
    const fria = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await fria.store(canon(PREGUNTA), resp("the summary"));
    expect((await fria.lookup(canon(PREGUNTA))).probe!.reason).toBe("calibrating");
  });

  it("por la API pública y con reinicios: la trayectoria entera es la de una caché que no paró nunca", async () => {
    // Un embebedor que da la puntuación que toca: saca `s` de una cola y
    // devuelve [s, √(1−s²)]. El registro guardado entra con s = 1 ([1, 0]), así
    // que cada consulta sale con coseno exactamente `s`. El texto consultado es
    // el guardado, así que la verja de hechos pasa siempre.
    const rngPuntos = mulberry32(3);
    const guion: { s: number; ok: boolean }[] = Array.from({ length: 2500 }, () => {
      const s = 0.6 + 0.4 * rngPuntos();
      return { s, ok: rngPuntos() >= qVerdad(s) };
    });
    const opciones = (cola: number[], random: () => number): SemanticCacheOptions => ({
      embed: () => {
        const s = cola.shift()!;
        return [s, Math.sqrt(1 - s * s)];
      },
      embedderId: "sintetico-2d",
      similarityThreshold: 0.6,
      calibration: { maxErrorRate: 0.15, confidence: 0.9, perRecordFloors: false, auditRate: 0.1, random },
    });
    // Las dos cadenas consumen el mismo dado en el mismo orden.
    const dadoA = mulberry32(8);
    const dadoB = mulberry32(8);
    const colaA: number[] = [];
    const colaB: number[] = [];
    const nuevaCache = async (cola: number[], dado: () => number) => {
      const c = new InMemorySemanticCache(opciones(cola, dado));
      cola.push(1);
      await c.store(canon("stored question about invoices"), resp("ok"));
      return c;
    };
    let sinParar = await nuevaCache(colaA, dadoA);
    let reiniciada = await nuevaCache(colaB, dadoB);
    const pregunta = canon("stored question about invoices");
    const cuando = mulberry32(21);
    let siguiente = 1 + Math.floor(cuando() * 400);
    let servidas = 0;
    let reinicios = 0;
    for (let i = 0; i < guion.length; i++) {
      const { s, ok } = guion[i]!;
      colaA.push(s);
      colaB.push(s);
      const a = await sinParar.lookup(pregunta);
      const b = await reiniciada.lookup(pregunta);
      expect(b.hit?.calibration).toEqual(a.hit?.calibration);
      expect(b.probe?.reason).toEqual(a.probe?.reason);
      if (a.hit) servidas++;
      if (a.probe) await sinParar.observe(a.probe, resp(ok ? "ok" : "not ok"));
      if (b.probe) await reiniciada.observe(b.probe, resp(ok ? "ok" : "not ok"));
      if (i + 1 === siguiente) {
        await reiniciada.settled();
        const guardado = JSON.stringify(reiniciada.exportCalibration());
        reiniciada = await nuevaCache(colaB, dadoB);
        reiniciada.importCalibration(JSON.parse(guardado));
        reinicios++;
        siguiente = i + 2 + Math.floor(cuando() * 400);
      }
      expect(reiniciada.calibrationStatus()).toEqual(sinParar.calibrationStatus());
    }
    expect(reinicios).toBeGreaterThan(5);
    expect(servidas).toBeGreaterThan(0);
  });

  it("⛔ un estado de OTRO embebedor o de otra configuración se rechaza, y dice qué no cuadra", async () => {
    const base = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(base);
    const s = JSON.parse(JSON.stringify(base.exportCalibration())) as SemanticCalibrationState;
    const casos: [SemanticCacheOptions, RegExp][] = [
      [{ calibration: CAL_RAPIDA, embed: vectorLocal, embedderId: "text-embedding-3-small" }, /embedder: "built_in:lexical-256-v1" in the state, "custom:text-embedding-3-small" here/],
      [{ calibration: { ...CAL_RAPIDA, maxErrorRate: 0.4 } }, /maxErrorRate: 0\.5 in the state, 0\.4 here/],
      [{ calibration: { ...CAL_RAPIDA, confidence: 0.95 } }, /confidence: 0\.9 in the state, 0\.95 here/],
      [{ calibration: CAL_RAPIDA, similarityThreshold: 0.8 }, /similarityThreshold: 0\.72 in the state, 0\.8 here/],
      [{ calibration: { ...CAL_RAPIDA, judge: () => true, judgeId: "mi-juez" } }, /judge: "built_in:same-answer-v1" in the state, "custom:mi-juez" here/],
      [{ calibration: CAL_RAPIDA, verify: () => 1, verifierId: "cross-encoder" }, /verifier: null in the state, "custom:cross-encoder" here/],
    ];
    for (const [opts, mensaje] of casos) {
      const otra = new InMemorySemanticCache(opts);
      expect(() => otra.importCalibration(s)).toThrow(CalibrationStateError);
      expect(() => otra.importCalibration(s)).toThrow(mensaje);
      expect(() => otra.importCalibration(s)).toThrow(/start a new calibration instead/);
      expect(otra.calibrationStatus()!.labeled).toBe(0);
    }
  });

  it("sin nombre para una pieza propia no se exporta: no habría identidad que comparar al importar", () => {
    const sinNombre: [SemanticCacheOptions, RegExp][] = [
      [{ calibration: CAL_RAPIDA, embed: vectorLocal }, /pass `embedderId`/],
      [{ calibration: CAL_RAPIDA, verify: () => 1 }, /pass `verifierId`/],
      [{ calibration: { ...CAL_RAPIDA, judge: () => true } }, /pass `calibration.judgeId`/],
    ];
    for (const [opts, mensaje] of sinNombre) {
      expect(() => new InMemorySemanticCache(opts).exportCalibration()).toThrow(mensaje);
    }
    expect(() => new InMemorySemanticCache().exportCalibration()).toThrow(/without `calibration`/);
  });

  it("un estado de un SDK más nuevo, o que no es de calibración, se rechaza con un error claro", async () => {
    const cache = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    const s = cache.exportCalibration();
    expect(() => cache.importCalibration({ ...s, version: 2 as 1 })).toThrow(/newer SDK \(version 2\)/);
    expect(() => cache.importCalibration({ ...s, format: "otra-cosa" as "bvsala.semantic-calibration" })).toThrow(/not a semantic calibration state/);
    expect(() => cache.importCalibration(null as unknown as SemanticCalibrationState)).toThrow(CalibrationStateError);
  });

  it("todo o nada: si un segmento no cuadra, no se importa ninguno; y no se mezcla con etiquetas ya anotadas", async () => {
    const origen = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(origen);
    const s = JSON.parse(JSON.stringify(origen.exportCalibration())) as SemanticCalibrationState;
    const roto = { ...s, segments: { ...s.segments, agentic: { ...s.segments.single_shot!, looks: 0 } } };
    const destino = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    expect(() => destino.importCalibration(roto)).toThrow(CalibrationStateError);
    expect(destino.calibrationStatus()!.labeled).toBe(0);

    const conEtiquetas = new InMemorySemanticCache({ calibration: CAL_RAPIDA });
    await certificar(conEtiquetas, 2);
    expect(() => conEtiquetas.importCalibration(s)).toThrow(/already recorded 2 labels in the single_shot segment/);
  });

  it("la función fuera de línea y la caché siguen igual: exportar no toca `calibrateSemanticFloor`", () => {
    const r = calibrateSemanticFloor([{ score: 0.9, correct: true }], { maxErrorRate: 0.05 });
    expect(r.floor).toBeNull();
  });
});

// ─── 4. El embebedor léxico tiene identidad: si cambian sus vectores, cambia ──

describe("la identidad del embebedor que viaja con el SDK", () => {
  it("los vectores de `lexical-256-v1` están fijados: si cambian, hay que subir la versión en semantic.ts", () => {
    // Si este test falla porque cambió `vectorLocal`, NO se actualiza la huella
    // sin más: se sube `ID_DEL_EMBEBEDOR_LOCAL` (semantic.ts) y el nombre que
    // espera el test de arriba. Un estado calibrado con los vectores viejos no
    // dice nada de los nuevos, y la versión es lo que hace que se rechace.
    const textos = ["summarize the quarterly report", "resume el informe trimestral", "¿qué dice la sección 3?", ""];
    const huella = createHash("sha256")
      .update(JSON.stringify(textos.map((t) => vectorLocal(t).map((x) => x.toFixed(12)))))
      .digest("hex");
    expect(huella).toBe(HUELLA_LEXICAL_256_V1);
  });
});

const HUELLA_LEXICAL_256_V1 = "4761730ac4203371e3dc07540abdc8554f0908c33329d0c78749664fc9150f27";
