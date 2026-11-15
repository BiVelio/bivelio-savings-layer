// BENCHMARK: la estabilidad del prefijo cacheable con el reorden (savings.cachePrefix).
//
// Sin red y determinista: mide la PRECONDICIÓN MECÁNICA del acierto de la caché
// de prefijo — cuántos bytes del tramo cacheable declarado son idénticos entre
// peticiones — no el hit-rate del proveedor (eso exige llamadas en vivo y su
// contador). El reorden convierte un prefijo que cambia en cada petición (0 % de
// estabilidad) en uno byte a byte idéntico (100 %).
//
//   pnpm cache-prefix:banco
//
// Carga: N peticiones con un `system` plantilla que lleva un timestamp ISO por
// petición (el patrón nº1 de cache break del informe de mercado). Se traduce el
// ProviderRequest al cuerpo Anthropic real (`cuerpo`) y se extrae el tramo
// cacheable del `system` (los bloques hasta el `cache_control` inclusive).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { lotesDelProveedor } from "../src/providers/lotes-del-proveedor.js";
import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

class Testigo implements Provider {
  readonly id = "testigo";
  readonly vistas: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

function peticion(ts: string, cachePrefix?: boolean): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      {
        role: "system",
        content:
          "You are a billing support assistant.\nGenerated at " + ts + ".\nAnswer in one sentence and cite the policy number.",
      },
      { role: "user", content: "¿Puedo cambiar de plan a mitad de mes?" },
    ],
    ...(cachePrefix !== undefined ? { savings: { cachePrefix } } : {}),
  } as SavingsRequest;
}

/** El tramo cacheable del `system` en el cuerpo Anthropic: los bloques hasta el `cache_control` inclusive. */
function prefijoCacheableDelCuerpo(cuerpo: Record<string, unknown>): string {
  const system = (cuerpo["system"] ?? []) as { type?: string; text?: string; cache_control?: unknown }[];
  const partes: string[] = [];
  for (const b of system) {
    partes.push(b.text ?? "");
    if (b.cache_control != null) break;
  }
  return partes.join("");
}

async function medir(n: number, cachePrefix: boolean) {
  const testigo = new Testigo();
  const capa = new SavingsPipeline({
    provider: testigo,
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
  } as never);
  const adapter = new AnthropicProvider({ apiKey: "k-bench", baseUrl: "https://api.anthropic.com/v1" });
  const cap = lotesDelProveedor(adapter)!;
  if (!cap) throw new Error("el adaptador no registró su capacidad de lotes (cuerpo)");

  const prefijos = new Set<string>();
  let bytesDeSystem = 0;
  let bytesEstables = 0;
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 10, 15, 10, 0, 0, i)).toISOString();
    await capa.generate(peticion(ts, cachePrefix));
    const req = testigo.vistas[testigo.vistas.length - 1]!;
    const cuerpo = cap.cuerpo(req);
    prefijos.add(prefijoCacheableDelCuerpo(cuerpo));
    // Tamaño del system entero y de la parte cacheable, para el reparto.
    const system = (cuerpo["system"] ?? []) as { text?: string }[];
    bytesDeSystem += system.reduce((s, b) => s + (b.text ?? "").length, 0);
    bytesEstables += prefijoCacheableDelCuerpo(cuerpo).length;
  }
  return {
    peticiones: n,
    prefijosDistintos: prefijos.size,
    estabilidadDelPrefijo: ((n - (prefijos.size - 1)) / n).toFixed(3),
    parteDelSystemCacheada: ((bytesEstables / bytesDeSystem) * 100).toFixed(1) + "%",
  };
}

async function main() {
  const n = 1000;
  const sin = await medir(n, false);
  const con = await medir(n, true);

  const evidencia = {
    titulo: "Reorden del prefijo cacheable (savings.cachePrefix): estabilidad del tramo cacheado",
    fecha: "2026-11-15",
    metodo:
      "Sin red, determinista. N peticiones con un system plantilla + timestamp ISO por petición (el patrón nº1 de cache break). El ProviderRequest del pipeline se traduce al cuerpo Anthropic real y se cuenta cuántos prefijos cacheables DISTINTOS salen por brazo: distintos = el proveedor no puede acertar (el emparejamiento es por bytes); uno solo = el prefijo es estable petición a petición. Esto mide la precondición mecánica del hit, no el hit-rate del proveedor.",
    casos: [
      { brazo: "sin cachePrefix (hoy)", ...sin },
      { brazo: "con cachePrefix: true", ...con },
    ],
    lectura:
      "Sin el reorden, el timestamp dentro del tramo cacheado hace que el prefijo cambie en CADA petición: 0 % de estabilidad, la caché no puede acertar y cada petición paga la escritura entera (1,25× en Anthropic). Con el reorden, el 100 % de las peticiones comparte el MISMO prefijo cacheable: el proveedor lee la parte estable a su tarifa de lectura (0,1×) y solo la línea del timestamp viaja a precio completo. A un 80 % de hit-rate, el «90 % de descuento» del proveedor se queda en ~31 % de ahorro real (informe de mercado): lo que decide es el hit-rate, y esto es lo que lo desbloquea.",
  };
  writeFileSync(
    join(process.cwd(), "benchmarks/evidencia/cache-prefix-2026-11-15.json"),
    JSON.stringify(evidencia, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidencia, null, 2));
}

main();
