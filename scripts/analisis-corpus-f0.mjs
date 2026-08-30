#!/usr/bin/env node
/**
 * S1 · EL ANÁLISIS DEL CORPUS — lee capturas del espía (~/.bvsala-f0/*.jsonl)
 * y produce las cifras del denominador del plan de la pasarela
 * (docs/PLAN-PASARELA-API-KEY.md, fase S1):
 *
 *   1. Qué fracción de la entrada son salidas de herramientas (tool_result).
 *   2. Cuánto recorta ya el context_management de Anthropic (presencia +
 *      eventos de encogimiento observados entre turnos).
 *   3. La mezcla real de caché: lectura vs escritura 5m vs escritura 1h.
 *   4. La fuga (fast-mode, safety-check de WebFetch): NO computable desde la
 *      captura — ese tráfico no pasa por el proxy; se declara, no se inventa.
 *
 * La salida son SOLO agregados (conteos, bytes, tokens): ningún contenido de
 * prompt sale de la captura. La fracción de tokens se estima calibrando contra
 * el contador REAL del proveedor: tokens_tool_result ≈ tokens_entrada_reales ×
 * (bytes_tool_result / bytes_prompt_total) por petición, sumado sobre todas.
 *
 * Uso:
 *   node scripts/analisis-corpus-f0.mjs [captura.jsonl ...]
 *   (sin argumentos: todas las capturas de ~/.bvsala-f0/)
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bytes serializados de un valor (la misma vara para todos los bloques). */
function bytesDe(valor) {
  return Buffer.byteLength(typeof valor === "string" ? valor : JSON.stringify(valor ?? ""));
}

/**
 * Resumen por tipo de bloque de un cuerpo de /v1/messages. Réplica local del
 * `resumenDeBloques` del espía v2, para poder analizar también capturas v1
 * (que no traen `registro.bloques`).
 */
export function bloquesDe(json) {
  const porTipo = {};
  const anota = (tipo, valor) => {
    const t = (porTipo[tipo] ??= { n: 0, bytes: 0 });
    t.n += 1;
    t.bytes += bytesDe(valor);
  };
  for (const m of json.messages ?? []) {
    if (typeof m.content === "string") anota(`${m.role}:text`, m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) anota(`${m.role}:${b?.type ?? "?"}`, b);
  }
  if (json.system !== undefined) anota("system", json.system);
  if (Array.isArray(json.tools)) for (const t of json.tools) anota("tools", t);
  return {
    mensajes: (json.messages ?? []).length,
    porTipo,
    totalBytes: Object.values(porTipo).reduce((s, t) => s + t.bytes, 0),
  };
}

/** El usage definitivo de un registro: message_delta pisa a message_start, el
 * desglose cache_creation se FUSIONA (misma regla que el ObservadorSse del
 * gateway); para respuestas no-SSE, el usage del JSON del cuerpo. */
export function usageDe(registro) {
  if (registro.sse?.usage?.length) {
    let uso = null;
    for (const { usage } of registro.sse.usage) {
      const cache_creation =
        usage.cache_creation || uso?.cache_creation
          ? { ...uso?.cache_creation, ...usage.cache_creation }
          : undefined;
      uso = { ...uso, ...usage, ...(cache_creation ? { cache_creation } : {}) };
    }
    return uso;
  }
  if (registro.responseBodyBase64 && !registro.sse) {
    try {
      const d = JSON.parse(Buffer.from(registro.responseBodyBase64, "base64").toString("utf8"));
      return d.usage ?? null;
    } catch {}
  }
  return null;
}

/** Tokens de entrada REALES de una petición (contador del proveedor). */
function entradaReal(uso) {
  const escritura =
    uso.cache_creation_input_tokens ??
    (uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return (uso.input_tokens ?? 0) + (uso.cache_read_input_tokens ?? 0) + escritura;
}

/**
 * El análisis entero sobre una lista de registros (de una o varias capturas).
 * Cada registro puede llevar `fichero` (añadido por el lector) para agrupar
 * sesiones: la sesión es (fichero, clientPort); las capturas v1 sin clientPort
 * caen en un solo grupo por fichero.
 */
export function analizar(registros) {
  const mensajes = registros.filter((r) => r.method === "POST" && r.path === "/v1/messages" && r.requestBody?.messages);

  // ── 1 · fracción tool_result ──
  let bytesToolResult = 0;
  let bytesPrompt = 0;
  let tokensEntrada = 0;
  let tokensToolResultEst = 0;
  let conUsage = 0;
  for (const r of mensajes) {
    const b = r.bloques ?? bloquesDe(r.requestBody);
    const tr = Object.entries(b.porTipo)
      .filter(([tipo]) => tipo.endsWith(":tool_result"))
      .reduce((s, [, t]) => s + t.bytes, 0);
    bytesToolResult += tr;
    bytesPrompt += b.totalBytes;
    const uso = usageDe(r);
    if (uso) {
      conUsage += 1;
      const entrada = entradaReal(uso);
      tokensEntrada += entrada;
      if (b.totalBytes > 0) tokensToolResultEst += entrada * (tr / b.totalBytes);
    }
  }

  // ── 2 · context_management ──
  const conConfig = mensajes.filter((r) => r.requestBody.context_management !== undefined).length;
  const sesiones = new Map();
  for (const r of mensajes) {
    const clave = `${r.fichero ?? "?"}·${r.clientPort ?? "?"}`;
    (sesiones.get(clave) ?? sesiones.set(clave, []).get(clave)).push(r);
  }
  let encogimientos = 0;
  let bytesRecortados = 0;
  for (const grupo of sesiones.values()) {
    grupo.sort((a, b) => a.id - b.id);
    for (let i = 1; i < grupo.length; i++) {
      const prev = grupo[i - 1].bloques ?? bloquesDe(grupo[i - 1].requestBody);
      const cur = grupo[i].bloques ?? bloquesDe(grupo[i].requestBody);
      // La conversación creció en turnos pero encogió en bytes → algo recortó
      // historial (context_management u otra poda del cliente).
      if (cur.mensajes >= prev.mensajes && cur.totalBytes < prev.totalBytes) {
        encogimientos += 1;
        bytesRecortados += prev.totalBytes - cur.totalBytes;
      }
    }
  }

  // ── 3 · mezcla de caché ──
  const cache = { lectura: 0, escritura5m: 0, escritura1h: 0, escrituraSinDesglose: 0, entradaSinCache: 0 };
  for (const r of mensajes) {
    const uso = usageDe(r);
    if (!uso) continue;
    cache.lectura += uso.cache_read_input_tokens ?? 0;
    cache.entradaSinCache += uso.input_tokens ?? 0;
    if (uso.cache_creation) {
      cache.escritura5m += uso.cache_creation.ephemeral_5m_input_tokens ?? 0;
      cache.escritura1h += uso.cache_creation.ephemeral_1h_input_tokens ?? 0;
      const total = uso.cache_creation_input_tokens ?? 0;
      const desglosado = (uso.cache_creation.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation.ephemeral_1h_input_tokens ?? 0);
      if (total > desglosado) cache.escrituraSinDesglose += total - desglosado;
    } else {
      cache.escrituraSinDesglose += uso.cache_creation_input_tokens ?? 0;
    }
  }
  const totalCache = cache.lectura + cache.escritura5m + cache.escritura1h + cache.escrituraSinDesglose + cache.entradaSinCache;

  const pct = (x, sobre) => (sobre > 0 ? Math.round((x / sobre) * 1000) / 10 : null);
  return {
    peticiones: registros.length,
    peticionesMessages: mensajes.length,
    peticionesConUsage: conUsage,
    sesiones: sesiones.size,
    rutas: Object.fromEntries(
      [...registros.reduce((m, r) => m.set(`${r.method} ${r.path}`, (m.get(`${r.method} ${r.path}`) ?? 0) + 1), new Map())].sort(),
    ),
    toolResults: {
      bytes: bytesToolResult,
      bytesPromptTotal: bytesPrompt,
      fraccionBytesPct: pct(bytesToolResult, bytesPrompt),
      tokensEntradaReales: tokensEntrada,
      tokensEstimados: Math.round(tokensToolResultEst),
      fraccionTokensPct: pct(tokensToolResultEst, tokensEntrada),
    },
    contextManagement: {
      peticionesConConfig: conConfig,
      encogimientosObservados: encogimientos,
      bytesRecortados,
    },
    mezclaCache: {
      tokens: cache,
      lecturaPct: pct(cache.lectura, totalCache),
      escritura5mPct: pct(cache.escritura5m, totalCache),
      escritura1hPct: pct(cache.escritura1h, totalCache),
      escrituraSinDesglosePct: pct(cache.escrituraSinDesglose, totalCache),
      entradaSinCachePct: pct(cache.entradaSinCache, totalCache),
    },
    fuga: "no computable desde la captura: fast-mode y el safety-check de WebFetch van directos a api.anthropic.com (TERMINALES-DE-CODIFICACION.md:57); cuantificar comparando contra la consola del proveedor",
  };
}

/** Lee una captura .jsonl y devuelve sus registros con `fichero` anotado. */
export function leerCaptura(ruta) {
  return readFileSync(ruta, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ ...JSON.parse(l), fichero: ruta }));
}

const esMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (esMain) {
  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));
  if (!ficheros.length) {
    console.error("[analisis] no hay capturas; graba una con scripts/espia-anthropic.mjs");
    process.exit(1);
  }
  const registros = ficheros.flatMap((f) => leerCaptura(f));
  console.log(`[analisis] ${ficheros.length} captura(s), ${registros.length} peticiones`);
  console.log(JSON.stringify(analizar(registros), null, 2));
}
