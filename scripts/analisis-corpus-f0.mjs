#!/usr/bin/env node
/**
 * S1 · EL ANÁLISIS DEL CORPUS — lee capturas del espía (~/.bvsala-f0/*.jsonl)
 * y produce las cifras del denominador del plan de la pasarela
 * (docs/PLAN-PASARELA-API-KEY.md, fase S1):
 *
 *   1. Qué fracción de la entrada son salidas de herramientas (tool_result).
 *   2. Cuánto recorta el contexto — en DOS libros que no se mezclan: lo que
 *      recorta EL PROVEEDOR (context_management: `applied_edits` declarados en
 *      la RESPUESTA — el cliente sigue enviando el historial entero, el
 *      recorte pasa en el servidor) y lo que poda EL CLIENTE (el historial
 *      enviado encoge entre turnos: poda in situ o compactación/resumen).
 *   3. La mezcla real de caché: lectura vs escritura 5m vs escritura 1h.
 *   4. La fuga (fast-mode, safety-check de WebFetch): NO computable desde la
 *      captura — ese tráfico no pasa por el proxy; se declara, no se inventa.
 *
 * La salida son SOLO agregados (conteos, bytes, tokens): ningún contenido de
 * prompt sale de la captura — ni siquiera en errores (una línea ilegible se
 * cuenta y se salta; jamás se imprime su contenido ni el mensaje del parser).
 *
 * La fracción de tokens se estima calibrando contra el contador REAL del
 * proveedor: tokens_tool_result ≈ tokens_entrada_reales × (bytes_tool_result /
 * bytes_prompt_total) por petición, sumado sobre todas. (El plan citaba el
 * HeuristicEstimator; esta calibración por bytes contra el usage real es más
 * directa — cada petición se calibra con SU contador — y queda declarada aquí
 * y en el plan.)
 *
 * La sesión se correlaciona, por orden de robustez: cabecera
 * `x-claude-code-session-id` (verificada en tráfico real de Claude Code) →
 * hash del primer mensaje de la conversación → clientPort (heurístico débil:
 * los puertos efímeros se reciclan).
 *
 * Uso:
 *   node scripts/analisis-corpus-f0.mjs [captura.jsonl ...]
 *   (sin argumentos: todas las capturas de ~/.bvsala-f0/)
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Bytes serializados de un valor (la misma vara para todos los bloques). */
function bytesDe(valor) {
  return Buffer.byteLength(typeof valor === "string" ? valor : JSON.stringify(valor ?? ""));
}

/**
 * Resumen por tipo de bloque de un cuerpo de /v1/messages. Réplica local del
 * `resumenDeBloques` del espía v2 (mismo blindaje ante entradas malformadas),
 * para poder analizar también capturas v1 que no traen `registro.bloques`.
 */
export function bloquesDe(json) {
  const porTipo = {};
  const anota = (tipo, valor) => {
    const t = (porTipo[tipo] ??= { n: 0, bytes: 0 });
    t.n += 1;
    t.bytes += bytesDe(valor);
  };
  for (const m of Array.isArray(json.messages) ? json.messages : []) {
    if (!m || typeof m !== "object") {
      anota("?:invalido", m);
      continue;
    }
    if (typeof m.content === "string") anota(`${m.role}:text`, m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) anota(`${m.role}:${b?.type ?? "?"}`, b);
  }
  if (json.system !== undefined) anota("system", json.system);
  if (Array.isArray(json.tools)) for (const t of json.tools) anota("tools", t);
  return {
    mensajes: Array.isArray(json.messages) ? json.messages.length : 0,
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
 * Clave de sesión de un registro, por orden de robustez: la cabecera de sesión
 * de Claude Code (+ agent-id si existe: separa subagentes) → hash del primer
 * mensaje (una conversación conserva su primer mensaje; un auto-compact que lo
 * sustituya parte el grupo, limitación declarada) → clientPort.
 */
export function claveDeSesion(registro) {
  const fichero = registro.fichero ?? "?";
  const h = registro.requestHeaders ?? {};
  const sid = h["x-claude-code-session-id"];
  if (sid) return `${fichero}·s:${sid}·a:${h["x-claude-code-agent-id"] ?? ""}`;
  const primero = Array.isArray(registro.requestBody?.messages) ? registro.requestBody.messages[0] : undefined;
  if (primero !== undefined) {
    return `${fichero}·m:${createHash("sha256").update(JSON.stringify(primero)).digest("hex").slice(0, 16)}`;
  }
  return `${fichero}·p:${registro.clientPort ?? "?"}`;
}

/**
 * Ediciones de contexto aplicadas POR EL PROVEEDOR, declaradas en la respuesta
 * (`context_management.applied_edits`, en el JSON de stream:false o en los
 * eventos del SSE grabado). Devuelve null si el registro no trae cuerpo.
 */
export function edicionesDelProveedor(registro) {
  if (!registro.responseBodyBase64) return null;
  const cuerpo = Buffer.from(registro.responseBodyBase64, "base64").toString("utf8");
  const candidatos = [];
  if (registro.sse) {
    for (const linea of cuerpo.split("\n")) {
      if (!linea.startsWith("data: ")) continue;
      try {
        const d = JSON.parse(linea.slice(6));
        const cm = d.context_management ?? d.message?.context_management;
        if (cm) candidatos.push(cm);
      } catch {}
    }
  } else {
    try {
      const d = JSON.parse(cuerpo);
      if (d.context_management) candidatos.push(d.context_management);
    } catch {}
  }
  let edits = 0;
  let clearedInputTokens = 0;
  let clearedToolUses = 0;
  for (const cm of candidatos) {
    for (const e of Array.isArray(cm.applied_edits) ? cm.applied_edits : []) {
      edits += 1;
      for (const [k, v] of Object.entries(e ?? {})) {
        if (typeof v !== "number") continue;
        if (/cleared.*input_tokens/.test(k)) clearedInputTokens += v;
        else if (/cleared.*tool/.test(k)) clearedToolUses += v;
      }
    }
  }
  return { edits, clearedInputTokens, clearedToolUses };
}

/**
 * El análisis entero sobre una lista de registros (de una o varias capturas).
 * Cada registro puede llevar `fichero` (añadido por el lector) para agrupar.
 */
export function analizar(registros) {
  const mensajes = registros.filter(
    (r) => r.method === "POST" && r.path === "/v1/messages" && Array.isArray(r.requestBody?.messages),
  );

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

  // ── 2 · contexto: el proveedor y el cliente, en libros separados ──
  const conConfig = mensajes.filter((r) => r.requestBody.context_management !== undefined).length;
  let respuestasConEdits = 0;
  let editsAplicados = 0;
  let clearedInputTokens = 0;
  let clearedToolUses = 0;
  for (const r of mensajes) {
    const e = edicionesDelProveedor(r);
    if (e && e.edits > 0) {
      respuestasConEdits += 1;
      editsAplicados += e.edits;
      clearedInputTokens += e.clearedInputTokens;
      clearedToolUses += e.clearedToolUses;
    }
  }

  const sesiones = new Map();
  for (const r of mensajes) {
    const clave = claveDeSesion(r);
    (sesiones.get(clave) ?? sesiones.set(clave, []).get(clave)).push(r);
  }
  let podasInSitu = 0;
  let compactaciones = 0;
  let bytesRecortados = 0;
  for (const grupo of sesiones.values()) {
    grupo.sort((a, b) => a.id - b.id);
    for (let i = 1; i < grupo.length; i++) {
      const prev = grupo[i - 1].bloques ?? bloquesDe(grupo[i - 1].requestBody);
      const cur = grupo[i].bloques ?? bloquesDe(grupo[i].requestBody);
      if (cur.totalBytes >= prev.totalBytes) continue;
      // El historial ENVIADO encogió: poda del cliente. Con menos mensajes es
      // una compactación (resumen); con los mismos o más, poda in situ.
      if (cur.mensajes < prev.mensajes) compactaciones += 1;
      else podasInSitu += 1;
      bytesRecortados += prev.totalBytes - cur.totalBytes;
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
    contexto: {
      peticionesConConfig: conConfig,
      proveedor: { respuestasConEdits, editsAplicados, clearedInputTokens, clearedToolUses },
      podaDelCliente: { podasInSitu, compactaciones, bytesRecortados },
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

/**
 * Lee una captura .jsonl con tolerancia: una línea ilegible (espía cortado a
 * mitad de flush) se CUENTA y se salta — jamás tumba el análisis ni se imprime
 * su contenido (ni el mensaje del parser, que incluye fragmentos literales).
 */
export function leerCaptura(ruta) {
  const registros = [];
  let ilegibles = 0;
  for (const linea of readFileSync(ruta, "utf8").split("\n")) {
    if (!linea) continue;
    try {
      registros.push({ ...JSON.parse(linea), fichero: ruta });
    } catch {
      ilegibles += 1;
    }
  }
  return { registros, ilegibles };
}

const esMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
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
  const registros = [];
  let ilegibles = 0;
  for (const f of ficheros) {
    const r = leerCaptura(f);
    registros.push(...r.registros);
    ilegibles += r.ilegibles;
  }
  console.log(
    `[analisis] ${ficheros.length} captura(s), ${registros.length} peticiones` +
      (ilegibles ? ` (${ilegibles} línea(s) ilegible(s) saltada(s))` : ""),
  );
  console.log(JSON.stringify(analizar(registros), null, 2));
}
