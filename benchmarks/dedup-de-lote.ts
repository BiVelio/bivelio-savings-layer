// BENCHMARK: la dedup intra-lote, medida contra un proveedor de lotes falso que
// CUENTA líneas. No hay red: lo que se mide es lo único que importa de esta
// palanca — cuántas ejecuciones del proveedor se evitan — y los tokens de entrada
// que no se envían (y por tanto no se facturan, ni a tarifa de lote).
//
//   pnpm dedup:banco
//
// Carga sintética: N ítems, cada uno elige un prompt de un conjunto de M
// distintos (con repetición, de ahí los duplicados). La tasa de duplicados es
// (N − M) / N. Se envía la MISMA carga con `deduplicate: false` y `true`, y se
// compara el número de líneas que el proveedor habría recibido.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { heuristicEstimator } from "../src/tokenizer/estimator.js";
import type { BatchRequest } from "../src/contracts/batch.js";

const ANTHROPIC = "https://api.anthropic.com/v1";

/** Proveedor de lotes falso: cuenta las líneas de cada submit y devuelve un id. */
function contador() {
  const lote = { lineasRecibidas: 0 };
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const ruta = String(url).replace(ANTHROPIC, "");
    if (String(init.method ?? "GET") === "POST" && ruta === "/messages/batches") {
      const json = JSON.parse(String(init.body)) as { requests: unknown[] };
      lote.lineasRecibidas += json.requests.length;
      return new Response(JSON.stringify({ id: "msgbatch_b", type: "message_batch", processing_status: "in_progress" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { lote, provider: new AnthropicProvider({ apiKey: "k", fetchImpl }) };
}

const PLANTILLAS = [
  "Classify this support ticket into one of billing, access, or bug: {detalle}",
  "Summarize this customer complaint in one sentence: {detalle}",
  "Extract the order total and shipping address from: {detalle}",
  "Rewrite this changelog entry for a non-technical audience: {detalle}",
  "Answer this FAQ about our return policy: {detalle}",
];

function carga(n: number, distintos: number): BatchRequest[] {
  const items: BatchRequest[] = [];
  for (let i = 0; i < n; i++) {
    const idx = i % distintos; // 0..distintos-1: crea `distintos` prompts DISTINTOS
    const p = PLANTILLAS[idx % PLANTILLAS.length]!;
    const detalle = `case number ${idx.toString(36)} with a fairly long description of what happened on the order ${idx}`;
    const texto = p.replace("{detalle}", detalle);
    items.push({
      customId: `r${i}`,
      request: { model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: texto }] },
    });
  }
  return items;
}

/** Tokens de entrada de un ítem (heuristic, para el informe; la dedup no depende de esto). */
function tokensDe(item: BatchRequest): number {
  return heuristicEstimator.count(item.request.messages.map((m) => m.content).join("\n"));
}

async function medir(n: number, distintos: number) {
  const sin = contador();
  const layerSin = createSavingsLayer({ provider: sin.provider });
  await layerSin.batches.submit(carga(n, distintos));
  const con = contador();
  const layerCon = createSavingsLayer({ provider: con.provider });
  await layerCon.batches.submit(carga(n, distintos), { deduplicate: true });

  const evitadas = sin.lote.lineasRecibidas - con.lote.lineasRecibidas;
  // Tokens de entrada evitados: los de las ejecuciones que no se envían. Con
  // duplicados uniformes, cada ejecución evitada pesa ~ el prompt medio.
  const tokensEvitados = Math.round((evitadas / n) * carga(n, distintos).reduce((s, it) => s + tokensDe(it), 0));
  return {
    items: n,
    distintos,
    tasaDeDuplicados: ((n - distintos) / n).toFixed(3),
    ejecucionesSinDedup: sin.lote.lineasRecibidas,
    ejecucionesConDedup: con.lote.lineasRecibidas,
    ejecucionesEvitadas: evitadas,
    tokensDeEntradaEvitados: tokensEvitados,
  };
}

async function main() {
  const casos = [
    { n: 1000, distintos: 900 },
    { n: 1000, distintos: 700 },
    { n: 1000, distintos: 500 },
  ];
  const filas = [];
  for (const c of casos) filas.push(await medir(c.n, c.distintos));

  const evidencia = {
    titulo: "Dedup intra-lote (submit { deduplicate: true }): ejecuciones evitadas",
    fecha: "2026-11-09",
    metodo:
      "Proveedor de lotes falso que cuenta las líneas de cada submit. Misma carga sintética enviada con deduplicate false y true; la diferencia de líneas es lo que el proveedor deja de ejecutar (y de facturar, a su tarifa de lote). Sin red; determinista.",
    casos: filas,
    lectura:
      "Cada ejecución evitada es una petición que el proveedor no factura. Con un 10% de duplicados se evita el 10% de las ejecuciones y de sus tokens de entrada; con un 30%, el 30%; con un 50%, el 50%. El ahorro es proporcional a la tasa de duplicados de la carga, exactamente, porque la dedup es una identidad (mismo cuerpo → misma respuesta).",
  };
  writeFileSync(join(process.cwd(), "benchmarks/evidencia/dedup-de-lote-2026-11-09.json"), JSON.stringify(evidencia, null, 2) + "\n");
  console.log(JSON.stringify(evidencia, null, 2));
}

main();
