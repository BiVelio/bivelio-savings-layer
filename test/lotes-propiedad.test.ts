import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { primaDeEscritura } from "../src/pricing/primas.js";
import { TARIFAS_DE_TIER, type TarifaDeTier } from "../src/pricing/tarifas-de-tier.js";
import type { BatchRequest } from "../src/contracts/batch.js";

/**
 * UN LOTE NUNCA ACREDITA MÁS QUE LA DIFERENCIA REAL DE CATÁLOGO, DE PUNTA A PUNTA.
 *
 * `palancas-precio-propiedad.test.ts` prueba la cuenta (`valorarTierServido`)
 * fila a fila. Esto prueba el CAMINO ENTERO de `layer.batches`: el JSONL que
 * devuelve el proveedor, la lectura del adaptador, el tier que se lee (o no) y
 * la suma del resumen. La cota se calcula aquí directamente de CATALOGO y de la
 * tabla de lote, en ARITMÉTICA ENTERA (precios en 1e-9 USD por 1K tokens,
 * importes en 1e-12 USD), sin pasar por el código que se prueba.
 */

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

function nano(precio: number): bigint {
  const n = Math.round(precio * 1e9);
  if (Math.abs(n - precio * 1e9) > 1e-6) throw new Error(`precio no representable: ${precio}`);
  return BigInt(n);
}

/** Lo que dice el contador, ya en la forma neutra (entrada TOTAL, con lo cacheado dentro). */
interface Contador {
  entrada: number;
  lecturas?: number;
  escrituras?: number;
  salida: number;
}

/** La diferencia real en 1e-12 USD; la entrada sin desglosar, al MENOR componente posible. */
function diferenciaReal(modelo: string, fila: TarifaDeTier, u: Contador): bigint {
  const std = CATALOGO[modelo]!;
  const prima = primaDeEscritura(modelo);
  const conoceLecturas = u.lecturas !== undefined;
  const conoceEscrituras = prima <= 1 || u.escrituras !== undefined;
  const cacheados = conoceLecturas ? Math.min(u.lecturas!, u.entrada) : 0;
  const escritos = prima > 1 && conoceEscrituras ? Math.min(u.escrituras!, u.entrada - cacheados) : 0;
  const resto = u.entrada - cacheados - escritos;
  const dEntrada = nano(std.inputPer1k) - nano(fila.inputPer1k);
  const dLectura =
    fila.cachedInputPer1k === undefined ? 0n : nano(std.cachedInputPer1k ?? std.inputPer1k) - nano(fila.cachedInputPer1k);
  const dEscritura = fila.cacheWritePer1k === undefined ? 0n : nano(std.inputPer1k * prima) - nano(fila.cacheWritePer1k);
  let dResto = dEntrada;
  if (!conoceLecturas && dLectura < dResto) dResto = dLectura;
  if (!conoceEscrituras && dEscritura < dResto) dResto = dEscritura;
  const total =
    BigInt(resto) * dResto +
    BigInt(cacheados) * dLectura +
    BigInt(escritos) * dEscritura +
    BigInt(u.salida) * (nano(std.outputPer1k) - nano(fila.outputPer1k));
  return total > 0n ? total : 0n;
}

const SEMILLAS = 25;
const POR_LOTE = 40;

interface Fixture {
  lineas: unknown[];
  estadoDelLote: string;
}

function servidor(base: string, fx: Fixture, protocolo: "anthropic" | "openai") {
  return (async (url: string, init: RequestInit = {}) => {
    const ruta = String(url).replace(base, "");
    const metodo = init.method ?? "GET";
    const r = (cuerpo: unknown, tipo = "application/json") =>
      new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { headers: { "content-type": tipo } });
    const jsonl = fx.lineas.map((l) => JSON.stringify(l)).join("\n");
    if (protocolo === "anthropic") {
      if (metodo === "POST" && ruta === "/messages/batches") return r({ id: "msgbatch_p" });
      if (metodo === "GET" && ruta === "/messages/batches/msgbatch_p") return r({ id: "msgbatch_p", processing_status: fx.estadoDelLote });
      if (metodo === "GET" && ruta === "/messages/batches/msgbatch_p/results") return r(jsonl, "application/x-jsonl");
    } else {
      if (metodo === "POST" && ruta === "/files") return r({ id: "file-in" });
      if (metodo === "POST" && ruta === "/batches") return r({ id: "batch_p" });
      if (metodo === "GET" && ruta === "/batches/batch_p") return r({ id: "batch_p", status: fx.estadoDelLote, output_file_id: "file-out" });
      if (metodo === "GET" && ruta === "/files/file-out/content") return r(jsonl, "application/x-jsonl");
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("P6 · Anthropic: el lote entero nunca acredita más que la suma de las diferencias reales", () => {
  const filas = Object.entries(TARIFAS_DE_TIER.anthropic.batch!);

  it.each(Array.from({ length: SEMILLAS }, (_, i) => i + 1))("semilla %i", async (semilla) => {
    const r = azar(semilla * 2654435761);
    const fx: Fixture = { lineas: [], estadoDelLote: "ended" };
    const base = "https://api.anthropic.com/v1";
    const layer = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "k", fetchImpl: servidor(base, fx, "anthropic") }) });

    const peticiones: BatchRequest[] = [];
    const esperado = new Map<string, { real: bigint; acredita: boolean; medido: boolean }>();
    for (let i = 0; i < POR_LOTE; i++) {
      const [modelo, fila] = filas[Math.floor(r() * filas.length)]!;
      const id = `r${i}`;
      peticiones.push({ customId: id, request: { model: `anthropic/${modelo}`, messages: [{ role: "user", content: "x" }] } });
      const resto = Math.floor(r() * 200_000);
      const lecturas = r() < 0.8 ? Math.floor(r() * 150_000) : undefined;
      const escrituras = r() < 0.8 ? Math.floor(r() * 50_000) : undefined;
      const salida = Math.floor(r() * 30_000);
      // El tier que dice el resultado: casi siempre "batch", a veces otro o ninguno.
      const dado = r();
      const tier = dado < 0.8 ? "batch" : dado < 0.88 ? "standard" : dado < 0.94 ? "priority" : undefined;
      const incompleto = r() < 0.05;
      fx.lineas.push({
        custom_id: id,
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: {
              ...(incompleto ? {} : { input_tokens: resto }),
              output_tokens: salida,
              ...(lecturas !== undefined ? { cache_read_input_tokens: lecturas } : {}),
              ...(escrituras !== undefined ? { cache_creation_input_tokens: escrituras } : {}),
              ...(tier ? { service_tier: tier } : {}),
            },
          },
        },
      });
      const u: Contador = { entrada: resto + (lecturas ?? 0) + (escrituras ?? 0), salida, ...(lecturas !== undefined ? { lecturas } : {}), ...(escrituras !== undefined ? { escrituras } : {}) };
      const real = diferenciaReal(modelo, fila, u);
      const acredita = tier === "batch" && !incompleto && real >= 100n;
      esperado.set(id, { real, acredita, medido: lecturas !== undefined && escrituras !== undefined });
    }

    const job = await layer.batches.submit(peticiones);
    const res = await layer.batches.results(job);
    let suma = 0n;
    let sumaReal = 0n;
    for (const it of res.items) {
      const e = esperado.get(it.customId)!;
      const ctx = `semilla ${semilla} · ${it.customId} · ${it.model} · ${it.reason}`;
      if (!e.acredita) {
        // Tier distinto de "batch", ausente o contador incompleto: nada. (Y una
        // diferencia de menos de 1e-10, tampoco.)
        if (e.real >= 100n) expect(it.tierSaving, ctx).toBeUndefined();
        continue;
      }
      expect(it.tierSaving, ctx).toBeDefined();
      const k = BigInt(Math.round(it.tierSaving!.amount * 1e10)) * 100n;
      expect(k <= e.real, `${ctx} · se pasa de la diferencia real`).toBe(true);
      expect(e.real - k <= 100n, `${ctx} · se queda más de 1e-10 corto`).toBe(true);
      expect(it.tierSaving!.basis, ctx).toBe(e.medido ? "measured" : "estimated");
      suma += k;
      sumaReal += e.real;
    }
    // El resumen es la suma EXACTA de los importes, y nunca pasa de la real.
    expect(BigInt(Math.round(res.summary.tierSaving * 1e10)) * 100n).toBe(suma);
    expect(suma <= sumaReal).toBe(true);
    expect(res.summary.creditedLedger).toBe("none");
  });
});

describe("P6 · OpenAI: lo mismo por el registro de lote, con modelos sin lectura cacheada publicada", () => {
  const filas = Object.entries(TARIFAS_DE_TIER.openai.batch!);

  it.each(Array.from({ length: SEMILLAS }, (_, i) => i + 1))("semilla %i", async (semilla) => {
    const r = azar(semilla * 40503 + 17);
    const fx: Fixture = { lineas: [], estadoDelLote: "completed" };
    const base = "https://api.openai.com/v1";
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: base, apiKey: "k", fetchImpl: servidor(base, fx, "openai") }),
    });
    // Un solo modelo por semilla: la Batch API de OpenAI admite uno por fichero,
    // y el servidor de mentira sirve un solo lote.
    const [modelo, fila] = filas[Math.floor(r() * filas.length)]!;
    const peticiones: BatchRequest[] = [];
    const esperado = new Map<string, { real: bigint; medido: boolean }>();
    for (let i = 0; i < POR_LOTE; i++) {
      const id = `r${i}`;
      peticiones.push({ customId: id, request: { model: `openai/${modelo}`, messages: [{ role: "user", content: "x" }] } });
      const entrada = Math.floor(r() * 300_000);
      const lecturas = r() < 0.8 ? Math.floor(r() * (entrada + 1)) : undefined;
      const escrituras = r() < 0.7 ? Math.floor(r() * (entrada - (lecturas ?? 0) + 1)) : undefined;
      const salida = Math.floor(r() * 40_000);
      fx.lineas.push({
        id: `batch_req_${i}`,
        custom_id: id,
        response: {
          status_code: 200,
          body: {
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: entrada,
              completion_tokens: salida,
              prompt_tokens_details: {
                ...(lecturas !== undefined ? { cached_tokens: lecturas } : {}),
                ...(escrituras !== undefined ? { cache_write_tokens: escrituras } : {}),
              },
            },
            // Lo que ponga el cuerpo no decide el tier en un lote de OpenAI.
            service_tier: "default",
          },
        },
        error: null,
      });
      const u: Contador = { entrada, salida, ...(lecturas !== undefined ? { lecturas } : {}), ...(escrituras !== undefined ? { escrituras } : {}) };
      const conoceTodo = lecturas !== undefined && (primaDeEscritura(modelo) <= 1 || escrituras !== undefined);
      const sinPrecio =
        ((lecturas ?? 0) > 0 && fila.cachedInputPer1k === undefined) ||
        (primaDeEscritura(modelo) > 1 && (escrituras ?? 0) > 0 && fila.cacheWritePer1k === undefined);
      esperado.set(id, { real: diferenciaReal(modelo, fila, u), medido: conoceTodo && !sinPrecio });
    }

    const job = await layer.batches.submit(peticiones);
    const res = await layer.batches.results(job);
    let suma = 0n;
    let sumaReal = 0n;
    for (const it of res.items) {
      const e = esperado.get(it.customId)!;
      const ctx = `semilla ${semilla} · ${it.customId} · ${modelo} · ${it.reason}`;
      if (e.real < 100n) {
        expect(it.tierSaving, ctx).toBeUndefined();
        continue;
      }
      expect(it.servedTier, ctx).toBe("batch");
      const k = BigInt(Math.round(it.tierSaving!.amount * 1e10)) * 100n;
      expect(k <= e.real, `${ctx} · se pasa de la diferencia real`).toBe(true);
      expect(e.real - k <= 100n, `${ctx} · se queda más de 1e-10 corto`).toBe(true);
      expect(it.tierSaving!.basis, ctx).toBe(e.medido ? "measured" : "estimated");
      suma += k;
      sumaReal += e.real;
    }
    expect(BigInt(Math.round(res.summary.tierSaving * 1e10)) * 100n).toBe(suma);
    expect(suma <= sumaReal).toBe(true);
  });
});
