/**
 * LA SONDA: CÉNTIMOS PARA NO TIRAR DÓLARES.
 * ---------------------------------------------------------------------------
 * `pnpm ab:sonda`. Antes de una tirada de pago contra los modelos de 2026, una
 * llamada mínima por modelo (y dos más donde hay modo de caché explícito)
 * comprueba lo que haría inservible la tirada entera:
 *
 *   (a) que las credenciales y el id del modelo valen, que el proveedor acepta
 *       el cuerpo que arma el adaptador (`max_tokens`, el muestreo del banco) y
 *       qué contadores devuelve (`cached_tokens`, `cache_write_tokens`,
 *       `reasoning_tokens`, `cache_creation_input_tokens`);
 *   (b) solo en GPT-5.6+/GPT-6: si `prompt_cache_options` LLEGA al proveedor.
 *       Misma petición con un prefijo estable largo, con sal distinta: una en
 *       modo implícito (B0) y otra en explícito sin breakpoint (lo que hace el
 *       reescritor de B2). Si la implícita escribe caché y la explícita no, el
 *       modo se honra; si las dos escriben, el endpoint no lo reenvía (¿la
 *       pasarela?) y el brazo B2 no sería lo que dice ser.
 *
 * Imprime su techo ANTES de gastar y exige `BVSALA_AB_BUDGET_USD`. Escribe
 * `out/sonda.json` (en inglés: se puede enseñar). Nunca imprime cabeceras,
 * claves ni URLs: solo el host del endpoint y el texto de error del proveedor,
 * recortado.
 */
import { conAjustesNativos, tieneModoDeCacheExplicito, type PlanNativo } from "./nativo.js";
import { precioYPrima, usoCrudo, costeDeLlamada } from "./coste.js";
import { configDesdeEntorno, modoDe, resolverModelos } from "./modelos.js";
import { conSalDeFrio, politicaEstable, familiaDeModelo, muestreoPareadoPara } from "./scenarios.js";
import { endpointDeModelo, fetchConPlazo, proveedorDelBanco, sinSecretos } from "./transporte.js";
import { writeReport } from "./report.js";
import { registrarTokenizadorExacto, TokenizerRegistry } from "../src/index.js";
import type { ProviderRequest, ProviderResponse } from "../src/providers/types.js";

const env = process.env;
const cfg = configDesdeEntorno(env);
const mode = modoDe(cfg);
const resolucion = resolverModelos(env);
const presupuesto = Number(env["BVSALA_AB_BUDGET_USD"] ?? NaN);
/** Tope de salida de la sonda: basta para ver el estado HTTP y los contadores. */
const TOPE_SALIDA = 16;

const registro = new TokenizerRegistry();
await registrarTokenizadorExacto(registro);
const tokens = (texto: string, modelo: string): number => registro.count(texto, { model: modelo });

/** Lo que devuelve el proveedor, sin nada que no se pueda enseñar. */
interface LlamadaDeSonda {
  ok: boolean;
  /** Texto de error del proveedor, recortado. Nunca cabeceras ni claves. */
  error?: string;
  servedModel?: string | null;
  finishReason?: string | undefined;
  usageFields?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  costUsd?: number;
}

/** Los nombres de los campos de `usage` (y de sus desgloses) presentes en la respuesta cruda. */
function camposDeUso(raw: unknown): string[] {
  const usage = (raw as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(usage)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k2 of Object.keys(v as Record<string, unknown>)) out.push(`${k}.${k2}`);
    } else {
      out.push(k);
    }
  }
  return out.sort();
}

/** El error del proveedor, sin nada con forma de clave y recortado. */
const recortar = (s: string): string => {
  const limpio = sinSecretos(s);
  return limpio.length > 400 ? `${limpio.slice(0, 400)}…` : limpio;
};

async function llamar(modelo: string, peticion: ProviderRequest, plan?: PlanNativo): Promise<LlamadaDeSonda> {
  const base = fetchConPlazo();
  const proveedor = proveedorDelBanco(modelo, { ...cfg, fetchImpl: plan ? conAjustesNativos(plan, base) : base });
  let resp: ProviderResponse;
  try {
    resp = await proveedor.generate(peticion);
  } catch (err) {
    return { ok: false, error: recortar(err instanceof Error ? err.message : String(err)) };
  }
  const crudo = usoCrudo(resp.raw);
  const { precio, prima } = precioYPrima(modelo);
  const escrituras = resp.usage.cacheWriteInputTokens ?? (crudo.escrituraInformada ? crudo.escrituraCache : null);
  const m = (resp.raw as { model?: unknown } | undefined)?.model;
  return {
    ok: true,
    servedModel: typeof m === "string" ? m : null,
    finishReason: resp.finishReason,
    usageFields: camposDeUso(resp.raw),
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
    cachedInputTokens: resp.usage.cachedInputTokens ?? null,
    cacheWriteTokens: escrituras,
    reasoningTokens: crudo.razonamiento ?? null,
    costUsd: costeDeLlamada(precio, prima, resp.usage, escrituras ?? 0),
  };
}

/**
 * La petición mínima con la forma de B0: mensajes tal cual, tope de salida y el
 * MISMO muestreo que la tirada (`muestreoPareadoPara`). Si el proveedor rechaza
 * `max_tokens` o `temperature`, la sonda lo ve aquí y no a mitad de la tirada.
 */
function peticionMinima(modelo: string): ProviderRequest {
  return {
    model: modelo,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    maxOutputTokens: TOPE_SALIDA,
    ...muestreoPareadoPara(modelo),
  };
}

/** La petición del sondeo de caché: el prefijo estable largo del banco, con sal propia. */
function peticionDeCache(modelo: string, sal: string): ProviderRequest {
  const conSal = conSalDeFrio(
    {
      model: modelo,
      messages: [
        { role: "system", content: politicaEstable },
        { role: "user", content: "Reply with the single word OK." },
      ],
    },
    sal,
  );
  return {
    model: modelo,
    messages: conSal.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens: TOPE_SALIDA,
    ...muestreoPareadoPara(modelo),
  };
}

/** El plan de la sonda (b): modo explícito SIN breakpoint, nada más. */
function planExplicitoSinBreakpoint(modelo: string): PlanNativo {
  return {
    modelo,
    transporte: "openai-compatible",
    simulado: false,
    degradadoPorTransporte: false,
    decisiones: [],
    cable: { openai: { promptCacheMode: "explicit" } },
  };
}

/** El techo de la sonda para un modelo: entrada a la prima de escritura, salida al tope. */
function techoDe(modelo: string): number {
  const { precio, prima } = precioYPrima(modelo);
  const llamada = (texto: string): number =>
    (tokens(texto, modelo) / 1000) * precio.inputPer1k * Math.max(1, prima) + (TOPE_SALIDA / 1000) * precio.outputPer1k;
  let t = llamada(peticionMinima(modelo).messages.map((x) => x.content).join("\n"));
  if (tieneModoDeCacheExplicito(modelo)) {
    t += 2 * llamada(peticionDeCache(modelo, "techo").messages.map((x) => x.content).join("\n"));
  }
  return t;
}

async function main(): Promise<void> {
  console.log("\nBV-SALA bench probe (pnpm ab:sonda)");
  if (resolucion.error) {
    console.error(`✗ ${resolucion.error}`);
    process.exitCode = 1;
    return;
  }
  if (mode !== "LIVE") {
    console.error(
      "✗ no endpoint declared: there is nothing to probe. Declare BVSALA_DEMO_BASE_URL (gateway) or a per-family " +
        "endpoint (BVSALA_DEMO_OPENAI_BASE_URL, BVSALA_DEMO_ANTHROPIC_BASE_URL, BVSALA_DEMO_GOOGLE_BASE_URL) in .env.bench.",
    );
    process.exitCode = 1;
    return;
  }
  const modelos = resolucion.modelos.filter((m): m is string => m !== null);
  if (modelos.length === 0) {
    console.error("✗ no model to probe: set BVSALA_AB_PRESET=2026, BVSALA_DEMO_MODELS or BVSALA_DEMO_MODEL.");
    process.exitCode = 1;
    return;
  }

  // ── El precio ANTES de gastarlo ──
  const techos = modelos.map((m) => ({ modelo: m, techo: techoDe(m), conocido: precioYPrima(m).conocido }));
  const techo = techos.reduce((n, t) => n + t.techo, 0);
  console.log("Probe ceiling (input at the cache-write premium, output at the cap):");
  for (const t of techos) {
    console.log(`  ${t.modelo.padEnd(34)} $${t.techo.toFixed(6)}${t.conocido ? "" : "   (illustrative price: no catalogue row)"}`);
  }
  console.log(`  ${"TOTAL".padEnd(34)} $${techo.toFixed(6)}`);
  if (!(Number.isFinite(presupuesto) && presupuesto > 0)) {
    console.error("\n✗ BVSALA_AB_BUDGET_USD is mandatory for the probe too. Set it to the ceiling above, rounded up.");
    process.exitCode = 1;
    return;
  }
  if (techo > presupuesto) {
    console.error(`\n✗ the probe can cost up to $${techo.toFixed(6)} and the budget is $${presupuesto}. Nothing was called.`);
    process.exitCode = 1;
    return;
  }

  const informe: Record<string, unknown>[] = [];
  let fallos = 0;
  for (const modelo of modelos) {
    const e = endpointDeModelo(modelo, cfg);
    if (!e || e.transporte === "mock") {
      informe.push({ model: modelo, ok: false, error: `no endpoint declared for the ${familiaDeModelo(modelo)} family` });
      fallos++;
      console.log(`✗ ${modelo}: no endpoint for its family`);
      continue;
    }
    const minima = await llamar(modelo, peticionMinima(modelo));
    const fila: Record<string, unknown> = {
      model: modelo,
      transport: e.transporte,
      endpointHost: e.host,
      minimalRequest: minima,
    };
    if (!minima.ok) fallos++;
    if (minima.ok && tieneModoDeCacheExplicito(modelo)) {
      const nonce = Date.now().toString(36);
      const implicita = await llamar(modelo, peticionDeCache(modelo, `sonda-imp-${nonce}`));
      const explicita = await llamar(
        modelo,
        peticionDeCache(modelo, `sonda-exp-${nonce}`),
        planExplicitoSinBreakpoint(modelo),
      );
      const wImp = implicita.cacheWriteTokens;
      const wExp = explicita.cacheWriteTokens;
      // true = el modo llega; false = el explícito escribió igual; null = no observable.
      const honrado =
        !implicita.ok || !explicita.ok || wImp == null || wExp == null || wImp === 0 ? null : wExp === 0;
      fila["cacheModeProbe"] = { implicit: implicita, explicitNoBreakpoint: explicita, promptCacheModeHonored: honrado };
      if (honrado === false || !implicita.ok || !explicita.ok) fallos++;
    }
    informe.push(fila);
    const campos = minima.usageFields?.join(", ") ?? "";
    console.log(
      minima.ok
        ? `✓ ${modelo} via ${e.transporte} (${e.host}) served ${String(minima.servedModel)}; usage: ${campos}`
        : `✗ ${modelo} via ${e.transporte} (${e.host}): ${minima.error}`,
    );
    const sonda = fila["cacheModeProbe"] as { promptCacheModeHonored: boolean | null } | undefined;
    if (sonda) console.log(`    promptCacheModeHonored: ${String(sonda.promptCacheModeHonored)}`);
  }

  const gastado = informe.reduce((n, f) => {
    const llamadas = [f["minimalRequest"], (f["cacheModeProbe"] as Record<string, unknown> | undefined)?.["implicit"],
      (f["cacheModeProbe"] as Record<string, unknown> | undefined)?.["explicitNoBreakpoint"]];
    return n + llamadas.reduce<number>((m, l) => m + ((l as LlamadaDeSonda | undefined)?.costUsd ?? 0), 0);
  }, 0);
  const ruta = writeReport("sonda", {
    generatedAt: new Date().toISOString(),
    note:
      "Bench probe: one minimal request per model and, on GPT-5.6+/GPT-6, an implicit vs explicit-without-breakpoint " +
      "cache pair. promptCacheModeHonored: true = the explicit mode reached the provider; false = it wrote cache anyway " +
      "(the endpoint does not forward prompt_cache_options); null = not observable. Provider errors are quoted, truncated.",
    ceilingUsd: techo,
    budgetUsd: presupuesto,
    spentUsd: gastado,
    models: informe,
  });
  console.log(`\nspent ≈ $${gastado.toFixed(6)}   wrote ${ruta}`);
  if (fallos > 0) {
    console.error(`✗ ${fallos} check(s) failed: fix them before paying for a run (see the README, «Probe before you pay»).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(sinSecretos(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
