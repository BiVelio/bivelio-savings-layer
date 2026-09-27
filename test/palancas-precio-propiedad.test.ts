import { describe, it, expect } from "vitest";

import { CATALOGO } from "../src/pricing/catalogo.js";
import { primaDeEscritura } from "../src/pricing/primas.js";
import {
  TARIFAS_DE_TIER,
  type OrigenDeTarifa,
  type TarifaDeTier,
  type TarifaPlana,
} from "../src/pricing/tarifas-de-tier.js";
import { FACTOR_DIFERIDO_MINIMO, valorarTierServido } from "../src/economics/tier-diferido.js";
import {
  explicitaAplicable,
  valorarEscriturasEvitadas,
} from "../src/economics/escrituras-de-cache.js";

/**
 * LAS PALANCAS DE PRECIO NUNCA ACREDITAN MÁS QUE LA DIFERENCIA REAL DE CATÁLOGO.
 *
 * Propiedades, no ejemplos: 500 semillas por fila. La cifra «real» se calcula
 * aquí DIRECTAMENTE de las tablas y en ARITMÉTICA ENTERA —precios en 1e-9 USD
 * por 1K tokens, importes en 1e-12 USD—, así que la cota superior se comprueba
 * sin tolerancia de coma flotante: el importe no puede pasarse ni un picodólar.
 */

/** mulberry32: determinista, para que un fallo se reproduzca con su semilla. */
function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEMILLAS = 500;
// Dentro de la vigencia de todas las filas (gpt-5.6-sol caduca el 2026-11-21).
const AHORA = Date.parse("2026-09-27T12:00:00Z");

const filas = Object.entries(TARIFAS_DE_TIER).flatMap(([origen, porTier]) =>
  Object.entries(porTier).flatMap(([tier, porModelo]) =>
    Object.entries(porModelo).map(([modelo, fila]) => ({
      origen: origen as OrigenDeTarifa,
      tier,
      modelo,
      fila,
    })),
  ),
);

/** Un precio por 1K en unidades enteras de 1e-9 USD. Falla si no es exacto. */
function nano(precio: number): bigint {
  const n = Math.round(precio * 1e9);
  if (Math.abs(n - precio * 1e9) > 1e-6) throw new Error(`precio no representable: ${precio}`);
  return BigInt(n);
}

interface Uso {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  complete?: boolean;
}

function usoAleatorio(r: () => number): Uso {
  const entrada = Math.floor(r() * 400_000);
  const cacheados = r() < 0.3 ? 0 : Math.floor(r() * (entrada + 1));
  const escritos = r() < 0.4 ? 0 : Math.floor(r() * (entrada - cacheados + 1));
  const salida = Math.floor(r() * 60_000);
  return {
    inputTokens: entrada,
    outputTokens: salida,
    ...(r() < 0.8 ? { cachedInputTokens: cacheados } : {}),
    ...(r() < 0.7 ? { cacheWriteInputTokens: escritos } : {}),
    ...(r() < 0.1 ? { complete: false } : {}),
  };
}

/**
 * La diferencia REAL, en 1e-12 USD, y si algún componente con tokens se quedó
 * sin precio de tier. Directamente de CATALOGO y de la fila: sin pasar por el
 * código que se prueba.
 *
 * UN CONTADOR AUSENTE NO ES UN CERO. Si el uso no dice cuántos tokens leyó de la
 * caché (o, con prima, cuántos escribió), la entrada sin desglosar pudo ser
 * cualquiera de esos componentes, así que su diferencia REAL por token es
 * desconocida y la única cota defendible es la MENOR de las posibles: eso es lo
 * que devuelve aquí, y `sinDesglose` dice que pasó.
 */
function diferenciaReal(
  modelo: string,
  fila: TarifaDeTier,
  u: Uso,
): { unidades: bigint; sinPrecio: boolean; sinDesglose: boolean } {
  const std = CATALOGO[modelo]!;
  const prima = primaDeEscritura(modelo);
  const lecturas = u.cachedInputTokens !== undefined;
  const escrituras = prima <= 1 || u.cacheWriteInputTokens !== undefined;
  const entrada = u.inputTokens;
  const cacheados = lecturas ? Math.min(u.cachedInputTokens!, entrada) : 0;
  const escritos = prima > 1 && escrituras ? Math.min(u.cacheWriteInputTokens!, entrada - cacheados) : 0;
  const resto = entrada - cacheados - escritos;
  // Diferencia por token de cada componente; sin precio de tier, 0.
  const dEntrada = nano(std.inputPer1k) - nano(fila.inputPer1k);
  const dLectura =
    fila.cachedInputPer1k === undefined ? 0n : nano(std.cachedInputPer1k ?? std.inputPer1k) - nano(fila.cachedInputPer1k);
  const dEscritura =
    fila.cacheWritePer1k === undefined ? 0n : nano(std.inputPer1k * prima) - nano(fila.cacheWritePer1k);
  const dSalida = nano(std.outputPer1k) - nano(fila.outputPer1k);
  let dResto = dEntrada;
  if (!lecturas && dLectura < dResto) dResto = dLectura;
  if (!escrituras && dEscritura < dResto) dResto = dEscritura;
  const unidades =
    BigInt(resto) * dResto +
    BigInt(cacheados) * dLectura +
    BigInt(escritos) * dEscritura +
    BigInt(u.outputTokens) * dSalida;
  const sinPrecio =
    (cacheados > 0 && fila.cachedInputPer1k === undefined) || (escritos > 0 && fila.cacheWritePer1k === undefined);
  return { unidades, sinPrecio, sinDesglose: resto > 0 && (!lecturas || !escrituras) };
}

/**
 * La diferencia real de UN reparto concreto de la entrada: `cacheados` leídos,
 * `escritos` escritos y el resto ordinario, todos conocidos. Es la factura de
 * una llamada cuyo contador sí lo hubiera desglosado.
 */
function diferenciaDeUnReparto(modelo: string, fila: TarifaDeTier, entrada: number, cacheados: number, escritos: number, salida: number): bigint {
  return diferenciaReal(modelo, fila, {
    inputTokens: entrada,
    outputTokens: salida,
    cachedInputTokens: cacheados,
    cacheWriteInputTokens: escritos,
  }).unidades;
}

// ── P1 ──────────────────────────────────────────────────────────────────────

describe("P1 · el importe es la diferencia real de catálogo, redondeada hacia abajo", () => {
  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
      const r = azar(semilla * 7919 + f.modelo.length);
      const u = usoAleatorio(r);
      const variante = r();
      const id =
        variante < 0.25 ? `${f.origen === "openai" ? "openai" : "google"}/${f.modelo}` : f.modelo;
      const atestiguado = r() < 0.7;
      const leidoDe = r() < 0.8 ? ("cuerpo" as const) : ("cabecera" as const);
      const v = valorarTierServido({
        modelo: id,
        uso: u,
        tierServido: f.tier,
        origen: atestiguado ? f.origen : null,
        tierLeidoDe: leidoDe,
        ahoraMs: AHORA,
      });
      const ctx = `semilla ${semilla} · ${JSON.stringify(u)} · origen ${atestiguado} · ${leidoDe}`;

      if (u.complete === false) {
        expect(v, ctx).toEqual({ ok: false, motivo: "incomplete-usage" });
        continue;
      }
      const real = diferenciaReal(f.modelo, f.fila, u);
      if (real.unidades < 100n) {
        // Menos de 1e-10 de diferencia: nada que acreditar.
        expect(v.ok, ctx).toBe(false);
        continue;
      }
      expect(v.ok, ctx).toBe(true);
      if (!v.ok) continue;
      expect(v.importe, ctx).toBeGreaterThanOrEqual(0);
      // importe = k·1e-10 exactamente; real − 1e-10 ≤ importe ≤ real, en enteros.
      const k = Math.round(v.importe * 1e10);
      expect(Math.abs(k - v.importe * 1e10), ctx).toBeLessThan(1e-3);
      expect(BigInt(k) * 100n <= real.unidades, `${ctx} · se pasa de la diferencia real`).toBe(true);
      expect(real.unidades - BigInt(k) * 100n <= 100n, `${ctx} · se queda más de 1e-10 corto`).toBe(true);
      // `measured` solo con M1–M6 a la vez (M3 y M4 los da el caso; M6 exige
      // además el desglose de la caché en el contador).
      const debeSerMedido = atestiguado && leidoDe === "cuerpo" && !real.sinPrecio && !real.sinDesglose;
      expect(v.basis, ctx).toBe(debeSerMedido ? "measured" : "estimated");
    }
  });
});

describe("P1 · con un contador sin desglose, NINGÚN reparto real deja el importe por encima de su factura", () => {
  // La propiedad adversaria: el proveedor calló cuántos tokens de la entrada
  // leyó (o escribió) de su caché. Sean los que sean —se prueban repartos al
  // azar, y los dos extremos—, el importe no puede pasar de la diferencia que
  // traería la factura con ESE reparto.
  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    const prima = primaDeEscritura(f.modelo);
    for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
      const r = azar(semilla * 6007 + f.modelo.length);
      const entrada = 1024 + Math.floor(r() * 300_000);
      const salida = Math.floor(r() * 40_000);
      const callaLecturas = r() < 0.7;
      const callaEscrituras = prima > 1 && (!callaLecturas || r() < 0.5);
      const u: Uso = {
        inputTokens: entrada,
        outputTokens: salida,
        ...(callaLecturas ? {} : { cachedInputTokens: Math.floor(r() * (entrada + 1)) }),
        ...(callaEscrituras || prima <= 1 ? {} : { cacheWriteInputTokens: 0 }),
      };
      const v = valorarTierServido({ modelo: f.modelo, uso: u, tierServido: f.tier, origen: f.origen, tierLeidoDe: "cuerpo", ahoraMs: AHORA });
      const ctx = `semilla ${semilla} · ${JSON.stringify(u)}`;
      if (!v.ok) continue;
      if (callaLecturas || callaEscrituras) expect(v.basis, ctx).toBe("estimated");
      const k = BigInt(Math.round(v.importe * 1e10)) * 100n;
      const cacheadosConocidos = u.cachedInputTokens ?? 0;
      const libres = entrada - cacheadosConocidos;
      const repartos: [number, number][] = [
        [callaLecturas ? libres : 0, 0],
        [0, callaEscrituras ? libres : 0],
        [0, 0],
      ];
      for (let i = 0; i < 20; i++) {
        const c = callaLecturas ? Math.floor(r() * (libres + 1)) : 0;
        const w = callaEscrituras ? Math.floor(r() * (libres - c + 1)) : 0;
        repartos.push([c, w]);
      }
      for (const [c, w] of repartos) {
        const real = diferenciaDeUnReparto(f.modelo, f.fila, entrada, cacheadosConocidos + c, w, salida);
        expect(k <= real, `${ctx} · reparto lectura +${c} escritura ${w} · se pasa de la factura`).toBe(true);
      }
    }
  });
});

describe("P1 · con precio del cliente siempre es `estimated`, y nunca pasa ni de SU diferencia ni de la publicada", () => {
  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    const std = CATALOGO[f.modelo]!;
    const prima = primaDeEscritura(f.modelo);
    let topadas = 0;
    for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
      const r = azar(semilla * 104729 + 3);
      const u = { ...usoAleatorio(r), complete: true };
      const cliente = {
        inputPer1k: std.inputPer1k * (0.2 + r() * 1.6),
        outputPer1k: std.outputPer1k * (0.2 + r() * 1.6),
        ...(r() < 0.7 ? { cachedInputPer1k: (std.cachedInputPer1k ?? std.inputPer1k) * (0.2 + r()) } : {}),
      };
      const v = valorarTierServido({
        modelo: f.modelo,
        uso: u,
        tierServido: f.tier,
        origen: f.origen,
        tierLeidoDe: "cuerpo",
        precioDelCliente: cliente,
        ahoraMs: AHORA,
      });
      if (!v.ok) continue;
      expect(v.basis).toBe("estimated");
      // SU diferencia: su estándar por el ratio publicado, con la entrada sin
      // desglosar al suelo (el menor de los componentes que pudo ser).
      const lecturas = u.cachedInputTokens !== undefined;
      const escrituras = prima <= 1 || u.cacheWriteInputTokens !== undefined;
      const entrada = u.inputTokens;
      const cacheados = lecturas ? Math.min(u.cachedInputTokens!, entrada) : 0;
      const escritos = prima > 1 && escrituras ? Math.min(u.cacheWriteInputTokens!, entrada - cacheados) : 0;
      const ratio = (t: number | undefined, s: number) => (t === undefined ? 1 : t / s);
      const dEntrada = cliente.inputPer1k * (1 - ratio(f.fila.inputPer1k, std.inputPer1k));
      const dLectura =
        (cliente.cachedInputPer1k ?? cliente.inputPer1k) *
        (1 - ratio(f.fila.cachedInputPer1k, std.cachedInputPer1k ?? std.inputPer1k));
      const dEscritura = cliente.inputPer1k * prima * (1 - ratio(f.fila.cacheWritePer1k, std.inputPer1k * prima));
      const dResto = Math.min(dEntrada, lecturas ? Infinity : dLectura, escrituras ? Infinity : dEscritura);
      const suya =
        ((entrada - cacheados - escritos) / 1000) * dResto +
        (cacheados / 1000) * dLectura +
        (escritos / 1000) * dEscritura +
        (u.outputTokens / 1000) * cliente.outputPer1k * (1 - ratio(f.fila.outputPer1k, std.outputPer1k));
      // La publicada, en enteros y sin pasar por el código que se prueba.
      const publicada = Number(diferenciaReal(f.modelo, f.fila, u).unidades) / 1e12;
      if (suya > publicada) topadas++;
      const tope = Math.min(suya, publicada);
      // Aquí los precios no son decimales exactos: tolerancia relativa de coma flotante.
      expect(v.importe).toBeLessThanOrEqual(tope * (1 + 1e-12));
      expect(v.importe).toBeGreaterThanOrEqual(tope * (1 - 1e-12) - 1e-10);
      expect(v.importe, "nunca más que la diferencia publicada").toBeLessThanOrEqual(publicada + 1e-15);
      expect(v.costeEstandar - v.costeAplicado).toBeLessThanOrEqual(tope * (1 + 1e-9) + 1e-15);
    }
    // Si ninguna semilla superara la publicada, el tope no estaría probado.
    expect(topadas, "ninguna semilla ejercitó el tope").toBeGreaterThan(0);
  });
});

// ── P2 ──────────────────────────────────────────────────────────────────────

describe("P2 · sin fila propia, sin tier o con tier de tarifa estándar, nunca hay `measured`", () => {
  const uso = { inputTokens: 50_000, outputTokens: 4_000, cachedInputTokens: 10_000 };

  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    // Sufijo de letra y versión menor: OTRO modelo, sin fila propia → nada.
    for (const id of [`${f.modelo}-latest`, `${f.modelo}-preview`, `${f.modelo}-9`, `${f.modelo}.9`]) {
      const v = valorarTierServido({ modelo: id, uso, tierServido: f.tier, origen: f.origen, tierLeidoDe: "cuerpo", ahoraMs: AHORA });
      expect(v.ok, id).toBe(false);
    }
    // `vendor/` sin origen atestiguado: como mucho `estimated`.
    for (const vendor of ["openrouter", "vercel", "acme"]) {
      const v = valorarTierServido({ modelo: `${vendor}/${f.modelo}`, uso, tierServido: f.tier, origen: null, tierLeidoDe: "cuerpo", ahoraMs: AHORA });
      if (v.ok) expect(v.basis).toBe("estimated");
    }
    // Tier ausente, desconocido o de tarifa estándar: ningún crédito.
    for (const tier of [undefined, "", "default", "auto", "priority", "fast", "scale", "standard", "turbo", "FLEX"]) {
      const v = valorarTierServido({ modelo: f.modelo, uso, tierServido: tier, origen: f.origen, tierLeidoDe: "cuerpo", ahoraMs: AHORA });
      expect(v.ok, String(tier)).toBe(false);
    }
  });

  it("un modelo con fila estándar y SIN fila de tier no acredita nada (gpt-4o-mini, claude)", () => {
    for (const modelo of ["gpt-4o-mini", "gpt-4.1", "o3-mini", "claude-haiku-4-5", "gpt-5.1-codex"]) {
      for (const origen of ["openai", "google", null] as const) {
        const v = valorarTierServido({ modelo, uso, tierServido: "flex", origen, tierLeidoDe: "cuerpo", ahoraMs: AHORA });
        expect(v).toEqual({ ok: false, motivo: "no-tier-price" });
      }
    }
  });
});

// ── P3 ──────────────────────────────────────────────────────────────────────

const COMPONENTES = ["inputPer1k", "cachedInputPer1k", "cacheWritePer1k", "outputPer1k"] as const;

function estandarDe(modelo: string): Required<TarifaPlana> {
  const s = CATALOGO[modelo]!;
  return {
    inputPer1k: s.inputPer1k,
    cachedInputPer1k: s.cachedInputPer1k ?? s.inputPer1k,
    cacheWritePer1k: s.inputPer1k * primaDeEscritura(modelo),
    outputPer1k: s.outputPer1k,
  };
}

describe("P3 · la referencia sigue siendo suelo: el factor mínimo no supera ningún ratio publicado", () => {
  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    const pares: [TarifaPlana, Required<TarifaPlana>][] = [[f.fila, estandarDe(f.modelo)]];
    if (f.fila.largo) {
      const e = f.fila.largo.estandar;
      pares.push([
        f.fila.largo.tier,
        {
          inputPer1k: e.inputPer1k,
          cachedInputPer1k: e.cachedInputPer1k ?? e.inputPer1k,
          cacheWritePer1k: e.cacheWritePer1k ?? e.inputPer1k,
          outputPer1k: e.outputPer1k,
        },
      ]);
    }
    for (const [tier, std] of pares) {
      for (const c of COMPONENTES) {
        const t = tier[c];
        if (t === undefined) continue;
        expect(FACTOR_DIFERIDO_MINIMO, `${c}: ${t}/${std[c]}`).toBeLessThanOrEqual(t / std[c] + 1e-12);
      }
    }
  });
});

// ── P4 ──────────────────────────────────────────────────────────────────────

describe("P4 · coherencia de cada fila, y tarifar a tarifa corta solo puede quedarse corto", () => {
  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))("%s", (_n, f) => {
    const std = estandarDe(f.modelo);
    for (const c of COMPONENTES) {
      const t = f.fila[c];
      if (t === undefined) continue;
      expect(t, `${c} del tier por encima del estándar`).toBeLessThanOrEqual(std[c]);
    }
    if (f.fila.cachedInputPer1k !== undefined) expect(f.fila.cachedInputPer1k).toBeLessThanOrEqual(f.fila.inputPer1k);
    if (f.fila.cacheWritePer1k !== undefined) expect(f.fila.cacheWritePer1k).toBeGreaterThanOrEqual(f.fila.inputPer1k);
    // Una escritura con precio publicado solo existe donde hay prima: sin prima
    // se tarifa como entrada normal.
    if (f.fila.cacheWritePer1k !== undefined) expect(primaDeEscritura(f.modelo)).toBeGreaterThan(1);

    if (!f.fila.largo) return;
    const { estandar: el, tier: tl } = f.fila.largo;
    for (const c of COMPONENTES) {
      const tc = f.fila[c];
      const ltc = tl[c];
      if (tc === undefined || ltc === undefined) continue;
      const lsc = el[c] ?? (c === "cachedInputPer1k" ? el.inputPer1k : undefined);
      expect(lsc, `${c}: falta el estándar largo`).toBeDefined();
      // Diferencia larga ≥ diferencia corta, componente a componente.
      expect(lsc! - ltc, c).toBeGreaterThanOrEqual(std[c] - tc - 1e-15);
      expect(ltc).toBeLessThanOrEqual(lsc!);
    }
  });
});

// ── P5 ──────────────────────────────────────────────────────────────────────

describe("P5 · la prima evitada del modo explícito", () => {
  it("es ordinarios·(escritura − entrada), 0 por debajo del mínimo, en toda fila con escritura", () => {
    const conEscritura = [
      ...Object.keys(CATALOGO)
        .filter((m) => primaDeEscritura(m) > 1 && m.startsWith("gpt-"))
        .map((m) => ({ nombre: `estándar ${m}`, fila: { inputPer1k: estandarDe(m).inputPer1k, cacheWritePer1k: estandarDe(m).cacheWritePer1k } })),
      ...filas
        .filter((f) => f.fila.cacheWritePer1k !== undefined)
        .map((f) => ({ nombre: `${f.tier} ${f.modelo}`, fila: { inputPer1k: f.fila.inputPer1k, cacheWritePer1k: f.fila.cacheWritePer1k! } })),
    ];
    expect(conEscritura.length).toBeGreaterThanOrEqual(6);
    for (const { nombre, fila } of conEscritura) {
      for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
        const r = azar(semilla * 31 + nombre.length);
        const u = usoAleatorio(r);
        const p = valorarEscriturasEvitadas({ uso: u, fila });
        const entrada = u.inputTokens;
        const cacheados = Math.min(u.cachedInputTokens ?? 0, entrada);
        const escritos = Math.min(u.cacheWriteInputTokens ?? 0, entrada - cacheados);
        const ordinarios = entrada - cacheados - escritos;
        const real = BigInt(ordinarios) * (nano(fila.cacheWritePer1k) - nano(fila.inputPer1k));
        if (entrada < 1024) {
          expect(p.importe, `${nombre} semilla ${semilla}`).toBe(0);
          continue;
        }
        const k = Math.round(p.importe * 1e10);
        expect(BigInt(k) * 100n <= real, `${nombre} semilla ${semilla}`).toBe(true);
        expect(real - BigInt(k) * 100n <= 100n, `${nombre} semilla ${semilla}`).toBe(true);
      }
    }
  });

  it("nunca aplica sin origen `openai` ni sobre un modelo sin prima de escritura", () => {
    for (const modelo of Object.keys(CATALOGO)) {
      for (const pref of ["", "openai/", "azure-openai/"]) {
        const id = `${pref}${modelo}`;
        for (const origen of ["google", null, undefined] as const) {
          expect(explicitaAplicable(id, origen), `${id} · ${origen}`).toBe(false);
        }
        expect(explicitaAplicable(id, "openai"), id).toBe(primaDeEscritura(modelo) > 1 && modelo.startsWith("gpt-"));
      }
    }
    // Hoy, solo la familia gpt-5.6.
    expect(explicitaAplicable("openai/gpt-5.6-luna", "openai")).toBe(true);
    expect(explicitaAplicable("openai/gpt-5.4", "openai")).toBe(false);
  });
});
