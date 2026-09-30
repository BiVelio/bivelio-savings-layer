/**
 * LAS SONDAS EN VIVO PENDIENTES (2026-09-29) — cada arreglo, contra el API de verdad.
 * ---------------------------------------------------------------------------
 * Uso:
 *   npx tsx benchmarks/sondas/sondas.ts   # SECO: sin red (proveedores de mentira), comprueba el cableado
 *   BVSALA_DEV_OPEN=1 tsx --env-file=<ruta>/.env.bench benchmarks/sondas/sondas.ts --vivo
 *   opciones: --solo=bucle,busqueda,diagnostico,gemini,gpt  --caducidad  --salida=dir
 *
 * Qué comprueba cada sonda (el detalle, en su PR y en docs/BITACORA-2026-09-26.md §8):
 *   1 · bucle       (#359, #403) bucle de herramientas nativo de Anthropic —tool_use /
 *                   tool_result, varios pasos, un `isError`— en claude-sonnet-5,
 *                   claude-sonnet-5-5 y claude-haiku-4-5, sin `system`: la capa marca el
 *                   catálogo (#403) y se miden lecturas/escrituras reales de caché y el
 *                   coste frente al MISMO bucle directo al API sin la capa.
 *   2 · busqueda    (#354) búsqueda nativa de herramientas con 120 herramientas en
 *                   claude-haiku-4-5: tres turnos; el 2.º pide la misma herramienta que el
 *                   1.º y no debería volver a buscarla. Contra el mismo diálogo directo
 *                   (la receta oficial: el turno del asistente vuelve tal cual).
 *   3 · diagnostico (#358) `cacheMissDiagnostics`: un fallo de caché PROVOCADO —un byte
 *                   del `system` cambiado en el cable, que el espejo de la capa no ve— y
 *                   se comprueba que Anthropic da el motivo y la capa lo pone en la traza.
 *                   Con `--caducidad`, además, un fallo natural: esperar a que caduque la
 *                   entrada de 5 min.
 *   4 · gemini      (#402) gemini-3.8-flash por la capa: dos turnos con herramientas
 *                   (thought_signature de vuelta), una negativa `content_filter` con un
 *                   prompt inseguro de XSTest (no se guarda ni el prompt ni la respuesta)
 *                   y el coste con pensamiento contra el `usage`.
 *   5 · gpt         (#402) gpt-5.6-sol con herramientas y `reasoningEffort: "none"`, y un
 *                   control sin él (el 400 que motivó el arreglo; no factura).
 *
 * La capa corre desde el FUENTE de esta rama (origin/main, 0.4.32) con
 * `BVSALA_DEV_OPEN=1` en vivo (autorización del dueño) y `devUnlicensed` en seco.
 * Toda llamada —con capa o sin ella— pasa por la red guardada de nucleo.ts: solo
 * los tres hosts oficiales, tope DURO de 5 $ sumando todo, y el coste de cada
 * respuesta según su `usage`. Claves SOLO del entorno del proceso; nunca se
 * imprimen, y el JSON se comprueba contra ellas antes de escribirse.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnthropicProvider,
  BV_SALA_VERSION,
  createSavingsLayer,
  OpenAICompatibleProvider,
  type ChatMessage,
  type SavingsLayer,
  type SavingsLayerConfig,
  type SavingsRequest,
  type SavingsResult,
  type ToolDescriptor,
  type TraceEvent,
} from "../../src/index.js";
import { parsearXSTest, sha256Hex, XSTEST_COMMIT, XSTEST_SHA256 } from "../publicados/xstest/nucleo.js";
import {
  aAnthropic,
  BASE_ANTHROPIC,
  BASE_GEMINI,
  BASE_OPENAI,
  catalogo,
  contieneSecreto,
  crearRed,
  limpiarSecretos,
  Presupuesto,
  PresupuestoAgotado,
  TOPE_TOTAL_USD,
  tokensAprox,
  type Llamada,
  type RedGuardada,
} from "./nucleo.js";
import { MARCADOR_INSEGURO_SECO, redDeMentira } from "./seco.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "../..");

export type NombreDeSonda = "bucle" | "busqueda" | "diagnostico" | "gemini" | "gpt";
export const SONDAS: readonly NombreDeSonda[] = ["bucle", "busqueda", "diagnostico", "gemini", "gpt"];

export interface Opciones {
  vivo: boolean;
  solo: NombreDeSonda[];
  caducidad: boolean;
  salida: string;
  /** Ruta al CSV de XSTest (commit fijado; se comprueba su sha256). */
  xstest?: string;
  /** Tope de gasto de esta tirada (≤ 5 $). */
  tope?: number;
  /** Silencio en consola (tests). */
  callado?: boolean;
}

export type Veredicto = "confirma" | "no-confirma" | "parcial" | "no-concluyente" | "no-corrida";

export interface ResultadoDeSonda {
  sonda: NombreDeSonda;
  arreglos: string[];
  veredicto: Veredicto;
  resumen: string;
  hallazgos: string[];
  datos: Record<string, unknown>;
  gastoUsd: number;
  llamadas: number;
  error?: string;
}

// ── Utilidades ──────────────────────────────────────────────────────────────

const trazas = (r: SavingsResult<unknown> | undefined, etapa: string): TraceEvent[] =>
  (r?.report.traces ?? []).filter((t) => t.stage === etapa);

function red4(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

interface Contexto {
  o: Opciones;
  red: RedGuardada;
  claves: { anthropic?: string; openai?: string; gemini?: string };
  avisos: string[];
  log: (s: string) => void;
}

function capa(ctx: Contexto, provider: SavingsLayerConfig["provider"], extra: Partial<SavingsLayerConfig> = {}): SavingsLayer {
  return createSavingsLayer({
    provider,
    ...(ctx.o.vivo ? {} : { devUnlicensed: true }),
    ...extra,
  } as Parameters<typeof createSavingsLayer>[0]);
}

function anthropic(ctx: Contexto): AnthropicProvider {
  return new AnthropicProvider({ apiKey: ctx.claves.anthropic ?? "seco", fetchImpl: ctx.red.fetch, baseUrl: BASE_ANTHROPIC });
}

async function directoAnthropic(ctx: Contexto, cuerpo: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await ctx.red.fetch(`${BASE_ANTHROPIC}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ctx.claves.anthropic ?? "seco", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function de(ctx: Contexto, sonda: string, brazo?: string): Llamada[] {
  return ctx.red.llamadas.filter((l) => l.sonda === sonda && (brazo === undefined || l.brazo === brazo));
}

function sumaUso(ls: Llamada[]) {
  const s = { llamadas: ls.length, errores: 0, entrada: 0, lecturaCache: 0, escrituraCache: 0, salida: 0, costeUsd: 0 };
  for (const l of ls) {
    if (l.status >= 400) s.errores += 1;
    s.entrada += l.uso?.entrada ?? 0;
    s.lecturaCache += l.uso?.lecturaCache ?? 0;
    s.escrituraCache += (l.uso?.escrituraCache5m ?? 0) + (l.uso?.escrituraCache1h ?? 0);
    s.salida += l.uso?.salida ?? 0;
    s.costeUsd += l.costeUsd;
  }
  s.costeUsd = red4(s.costeUsd);
  return s;
}

/** Resultado de herramienta guionizado: determinista, con UN error la primera vez que se consulta el envío. */
function resultadoDe(nombre: string, args: string, vistos: Map<string, number>): { content: string; isError: boolean } {
  const veces = (vistos.get(nombre) ?? 0) + 1;
  vistos.set(nombre, veces);
  if (nombre.includes("envios") && veces === 1) {
    return { content: "Error: el servicio de envíos no respondió (timeout de 5 s). Reintenta la misma llamada.", isError: true };
  }
  let id = "4417";
  try {
    const a = JSON.parse(args || "{}") as { id?: unknown };
    if (typeof a.id === "string") id = a.id;
  } catch {
    /* argumentos no JSON: se contesta igual */
  }
  const datos: Record<string, unknown> = { herramienta: nombre, id, estado: "ok" };
  if (nombre.includes("pedidos")) Object.assign(datos, { cliente: "C-88", total_centimos: 12990, fecha: "2026-09-20" });
  if (nombre.includes("envios")) Object.assign(datos, { transportista: "Correos", estado_envio: "en reparto", eta: "2026-09-30" });
  if (nombre.includes("facturas")) Object.assign(datos, { factura: "F-2026-0912", importe_centimos: 12990, pagada: true });
  return { content: JSON.stringify(datos), isError: false };
}

// ── 1 · El bucle de herramientas de Anthropic ───────────────────────────────

/** 45 herramientas con descripciones largas: el catálogo supera el mínimo cacheable de los tres modelos (4.096 en Haiku 4.5). */
export const CATALOGO_DEL_BUCLE = catalogo(45, 70);
const PREGUNTA_DEL_BUCLE =
  "Soy agente de soporte. Para el pedido 4417, en este orden y con UNA herramienta por paso: " +
  "1) consulta el pedido (consultar_pedidos), 2) consulta el envío (consultar_envios), " +
  "3) consulta la factura (consultar_facturas). Si una herramienta falla, reinténtala una vez. " +
  "Al final resume en dos frases.";
const PASOS_MAXIMOS = 7;
export const MODELOS_DEL_BUCLE = ["claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-4-5"] as const;

async function bucleConCapa(ctx: Contexto, modelo: string) {
  ctx.red.etiquetar({ sonda: "bucle", brazo: `B:${modelo}` });
  const layer = capa(ctx, anthropic(ctx));
  // El catálogo CRUDO (sin `intents` ni `risk`), como llega de un cliente MCP o de
  // BFCL: la capa lo manda entero y el #403 es justo marcarlo. Con `intents`, el
  // selector poda a unas pocas y el catálogo no llega al mínimo cacheable.
  const tools = CATALOGO_DEL_BUCLE.map(({ id, description, parameters }) => ({ id, description, parameters })) as unknown as ToolDescriptor[];
  const mensajes: ChatMessage[] = [{ role: "user", content: PREGUNTA_DEL_BUCLE }];
  const vistos = new Map<string, number>();
  const pasos: Record<string, unknown>[] = [];
  let costeInforme = 0;
  let final = "";
  let error: string | undefined;
  for (let paso = 1; paso <= PASOS_MAXIMOS; paso++) {
    let r: SavingsResult<unknown>;
    try {
      r = await layer.generate({ model: modelo, messages: mensajes, tools, maxOutputTokens: 600 });
    } catch (e) {
      if (e instanceof PresupuestoAgotado) throw e;
      error = e instanceof Error ? e.message : String(e);
      break;
    }
    costeInforme += r.report.cost.actual;
    const marca = trazas(r, "prefix-cache").map((t) => `${t.outcome}${t.detail?.["boundary"] ? `(${String(t.detail["boundary"])})` : ""}: ${String(t.detail?.["reason"] ?? "").slice(0, 160)}`);
    const historia = trazas(r, "prefix-cache-history").map((t) => t.outcome);
    const seleccion = trazas(r, "tool-selection")[0]?.detail;
    pasos.push({
      paso,
      llamadas: (r.toolCalls ?? []).map((c) => c.name),
      finishReason: r.finishReason,
      costeInforme: red4(r.report.cost.actual),
      cacheProveedor: r.report.tokens.providerCachedInput ?? 0,
      trazaPrefixCache: marca,
      trazaHistoria: historia,
      herramientasSeleccionadas: seleccion?.["selected"] ?? seleccion?.["kept"] ?? null,
    });
    if (!r.toolCalls?.length) {
      final = r.finishReason ?? "";
      break;
    }
    mensajes.push({ role: "assistant", content: r.text ?? "", toolCalls: r.toolCalls });
    for (const c of r.toolCalls) {
      const res = resultadoDe(c.name, c.arguments, vistos);
      mensajes.push({ role: "tool", toolCallId: c.id, name: c.name, content: res.content, ...(res.isError ? { isError: true } : {}) });
    }
  }
  layer.close?.();
  return { pasos, costeInforme: red4(costeInforme), final, error };
}

async function bucleDirecto(ctx: Contexto, modelo: string) {
  ctx.red.etiquetar({ sonda: "bucle", brazo: `A:${modelo}` });
  const tools = aAnthropic(CATALOGO_DEL_BUCLE);
  const mensajes: Record<string, unknown>[] = [{ role: "user", content: PREGUNTA_DEL_BUCLE }];
  const vistos = new Map<string, number>();
  const pasos: Record<string, unknown>[] = [];
  let error: string | undefined;
  for (let paso = 1; paso <= PASOS_MAXIMOS; paso++) {
    const { status, json } = await directoAnthropic(ctx, { model: modelo, max_tokens: 600, tools, messages: mensajes });
    if (status >= 400) {
      error = `HTTP ${status}`;
      break;
    }
    const content = (json["content"] as Record<string, unknown>[]) ?? [];
    const usos = content.filter((b) => b["type"] === "tool_use");
    pasos.push({ paso, llamadas: usos.map((b) => b["name"]), parada: json["stop_reason"] });
    if (usos.length === 0) break;
    mensajes.push({ role: "assistant", content });
    mensajes.push({
      role: "user",
      content: usos.map((b) => {
        const res = resultadoDe(String(b["name"]), JSON.stringify(b["input"] ?? {}), vistos);
        return { type: "tool_result", tool_use_id: b["id"], content: res.content, ...(res.isError ? { is_error: true } : {}) };
      }),
    });
  }
  return { pasos, error };
}

async function sondaBucle(ctx: Contexto): Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">> {
  const porModelo: Record<string, unknown> = {};
  const hallazgos: string[] = [];
  let confirmaBucle = 0;
  let confirmaCache = 0;
  for (const modelo of MODELOS_DEL_BUCLE) {
    ctx.log(`  · bucle ${modelo}: sin capa…`);
    const a = await bucleDirecto(ctx, modelo);
    ctx.log(`  · bucle ${modelo}: con capa…`);
    const b = await bucleConCapa(ctx, modelo);
    const la = de(ctx, "bucle", `A:${modelo}`);
    const lb = de(ctx, "bucle", `B:${modelo}`);
    const ua = sumaUso(la);
    const ub = sumaUso(lb);
    const errores400 = lb.filter((l) => l.status >= 400).map((l) => `${l.status}: ${l.respuesta.error ?? ""}`);
    const conToolUse = lb.filter((l) => l.cuerpo.toolUse > 0).length;
    const conIsError = lb.filter((l) => l.cuerpo.isError > 0).length;
    const marcasEnCatalogo = lb.filter((l) => l.cuerpo.dondeMarcas.some((d) => d.startsWith("tools["))).length;
    const lecturas = lb.map((l) => l.uso?.lecturaCache ?? 0);
    const escrituras = lb.map((l) => (l.uso?.escrituraCache5m ?? 0) + (l.uso?.escrituraCache1h ?? 0));
    const bucleOk = !b.error && errores400.length === 0 && conToolUse > 0 && conIsError > 0;
    const cacheOk = ub.lecturaCache > 0 && marcasEnCatalogo > 0;
    if (bucleOk) confirmaBucle += 1;
    if (cacheOk) confirmaCache += 1;
    const informeVsUsage = ub.costeUsd > 0 ? red4(b.costeInforme / ub.costeUsd) : null;
    porModelo[modelo] = {
      sinCapa: { ...ua, pasos: a.pasos, error: a.error ?? null },
      conCapa: {
        ...ub,
        pasos: b.pasos,
        error: b.error ?? null,
        final: b.final,
        costeSegunElInforme: b.costeInforme,
        informeEntreUsage: informeVsUsage,
        cuerposConToolUse: conToolUse,
        cuerposConIsError: conIsError,
        cuerposConMarcaEnElCatalogo: marcasEnCatalogo,
        dondeMarcasPorPaso: lb.map((l) => l.cuerpo.dondeMarcas),
        lecturasDeCachePorPaso: lecturas,
        escriturasDeCachePorPaso: escrituras,
        errores400,
      },
      ahorroFrenteASinCapaUsd: red4(ua.costeUsd - ub.costeUsd),
      ahorroFrenteASinCapaPct: ua.costeUsd > 0 ? Math.round(((ua.costeUsd - ub.costeUsd) / ua.costeUsd) * 1000) / 10 : null,
      bucleNativo: bucleOk,
      catalogoEnCache: cacheOk,
    };
    if (!bucleOk) hallazgos.push(`${modelo}: el bucle con capa no pasó limpio (${b.error ?? (errores400.join("; ") || `tool_use en ${conToolUse} cuerpos, is_error en ${conIsError}`)}).`);
    if (!cacheOk) hallazgos.push(`${modelo}: ninguna lectura de caché del catálogo (marcas en el catálogo: ${marcasEnCatalogo}/${lb.length}, lecturas ${ub.lecturaCache}).`);
    if (informeVsUsage !== null && Math.abs(informeVsUsage - 1) > 0.02) {
      hallazgos.push(`${modelo}: report.cost.actual (${b.costeInforme} $) ≠ usage×tarifa (${ub.costeUsd} $): cociente ${informeVsUsage}.`);
    }
    if (a.pasos.length !== b.pasos.length) hallazgos.push(`${modelo}: pasos distintos con y sin capa (${a.pasos.length} vs ${b.pasos.length}): el coste compara bucles de distinta longitud.`);
  }
  const n = MODELOS_DEL_BUCLE.length;
  const veredicto: Veredicto = confirmaBucle === n && confirmaCache === n ? "confirma" : confirmaBucle === 0 ? "no-confirma" : "parcial";
  return {
    sonda: "bucle",
    arreglos: ["#359", "#403"],
    veredicto,
    resumen: `bucle nativo limpio en ${confirmaBucle}/${n} modelos; catálogo leído de caché en ${confirmaCache}/${n}.`,
    hallazgos,
    datos: { catalogo: { herramientas: CATALOGO_DEL_BUCLE.length, tokensAprox: tokensAprox(JSON.stringify(aAnthropic(CATALOGO_DEL_BUCLE))) }, porModelo },
  };
}

// ── 2 · La búsqueda nativa entre turnos ─────────────────────────────────────

export const CATALOGO_DE_BUSQUEDA = catalogo(120, 12);
export const MODELO_DE_BUSQUEDA = "claude-haiku-4-5";
const TURNOS_DE_BUSQUEDA = [
  "¿En qué estado está el pedido 4417? Usa la herramienta de consultar pedidos.",
  "¿Y el pedido 5120? Igual que antes.",
  "Ahora lista las facturas del cliente C-88.",
];

async function busquedaConCapa(ctx: Contexto) {
  // La primera petición va con `auto`, etiquetada aparte: si `auto` elige el
  // selector, esa llamada no cuenta en los turnos que se comparan con el brazo A.
  ctx.red.etiquetar({ sonda: "busqueda", brazo: "B-auto" });
  const layer = capa(ctx, anthropic(ctx));
  const tools = CATALOGO_DE_BUSQUEDA as unknown as ToolDescriptor[];
  const mensajes: ChatMessage[] = [];
  const vistos = new Map<string, number>();
  const turnos: Record<string, unknown>[] = [];
  let modo: "auto" | "always" = "auto";
  let error: string | undefined;
  for (const [t, pregunta] of TURNOS_DE_BUSQUEDA.entries()) {
    mensajes.push({ role: "user", content: pregunta });
    const desde = ctx.red.llamadas.length;
    const pasos: Record<string, unknown>[] = [];
    for (let paso = 1; paso <= 4; paso++) {
      let r: SavingsResult<unknown>;
      try {
        r = await layer.generate({ model: MODELO_DE_BUSQUEDA, messages: mensajes, tools, maxOutputTokens: 400, savings: { toolSearch: modo } });
      } catch (e) {
        if (e instanceof PresupuestoAgotado) throw e;
        error = e instanceof Error ? e.message : String(e);
        break;
      }
      const decision = trazas(r, "tool-search").find((x) => x.outcome === "native" || x.outcome === "selector");
      if (t === 0 && paso === 1 && decision?.outcome === "selector" && modo === "auto") {
        // `auto` no la aplicó: se apunta el motivo y se fuerza para poder medir lo que el arreglo cambia.
        turnos.push({ nota: "auto → selector", motivo: decision.detail?.["reason"] ?? null });
        modo = "always";
        ctx.red.etiquetar({ sonda: "busqueda", brazo: "B" });
        paso -= 1;
        continue;
      }
      // `auto` aplicó la búsqueda nativa: esa llamada sí es del brazo B.
      if (ctx.red.llamadas.at(-1)?.brazo === "B-auto") ctx.red.llamadas.at(-1)!.brazo = "B";
      ctx.red.etiquetar({ sonda: "busqueda", brazo: "B" });
      const prov = trazas(r, "tool-search").find((x) => x.outcome === "provider")?.detail ?? {};
      pasos.push({
        paso,
        decision: decision?.outcome ?? null,
        searches: prov["searches"] ?? null,
        loaded: prov["loaded"] ?? [],
        resentResults: prov["resentResults"] ?? 0,
        resentTools: prov["resentTools"] ?? [],
        llamadas: (r.toolCalls ?? []).map((c) => c.name),
      });
      if (!r.toolCalls?.length) {
        mensajes.push({ role: "assistant", content: r.text || "(sin texto)" });
        break;
      }
      mensajes.push({ role: "assistant", content: r.text ?? "", toolCalls: r.toolCalls });
      for (const c of r.toolCalls) {
        const res = resultadoDe(c.name, c.arguments, vistos);
        mensajes.push({ role: "tool", toolCallId: c.id, name: c.name, content: res.content });
      }
    }
    const ls = ctx.red.llamadas.slice(desde).filter((l) => l.brazo !== "B-auto");
    turnos.push({
      turno: t + 1,
      pasos,
      busquedasDelProveedor: ls.reduce((s, l) => s + l.respuesta.busquedas, 0),
      paresReenviadosEnElCable: ls.reduce((s, l) => s + l.cuerpo.paresDeBusquedaReenviados, 0),
      uso: sumaUso(ls),
    });
    if (error) break;
  }
  layer.close?.();
  return { turnos, modo, error };
}

async function busquedaDirecta(ctx: Contexto) {
  ctx.red.etiquetar({ sonda: "busqueda", brazo: "A" });
  const tools = [
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    ...aAnthropic(CATALOGO_DE_BUSQUEDA).map((t) => ({ ...t, defer_loading: true })),
  ];
  const mensajes: Record<string, unknown>[] = [];
  const vistos = new Map<string, number>();
  const turnos: Record<string, unknown>[] = [];
  let error: string | undefined;
  for (const [t, pregunta] of TURNOS_DE_BUSQUEDA.entries()) {
    mensajes.push({ role: "user", content: pregunta });
    const desde = ctx.red.llamadas.length;
    for (let paso = 1; paso <= 4; paso++) {
      const { status, json } = await directoAnthropic(ctx, { model: MODELO_DE_BUSQUEDA, max_tokens: 400, tools, messages: mensajes });
      if (status >= 400) {
        error = `HTTP ${status}`;
        break;
      }
      const content = (json["content"] as Record<string, unknown>[]) ?? [];
      mensajes.push({ role: "assistant", content });
      const usos = content.filter((b) => b["type"] === "tool_use");
      if (usos.length === 0) break;
      mensajes.push({
        role: "user",
        content: usos.map((b) => ({
          type: "tool_result",
          tool_use_id: b["id"],
          content: resultadoDe(String(b["name"]), JSON.stringify(b["input"] ?? {}), vistos).content,
        })),
      });
    }
    const ls = ctx.red.llamadas.slice(desde);
    turnos.push({ turno: t + 1, busquedasDelProveedor: ls.reduce((s, l) => s + l.respuesta.busquedas, 0), uso: sumaUso(ls) });
    if (error) break;
  }
  return { turnos, error };
}

async function sondaBusqueda(ctx: Contexto): Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">> {
  ctx.log("  · búsqueda: sin capa (receta oficial)…");
  const a = await busquedaDirecta(ctx);
  ctx.log("  · búsqueda: con capa…");
  const b = await busquedaConCapa(ctx);
  const tb = b.turnos.filter((x) => "turno" in x) as { turno: number; busquedasDelProveedor: number; paresReenviadosEnElCable: number; pasos: { resentResults: number }[] }[];
  const ta = a.turnos as { turno: number; busquedasDelProveedor: number }[];
  const t2 = tb.find((x) => x.turno === 2);
  const reenviadas = tb.reduce((s, x) => s + x.pasos.reduce((q, p) => q + Number(p.resentResults ?? 0), 0), 0);
  const errores = de(ctx, "busqueda", "B").filter((l) => l.status >= 400).map((l) => `${l.status}: ${l.respuesta.error ?? ""}`);
  const hallazgos: string[] = [];
  const viajan = (t2?.paresReenviadosEnElCable ?? 0) > 0 && reenviadas > 0;
  const noVuelve = t2 !== undefined && t2.busquedasDelProveedor === 0;
  if (!viajan) hallazgos.push(`turno 2: pares reenviados en el cable ${t2?.paresReenviadosEnElCable ?? "—"}, resentResults en la traza ${reenviadas}.`);
  if (t2 && !noVuelve) hallazgos.push(`turno 2: el modelo volvió a buscar (${t2.busquedasDelProveedor} búsquedas) aunque la herramienta ya estaba cargada.`);
  if (errores.length) hallazgos.push(`errores del API con capa: ${errores.join("; ")}`);
  if (b.error) hallazgos.push(`la capa lanzó: ${b.error}`);
  if (b.modo === "always") hallazgos.push("`toolSearch: \"auto\"` eligió el selector con 120 herramientas; la sonda forzó `\"always\"` (el motivo está en los datos).");
  const veredicto: Veredicto = viajan && noVuelve && !errores.length ? "confirma" : viajan || noVuelve ? "parcial" : "no-confirma";
  return {
    sonda: "busqueda",
    arreglos: ["#354"],
    veredicto,
    resumen:
      `búsquedas por turno con capa ${tb.map((x) => x.busquedasDelProveedor).join("/")} ` +
      `vs sin capa ${ta.map((x) => x.busquedasDelProveedor).join("/")}; pares reenviados en el turno 2: ${t2?.paresReenviadosEnElCable ?? "—"}.`,
    hallazgos,
    datos: {
      modelo: MODELO_DE_BUSQUEDA,
      herramientas: CATALOGO_DE_BUSQUEDA.length,
      modo: b.modo,
      conCapa: { turnos: b.turnos, total: sumaUso(de(ctx, "busqueda", "B")), error: b.error ?? null },
      llamadaDeAutoConSelector: sumaUso(de(ctx, "busqueda", "B-auto")),
      sinCapa: { turnos: a.turnos, total: sumaUso(de(ctx, "busqueda", "A")), error: a.error ?? null },
    },
  };
}

// ── 3 · El diagnóstico de caché ─────────────────────────────────────────────

export const MODELO_DEL_DIAGNOSTICO = "claude-sonnet-5-5";
/** Un `system` de ~1.500 tokens: por encima del mínimo cacheable de Sonnet 5.5 (512). */
export const SYSTEM_DEL_DIAGNOSTICO = [
  "Eres el asistente de soporte de una tienda en línea. Normas de la casa:",
  ...Array.from({ length: 40 }, (_, i) =>
    `${i + 1}. ${["Responde en español neutro y en frases cortas.", "Nunca inventes números de pedido ni importes.", "Si falta un dato, pídelo en una sola pregunta.", "Las devoluciones se aceptan hasta 30 días después de la entrega con el embalaje original.", "Los envíos a Canarias, Ceuta y Melilla tienen aranceles que paga el cliente.", "No prometas plazos que el transportista no haya confirmado.", "Deriva a una persona cualquier reclamación de más de 500 euros.", "Cita siempre la política aplicable por su número."][i % 8]} (sección ${Math.floor(i / 8) + 1}, revisión 2026-09).`,
  ),
  "Fin de las normas.",
].join("\n");
const PREGUNTAS_DEL_DIAGNOSTICO = [
  "¿Puedo devolver unas zapatillas que recibí hace 12 días?",
  "¿Quién paga los aranceles de un envío a Tenerife?",
  "¿Me podéis confirmar que llega mañana?",
  "Tengo una reclamación de 800 euros, ¿qué hago?",
  "¿Cuánto tiempo tengo para devolver un pedido?",
];

/** Un byte del `system` cambiado en el cable: el último carácter del primer bloque. */
export function tocarUnByteDelSystem(cuerpo: Record<string, unknown>): Record<string, unknown> | undefined {
  const s = cuerpo["system"];
  const cambiar = (t: string) => t.slice(0, -1) + (t.endsWith(".") ? "!" : ".");
  if (typeof s === "string" && s.length > 0) return { ...cuerpo, system: cambiar(s) };
  if (Array.isArray(s) && s.length > 0) {
    const [primero, ...resto] = s as Record<string, unknown>[];
    if (typeof primero?.["text"] === "string") return { ...cuerpo, system: [{ ...primero, text: cambiar(primero["text"] as string) }, ...resto] };
  }
  return undefined;
}

async function sondaDiagnostico(ctx: Contexto): Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">> {
  const layer = capa(ctx, anthropic(ctx), { cacheBreakpoints: "auto", cacheMissDiagnostics: true });
  const peticiones: Record<string, unknown>[] = [];
  const tocadas = new Set<number>([3]);
  const esperas = new Map<number, number>();
  if (ctx.o.caducidad) esperas.set(5, ctx.o.vivo ? 6 * 60_000 : 0);
  let error: string | undefined;
  for (const [i, pregunta] of PREGUNTAS_DEL_DIAGNOSTICO.entries()) {
    const k = i + 1;
    if (k === 5 && !ctx.o.caducidad) break;
    const espera = esperas.get(k);
    if (espera) {
      ctx.log(`  · diagnóstico: esperando ${Math.round(espera / 60_000)} min a que caduque la entrada…`);
      await new Promise((r) => setTimeout(r, espera));
    }
    ctx.red.etiquetar({ sonda: "diagnostico", brazo: `B:${k}`, ...(tocadas.has(k) ? { tocarCuerpo: tocarUnByteDelSystem } : {}) });
    ctx.log(`  · diagnóstico: petición ${k}${tocadas.has(k) ? " (un byte del system cambiado en el cable)" : ""}…`);
    let r: SavingsResult<unknown>;
    try {
      r = await layer.generate({
        model: MODELO_DEL_DIAGNOSTICO,
        messages: [
          { role: "system", content: SYSTEM_DEL_DIAGNOSTICO },
          { role: "user", content: pregunta },
        ],
        maxOutputTokens: 120,
      });
    } catch (e) {
      if (e instanceof PresupuestoAgotado) throw e;
      error = e instanceof Error ? e.message : String(e);
      break;
    }
    const l = de(ctx, "diagnostico", `B:${k}`).at(-1);
    peticiones.push({
      peticion: k,
      tocada: tocadas.has(k),
      trasCaducidad: esperas.has(k),
      diagnosticsEnElCuerpo: l?.cuerpo.diagnostics ?? null,
      diagnosticsEnLaRespuesta: l?.respuesta.diagnostics ?? null,
      idDelProveedor: l?.respuesta.id ?? null,
      lecturaCache: l?.uso?.lecturaCache ?? 0,
      escrituraCache: (l?.uso?.escrituraCache5m ?? 0) + (l?.uso?.escrituraCache1h ?? 0),
      marcas: l?.cuerpo.dondeMarcas ?? [],
      trazaColocacion: trazas(r, "prefix-cache-placement").map((t) => ({ outcome: t.outcome, detail: t.detail })),
    });
  }
  ctx.red.etiquetar({ sonda: "diagnostico", brazo: "-" });
  layer.close?.();
  const p3 = peticiones.find((p) => p["peticion"] === 3);
  const motivo3 = (p3?.["trazaColocacion"] as { outcome: string; detail?: Record<string, unknown> }[] | undefined)?.find((t) => t.outcome === "verified")?.detail;
  const respuesta3 = p3?.["diagnosticsEnLaRespuesta"] as { cache_miss_reason?: { type?: string } } | null | undefined;
  const hallazgos: string[] = [];
  const pidio = peticiones.some((p) => p["diagnosticsEnElCuerpo"] != null);
  const anthropicExplica = typeof respuesta3?.cache_miss_reason?.type === "string";
  const enLaTraza = typeof motivo3?.["cacheMissReason"] === "string";
  if (!pidio) hallazgos.push("ningún cuerpo llevó `diagnostics`: la capa no pidió comparar.");
  if (pidio && !(p3?.["diagnosticsEnElCuerpo"] as { previous_message_id?: unknown } | null)?.previous_message_id) {
    hallazgos.push("la petición 3 no llevó `previous_message_id`: el espejo no predijo una lectura que comprobar.");
  }
  if (!anthropicExplica) hallazgos.push(`Anthropic no dio un motivo en la petición 3 (diagnostics = ${JSON.stringify(respuesta3 ?? null)}).`);
  if (anthropicExplica && !enLaTraza) hallazgos.push("Anthropic dio el motivo pero la traza `prefix-cache-placement` no lo lleva.");
  if (error) hallazgos.push(`la capa lanzó: ${error}`);
  const veredicto: Veredicto = anthropicExplica && enLaTraza ? "confirma" : pidio ? "parcial" : "no-confirma";
  return {
    sonda: "diagnostico",
    arreglos: ["#358"],
    veredicto,
    resumen: `motivo de Anthropic en la petición tocada: ${respuesta3?.cache_miss_reason?.type ?? "ninguno"}; en la traza de la capa: ${String(motivo3?.["cacheMissReason"] ?? "ninguno")}.`,
    hallazgos,
    datos: { modelo: MODELO_DEL_DIAGNOSTICO, systemTokensAprox: tokensAprox(SYSTEM_DEL_DIAGNOSTICO), peticiones, error: error ?? null },
  };
}

// ── 4 · Gemini por la capa ──────────────────────────────────────────────────

export const MODELO_GEMINI = "gemini-3.8-flash";
const HERRAMIENTAS_DEL_TIEMPO: ToolDescriptor[] = [
  {
    id: "tiempo_actual",
    description: "Devuelve el tiempo actual de una ciudad: temperatura en grados Celsius y estado del cielo.",
    intents: ["tiempo", "clima", "temperatura"],
    risk: "read",
    parameters: { type: "object", properties: { ciudad: { type: "string", description: "Nombre de la ciudad" } }, required: ["ciudad"] },
  },
];
/** Prompts inseguros de XSTest que dieron `content_filter` en A y en B en la tirada de gama alta (#398/#396). */
export const IDS_INSEGUROS_XSTEST = [83, 129, 26, 35, 87, 96, 135, 136, 48, 232];

function leerXSTest(ruta: string | undefined): { prompts: Map<number, string>; ruta: string } | null {
  const candidatas = [ruta, join(RAIZ, "node_modules", ".cache", "bvsala-xstest", `xstest_prompts-${XSTEST_COMMIT.slice(0, 12)}.csv`)].filter(
    (x): x is string => typeof x === "string",
  );
  for (const c of candidatas) {
    if (!existsSync(c)) continue;
    const texto = readFileSync(c, "utf8");
    if (sha256Hex(texto) !== XSTEST_SHA256) continue;
    const prompts = new Map<number, string>();
    for (const p of parsearXSTest(texto)) if (p.label === "unsafe") prompts.set(p.id, p.prompt);
    return { prompts, ruta: c };
  }
  return null;
}

async function sondaGemini(ctx: Contexto): Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">> {
  const provider = new OpenAICompatibleProvider({ baseUrl: BASE_GEMINI, apiKey: ctx.claves.gemini ?? "seco", fetchImpl: ctx.red.fetch });
  const hallazgos: string[] = [];

  // a) Dos turnos con herramientas.
  ctx.log("  · gemini: dos turnos con herramientas…");
  ctx.red.etiquetar({ sonda: "gemini", brazo: "herramientas" });
  const layer = capa(ctx, provider);
  const mensajes: ChatMessage[] = [];
  const pasos: Record<string, unknown>[] = [];
  const costes: { informe: number; usage: number; usageSinPensamiento: number }[] = [];
  let errorHerr: string | undefined;
  for (const pregunta of ["¿Qué tiempo hace ahora en Madrid?", "¿Y en Oslo?"]) {
    mensajes.push({ role: "user", content: pregunta });
    for (let paso = 1; paso <= 3; paso++) {
      const desde = ctx.red.llamadas.length;
      let r: SavingsResult<unknown>;
      try {
        r = await layer.generate({ model: MODELO_GEMINI, messages: mensajes, tools: HERRAMIENTAS_DEL_TIEMPO, maxOutputTokens: 1024 });
      } catch (e) {
        if (e instanceof PresupuestoAgotado) throw e;
        errorHerr = e instanceof Error ? e.message : String(e);
        break;
      }
      const ls = ctx.red.llamadas.slice(desde);
      const u = sumaUso(ls);
      const sinPensamiento = ls.reduce((s, l) => s + (l.uso?.salidaSinPensamiento ?? l.uso?.salida ?? 0), 0);
      const pensamiento = ls.reduce((s, l) => s + (l.uso?.razonamiento ?? 0), 0);
      costes.push({ informe: r.report.cost.actual, usage: u.costeUsd, usageSinPensamiento: red4(u.costeUsd - ((pensamiento / 1000) * 0.00375)) });
      pasos.push({
        pregunta: mensajes.filter((m) => m.role === "user").length,
        paso,
        llamadas: (r.toolCalls ?? []).map((c) => c.name),
        firmaEnLaRespuesta: (r.toolCalls ?? []).filter((c) => c.extraContent != null).length,
        extraContentReenviadoEnElCable: ls.reduce((s, l) => s + l.cuerpo.extraContentReenviado, 0),
        toolCallsReenviadasEnElCable: ls.reduce((s, l) => s + l.cuerpo.toolCallsReenviadas, 0),
        promptCacheKeyEnElCable: ls.some((l) => l.cuerpo.campos.includes("prompt_cache_key")),
        status: ls.map((l) => l.status),
        tokensDePensamiento: pensamiento,
        salidaSinPensamiento: sinPensamiento,
        costeInforme: red4(r.report.cost.actual),
        costeUsage: u.costeUsd,
      });
      if (!r.toolCalls?.length) {
        mensajes.push({ role: "assistant", content: r.text || "(sin texto)" });
        break;
      }
      mensajes.push({ role: "assistant", content: r.text ?? "", toolCalls: r.toolCalls });
      for (const c of r.toolCalls) {
        mensajes.push({ role: "tool", toolCallId: c.id, name: c.name, content: JSON.stringify({ ciudad: c.arguments, temperatura_c: 14, cielo: "nuboso" }) });
      }
    }
    if (errorHerr) break;
  }
  layer.close?.();
  const lh = de(ctx, "gemini", "herramientas");
  const errores400 = lh.filter((l) => l.status >= 400).map((l) => `${l.status}: ${l.respuesta.error ?? ""}`);
  const firmasDeVuelta = lh.reduce((s, l) => s + l.cuerpo.extraContentReenviado, 0);
  const segundoTurnoOk = !errorHerr && errores400.length === 0 && firmasDeVuelta > 0;
  if (!segundoTurnoOk) hallazgos.push(`herramientas: ${errorHerr ?? errores400.join("; ")} (firmas devueltas en el cable: ${firmasDeVuelta}).`);
  const informe = costes.reduce((s, c) => s + c.informe, 0);
  const usage = costes.reduce((s, c) => s + c.usage, 0);
  const costeCuadra = usage > 0 && Math.abs(informe / usage - 1) <= 0.02;
  if (usage > 0 && !costeCuadra) hallazgos.push(`coste: report.cost.actual ${red4(informe)} $ vs usage×tarifa con pensamiento ${red4(usage)} $.`);

  // b) Negativa `content_filter` con un prompt inseguro de XSTest.
  ctx.log("  · gemini: negativa con un prompt inseguro de XSTest…");
  const negativa: Record<string, unknown> = {};
  const xs = ctx.o.vivo ? leerXSTest(ctx.o.xstest) : null;
  const candidatos: { id: number; prompt: string }[] = ctx.o.vivo
    ? IDS_INSEGUROS_XSTEST.flatMap((id) => (xs?.prompts.get(id) ? [{ id, prompt: xs.prompts.get(id)! }] : []))
    : [{ id: 0, prompt: MARCADOR_INSEGURO_SECO }];
  if (ctx.o.vivo && !xs) {
    negativa["omitida"] = "no se encontró el CSV de XSTest con el sha256 fijado (pasa --xstest=ruta)";
  }
  const layerN = capa(ctx, provider);
  for (const c of candidatos.slice(0, 10)) {
    ctx.red.etiquetar({ sonda: "gemini", brazo: `negativa:${c.id}`, sensible: true });
    try {
      const req: SavingsRequest = { model: MODELO_GEMINI, messages: [{ role: "user", content: c.prompt }], maxOutputTokens: 160 };
      const r1 = await layerN.generate(req);
      const antes = ctx.red.llamadas.length;
      const r2 = await layerN.generate(req);
      const volvioAlProveedor = ctx.red.llamadas.length > antes;
      const intento = {
        xstestId: c.id,
        finishReason: r1.finishReason ?? null,
        refusal: r1.refusal != null,
        largoDelTexto: (r1.text ?? "").length,
        cacheDeLaRepeticion: r2.report.cache.result,
        repeticionVolvioAlProveedor: volvioAlProveedor,
        referenciaEnLaRepeticion: !!r2.report.cache.reference,
        ahorroNetoDeLaRepeticion: r2.report.cost.netSavingsRatio,
        costeUsage: red4(de(ctx, "gemini", `negativa:${c.id}`).reduce((s, l) => s + l.costeUsd, 0)),
      };
      (negativa["intentos"] = (negativa["intentos"] as unknown[] | undefined) ?? []);
      (negativa["intentos"] as unknown[]).push(intento);
      if (String(r1.finishReason ?? "").startsWith("content_filter")) {
        negativa["provocada"] = true;
        negativa["bienTratada"] = intento.repeticionVolvioAlProveedor && !intento.referenciaEnLaRepeticion && intento.cacheDeLaRepeticion !== "exact";
        break;
      }
    } catch (e) {
      if (e instanceof PresupuestoAgotado) throw e;
      negativa["error"] = e instanceof Error ? e.message.slice(0, 200) : String(e);
      break;
    }
  }
  layerN.close?.();
  if (negativa["provocada"] && !negativa["bienTratada"]) hallazgos.push("negativa content_filter: la repetición no volvió al proveedor o se acreditó como referencia.");
  if (!negativa["provocada"]) hallazgos.push("negativa content_filter: no se pudo provocar con los prompts elegidos (no concluyente, no un fallo).");

  const negOk = negativa["provocada"] === true && negativa["bienTratada"] === true;
  const veredicto: Veredicto =
    segundoTurnoOk && costeCuadra && (negOk || !negativa["provocada"]) ? (negOk ? "confirma" : "parcial") : segundoTurnoOk || costeCuadra ? "parcial" : "no-confirma";
  return {
    sonda: "gemini",
    arreglos: ["#402"],
    veredicto,
    resumen:
      `dos turnos con herramientas ${segundoTurnoOk ? "sin error" : "con error"} (firmas devueltas: ${firmasDeVuelta}); ` +
      `coste informe/usage ${usage > 0 ? red4(informe / usage) : "—"}; negativa ${negativa["provocada"] ? (negOk ? "provocada y bien tratada" : "provocada y MAL tratada") : "no provocada"}.`,
    hallazgos,
    datos: { modelo: MODELO_GEMINI, herramientas: { pasos, errores400, error: errorHerr ?? null }, coste: { informe: red4(informe), usage: red4(usage) }, negativa },
  };
}

// ── 5 · gpt-5.6-sol con herramientas ────────────────────────────────────────

export const MODELO_GPT = "gpt-5.6-sol";

async function sondaGpt(ctx: Contexto): Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">> {
  const provider = new OpenAICompatibleProvider({ baseUrl: BASE_OPENAI, apiKey: ctx.claves.openai ?? "seco", fetchImpl: ctx.red.fetch });
  const hallazgos: string[] = [];
  // Control: sin `reasoningEffort` (lo que la capa hacía antes de #402). Un 400 no factura.
  ctx.log("  · gpt: control sin reasoningEffort…");
  ctx.red.etiquetar({ sonda: "gpt", brazo: "control" });
  const control: Record<string, unknown> = {};
  const layerC = capa(ctx, provider);
  try {
    const r = await layerC.generate({ model: MODELO_GPT, messages: [{ role: "user", content: "¿Qué tiempo hace en Lisboa?" }], tools: HERRAMIENTAS_DEL_TIEMPO, maxOutputTokens: 300 });
    control["resultado"] = { finishReason: r.finishReason ?? null, llamadas: (r.toolCalls ?? []).map((c) => c.name) };
  } catch (e) {
    if (e instanceof PresupuestoAgotado) throw e;
    control["error"] = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  layerC.close?.();
  control["status"] = de(ctx, "gpt", "control").map((l) => l.status);

  ctx.log("  · gpt: bucle con reasoningEffort none…");
  ctx.red.etiquetar({ sonda: "gpt", brazo: "none" });
  const layer = capa(ctx, provider);
  const mensajes: ChatMessage[] = [{ role: "user", content: "¿Qué tiempo hace en Lisboa? Usa la herramienta." }];
  const pasos: Record<string, unknown>[] = [];
  let informe = 0;
  let error: string | undefined;
  for (let paso = 1; paso <= 3; paso++) {
    let r: SavingsResult<unknown>;
    try {
      r = await layer.generate({ model: MODELO_GPT, messages: mensajes, tools: HERRAMIENTAS_DEL_TIEMPO, maxOutputTokens: 300, reasoningEffort: "none" });
    } catch (e) {
      if (e instanceof PresupuestoAgotado) throw e;
      error = e instanceof Error ? e.message : String(e);
      break;
    }
    informe += r.report.cost.actual;
    pasos.push({ paso, llamadas: (r.toolCalls ?? []).map((c) => c.name), finishReason: r.finishReason ?? null, costeInforme: red4(r.report.cost.actual) });
    if (!r.toolCalls?.length) break;
    mensajes.push({ role: "assistant", content: r.text ?? "", toolCalls: r.toolCalls });
    for (const c of r.toolCalls) mensajes.push({ role: "tool", toolCallId: c.id, name: c.name, content: '{"temperatura_c":19,"cielo":"despejado"}' });
  }
  layer.close?.();
  const ln = de(ctx, "gpt", "none");
  const u = sumaUso(ln);
  const conEsfuerzo = ln.filter((l) => l.cuerpo.reasoningEffort === "none").length;
  const errores400 = ln.filter((l) => l.status >= 400).map((l) => `${l.status}: ${l.respuesta.error ?? ""}`);
  const bucleOk = !error && errores400.length === 0 && conEsfuerzo === ln.length && ln.length >= 2;
  if (!bucleOk) hallazgos.push(`bucle: ${error ?? errores400.join("; ")} (reasoning_effort none en ${conEsfuerzo}/${ln.length} cuerpos).`);
  const costeCuadra = u.costeUsd > 0 && Math.abs(informe / u.costeUsd - 1) <= 0.02;
  if (u.costeUsd > 0 && !costeCuadra) hallazgos.push(`coste: report.cost.actual ${red4(informe)} $ vs usage×tarifa ${u.costeUsd} $.`);
  const controlFallo = Array.isArray(control["status"]) && (control["status"] as number[]).some((s) => s >= 400);
  if (!controlFallo) hallazgos.push("control: sin reasoningEffort NO dio 400 (el requisito que motivó #402 ya no se reproduce o cambió).");
  return {
    sonda: "gpt",
    arreglos: ["#402"],
    veredicto: bucleOk ? (costeCuadra ? "confirma" : "parcial") : "no-confirma",
    resumen: `bucle de ${pasos.length} pasos con reasoning_effort "none" ${bucleOk ? "sin error" : "con error"}; control sin él: HTTP ${(control["status"] as number[]).join(",") || "—"}.`,
    hallazgos,
    datos: { modelo: MODELO_GPT, control, bucle: { pasos, uso: u, costeInforme: red4(informe), error: error ?? null, errores400 } },
  };
}

// ── La tirada ───────────────────────────────────────────────────────────────

export interface Tirada {
  fecha: string;
  modo: "vivo" | "seco";
  commit: string | null;
  paquete: { version: string; como: string };
  topeUsd: number;
  gastoTotalUsd: number;
  gastoPorSonda: Record<string, number>;
  hostsVistos: Record<string, number>;
  hostsBloqueados: Record<string, number>;
  sondas: ResultadoDeSonda[];
  avisosDeLaCapa: string[];
  llamadas: Llamada[];
  /** Cada tirada que contribuyó a este informe, con su gasto REAL (también el de las sondas que otra tirada sustituyó). */
  tiradas?: { fecha: string; sondas: string[]; gastoUsd: number }[];
  /** La suma de `tiradas`: lo que de verdad se gastó para producir este informe. */
  gastoAcumuladoUsd?: number;
  /** Lectura humana de la tirada (se escribe a mano tras mirar los datos; `renderizar` la pone arriba). */
  conclusiones?: string[];
}

function commitActual(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: RAIZ, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

export async function correrSondas(o: Opciones): Promise<Tirada> {
  if (o.vivo && process.env["BVSALA_DEV_OPEN"] !== "1") throw new Error("en vivo la capa corre con BVSALA_DEV_OPEN=1 (autorización del dueño)");
  const claves = {
    anthropic: process.env["BVSALA_DEMO_ANTHROPIC_API_KEY"],
    openai: process.env["BVSALA_DEMO_API_KEY"],
    gemini: process.env["BVSALA_SONDA_API_KEY"],
  };
  if (o.vivo) {
    const faltan = Object.entries({ BVSALA_DEMO_ANTHROPIC_API_KEY: claves.anthropic, BVSALA_DEMO_API_KEY: claves.openai, BVSALA_SONDA_API_KEY: claves.gemini })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (faltan.length) throw new Error(`faltan variables en el entorno: ${faltan.join(", ")}`);
  }
  const presupuesto = new Presupuesto(o.tope ?? TOPE_TOTAL_USD);
  const base = o.vivo ? globalThis.fetch.bind(globalThis) : redDeMentira();
  const red = crearRed(base, presupuesto);
  const avisos: string[] = [];
  const secretos = Object.values(claves).filter((x): x is string => !!x);
  const log = (s: string) => {
    if (!o.callado) console.log(limpiarSecretos(s, secretos));
  };
  const ctx: Contexto = { o, red, claves, avisos, log };

  // Nada sale de este proceso sin pasar por la guarda: tampoco lo que la capa
  // pudiera mandar por su cuenta (licencias, medición).
  const fetchOriginal = globalThis.fetch;
  const warnOriginal = console.warn;
  globalThis.fetch = red.fetch;
  console.warn = (...a: unknown[]) => {
    avisos.push(limpiarSecretos(a.map(String).join(" "), secretos).slice(0, 400));
  };
  const resultados: ResultadoDeSonda[] = [];
  const correr: Record<NombreDeSonda, (c: Contexto) => Promise<Omit<ResultadoDeSonda, "gastoUsd" | "llamadas">>> = {
    bucle: sondaBucle,
    busqueda: sondaBusqueda,
    diagnostico: sondaDiagnostico,
    gemini: sondaGemini,
    gpt: sondaGpt,
  };
  const ARREGLOS: Record<NombreDeSonda, string[]> = { bucle: ["#359", "#403"], busqueda: ["#354"], diagnostico: ["#358"], gemini: ["#402"], gpt: ["#402"] };
  try {
    for (const s of o.solo) {
      log(`\n▶ sonda ${s}`);
      try {
        const r = await correr[s](ctx);
        resultados.push({ ...r, gastoUsd: red4(presupuesto.porSonda[s] ?? 0), llamadas: de(ctx, s).length });
      } catch (e) {
        resultados.push({
          sonda: s,
          arreglos: ARREGLOS[s],
          veredicto: "no-concluyente",
          resumen: "la sonda no terminó",
          hallazgos: [],
          datos: {},
          gastoUsd: red4(presupuesto.porSonda[s] ?? 0),
          llamadas: de(ctx, s).length,
          error: limpiarSecretos(e instanceof Error ? e.message : String(e), secretos).slice(0, 400),
        });
        if (e instanceof PresupuestoAgotado) break;
      }
      log(`  = ${resultados.at(-1)!.veredicto} · ${resultados.at(-1)!.resumen} · ${resultados.at(-1)!.gastoUsd} $`);
    }
  } finally {
    globalThis.fetch = fetchOriginal;
    console.warn = warnOriginal;
  }
  return {
    fecha: new Date().toISOString(),
    modo: o.vivo ? "vivo" : "seco",
    commit: commitActual(),
    paquete: {
      version: BV_SALA_VERSION,
      como: o.vivo
        ? "fuente de origin/main (0.4.32, con #401 #402 #403) vía tsx, BVSALA_DEV_OPEN=1"
        : "fuente de esta rama vía tsx, devUnlicensed, proveedores de mentira (seco.ts)",
    },
    topeUsd: presupuesto.tope,
    gastoTotalUsd: red4(presupuesto.gastado),
    gastoPorSonda: Object.fromEntries(Object.entries(presupuesto.porSonda).map(([k, v]) => [k, red4(v)])),
    hostsVistos: red.hostsVistos,
    hostsBloqueados: red.hostsBloqueados,
    sondas: resultados,
    avisosDeLaCapa: [...new Set(avisos)],
    llamadas: red.llamadas,
  };
}

// ── El informe ──────────────────────────────────────────────────────────────

/** Mezcla una tirada parcial (`--solo`) con la anterior: las sondas corridas sustituyen a las suyas. */
export function mezclar(previa: Tirada | null, nueva: Tirada): Tirada {
  const esta = { fecha: nueva.fecha, sondas: nueva.sondas.map((s) => s.sonda), gastoUsd: nueva.gastoTotalUsd };
  if (!previa || previa.modo !== nueva.modo) return { ...nueva, tiradas: [esta], gastoAcumuladoUsd: nueva.gastoTotalUsd };
  const tiradas = [...(previa.tiradas ?? [{ fecha: previa.fecha, sondas: previa.sondas.map((s) => s.sonda), gastoUsd: previa.gastoTotalUsd }]), esta];
  const corridas = new Set(nueva.sondas.map((s) => s.sonda));
  const sondas = [...previa.sondas.filter((s) => !corridas.has(s.sonda)), ...nueva.sondas].sort(
    (a, b) => SONDAS.indexOf(a.sonda) - SONDAS.indexOf(b.sonda),
  );
  const llamadas = [...previa.llamadas.filter((l) => !corridas.has(l.sonda as NombreDeSonda)), ...nueva.llamadas];
  const gastoPorSonda: Record<string, number> = {};
  for (const s of sondas) gastoPorSonda[s.sonda] = s.gastoUsd;
  const suma = (a: Record<string, number>, b: Record<string, number>) => {
    const r = { ...a };
    for (const [k, v] of Object.entries(b)) r[k] = (r[k] ?? 0) + v;
    return r;
  };
  return {
    ...nueva,
    sondas,
    llamadas,
    gastoPorSonda,
    gastoTotalUsd: red4(Object.values(gastoPorSonda).reduce((s, v) => s + v, 0)),
    hostsVistos: suma(previa.hostsVistos, nueva.hostsVistos),
    hostsBloqueados: suma(previa.hostsBloqueados, nueva.hostsBloqueados),
    avisosDeLaCapa: [...new Set([...previa.avisosDeLaCapa, ...nueva.avisosDeLaCapa])],
    ...(previa.conclusiones ? { conclusiones: previa.conclusiones } : {}),
    tiradas,
    gastoAcumuladoUsd: red4(tiradas.reduce((s, x) => s + x.gastoUsd, 0)),
  };
}

export function renderizar(t: Tirada): string {
  const L: string[] = [];
  L.push(`# Sondas en vivo — ${t.fecha.slice(0, 10)}`);
  L.push("");
  L.push(
    `Modo **${t.modo}** · capa ${t.paquete.version} (${t.paquete.como}) · commit \`${t.commit?.slice(0, 7) ?? "—"}\` · ` +
      `tope de la última tirada ${t.topeUsd} $ (tope duro en código: ${TOPE_TOTAL_USD} $) · **gasto de las sondas que quedan en el informe ${t.gastoTotalUsd.toFixed(4)} $** (usage × tarifa de lista, sumando con y sin capa).`,
  );
  L.push("");
  if (t.tiradas && t.tiradas.length > 1) {
    L.push(
      `Este informe junta ${t.tiradas.length} tiradas (${t.tiradas.map((x) => `${x.sondas.join("+")}: ${x.gastoUsd.toFixed(4)} $`).join(" · ")}); ` +
        `**gasto real acumulado ${(t.gastoAcumuladoUsd ?? 0).toFixed(4)} $**, contando las sondas repetidas cuya primera tirada se sustituyó.`,
    );
    L.push("");
  }
  L.push(`Hosts vistos: ${Object.entries(t.hostsVistos).map(([h, n]) => `\`${h}\` ×${n}`).join(", ") || "ninguno"}. Bloqueados: ${Object.entries(t.hostsBloqueados).map(([h, n]) => `\`${h}\` ×${n}`).join(", ") || "ninguno"}.`);
  L.push("");
  if (t.conclusiones?.length) {
    L.push("## Conclusiones");
    L.push("");
    for (const c of t.conclusiones) L.push(`- ${c}`);
    L.push("");
  }
  L.push("| Sonda | Arreglos | Veredicto | Qué pasó | Llamadas | Gasto |");
  L.push("|---|---|---|---|---|---|");
  for (const s of t.sondas) {
    L.push(`| ${s.sonda} | ${s.arreglos.join(" ")} | **${s.veredicto}** | ${(s.error ? `error: ${s.error}` : s.resumen).replace(/\|/g, "\\|")} | ${s.llamadas} | ${s.gastoUsd.toFixed(4)} $ |`);
  }
  L.push("");
  for (const s of t.sondas) {
    L.push(`## ${s.sonda} (${s.arreglos.join(", ")}) — ${s.veredicto}`);
    L.push("");
    L.push(s.error ? `Error: ${s.error}` : s.resumen);
    L.push("");
    if (s.hallazgos.length) {
      L.push("Hallazgos:");
      for (const h of s.hallazgos) L.push(`- ${h}`);
      L.push("");
    }
    if (s.sonda === "bucle") {
      const pm = (s.datos["porModelo"] ?? {}) as Record<string, Record<string, Record<string, unknown> | unknown>>;
      L.push("| Modelo | Pasos A/B | Coste sin capa | Coste con capa | Δ | Lecturas de caché B (por paso) | Escrituras B (por paso) | Marcas en el catálogo | is_error en el cable | informe/usage |");
      L.push("|---|---|---|---|---|---|---|---|---|---|");
      for (const [m, d] of Object.entries(pm)) {
        const a = d["sinCapa"] as Record<string, unknown>;
        const b = d["conCapa"] as Record<string, unknown>;
        L.push(
          `| ${m} | ${(a["pasos"] as unknown[]).length}/${(b["pasos"] as unknown[]).length} | ${a["costeUsd"]} $ | ${b["costeUsd"]} $ | ${d["ahorroFrenteASinCapaPct"] ?? "—"} % | ${(b["lecturasDeCachePorPaso"] as number[]).join(" · ")} | ${(b["escriturasDeCachePorPaso"] as number[]).join(" · ")} | ${b["cuerposConMarcaEnElCatalogo"]}/${b["llamadas"]} | ${b["cuerposConIsError"]} | ${b["informeEntreUsage"] ?? "—"} |`,
        );
      }
      L.push("");
    }
    if (s.sonda === "busqueda") {
      const cc = s.datos["conCapa"] as { turnos: Record<string, unknown>[]; total: Record<string, unknown> } | undefined;
      const sc = s.datos["sinCapa"] as { turnos: Record<string, unknown>[]; total: Record<string, unknown> } | undefined;
      if (cc && sc) {
        L.push("| Turno | Búsquedas sin capa | Búsquedas con capa | Pares reenviados (cable, con capa) | Entrada+caché sin capa | Entrada+caché con capa |");
        L.push("|---|---|---|---|---|---|");
        const tb = cc.turnos.filter((x) => "turno" in x);
        for (const x of tb) {
          const y = sc.turnos.find((z) => z["turno"] === x["turno"]);
          const ux = x["uso"] as Record<string, number>;
          const uy = y?.["uso"] as Record<string, number> | undefined;
          L.push(
            `| ${x["turno"]} | ${y?.["busquedasDelProveedor"] ?? "—"} | ${x["busquedasDelProveedor"]} | ${x["paresReenviadosEnElCable"]} | ${uy ? uy["entrada"]! + uy["lecturaCache"]! + uy["escrituraCache"]! : "—"} | ${ux["entrada"]! + ux["lecturaCache"]! + ux["escrituraCache"]!} |`,
          );
        }
        L.push("");
        L.push(`Total sin capa: ${sc.total["costeUsd"]} $ · con capa: ${cc.total["costeUsd"]} $.`);
        L.push("");
      }
    }
    if (s.sonda === "diagnostico") {
      L.push("| Petición | Tocada | diagnostics (cuerpo) | diagnostics (respuesta) | Lectura / escritura de caché | Traza `prefix-cache-placement` |");
      L.push("|---|---|---|---|---|---|");
      for (const p of (s.datos["peticiones"] as Record<string, unknown>[] | undefined) ?? []) {
        const tr = (p["trazaColocacion"] as { outcome: string; detail?: Record<string, unknown> }[])
          .map((x) => `${x.outcome}${x.detail?.["cacheMissReason"] ? ` (${String(x.detail["cacheMissReason"])})` : ""}${x.detail?.["confirmed"] !== undefined ? ` confirmed=${String(x.detail["confirmed"])}` : ""}`)
          .join("; ");
        L.push(
          `| ${p["peticion"]}${p["trasCaducidad"] ? " (tras caducar)" : ""} | ${p["tocada"] ? "sí (1 byte del system)" : "no"} | \`${JSON.stringify(p["diagnosticsEnElCuerpo"])}\` | \`${JSON.stringify(p["diagnosticsEnLaRespuesta"])}\` | ${p["lecturaCache"]} / ${p["escrituraCache"]} | ${tr || "—"} |`,
        );
      }
      L.push("");
    }
    if (s.sonda === "gemini" || s.sonda === "gpt") {
      L.push("```json");
      L.push(JSON.stringify(s.datos, null, 2));
      L.push("```");
      L.push("");
    }
  }
  if (t.avisosDeLaCapa.length) {
    L.push("## Avisos de la capa");
    L.push("");
    for (const a of t.avisosDeLaCapa) L.push(`- ${a.replace(/\n/g, " ")}`);
    L.push("");
  }
  L.push("## Método");
  L.push("");
  L.push(
    "Cada llamada —con capa y sin ella— pasa por la red guardada de `benchmarks/sondas/nucleo.ts`: solo `api.anthropic.com`, " +
      "`api.openai.com` y `generativelanguage.googleapis.com` por https; ninguna empieza si su peor caso no cabe en el tope duro; " +
      "el gasto es el `usage` de cada respuesta a la tarifa de lista del catálogo de la capa (escritura de caché a 1,25×, " +
      "pensamiento de Gemini como salida). No se guarda texto de respuesta; de la negativa de XSTest, solo el id del prompt. " +
      "El JSON lleva el resumen de cada cuerpo y cada respuesta (`llamadas`). Reproducir: ver la cabecera de `benchmarks/sondas/sondas.ts`.",
  );
  L.push("");
  return L.join("\n");
}

export function escribir(t: Tirada, salida: string, secretos: readonly string[]): { json: string; md: string } {
  mkdirSync(salida, { recursive: true });
  const rutaJson = join(salida, "sondas.json");
  const rutaMd = join(salida, "sondas.md");
  let previa: Tirada | null = null;
  if (existsSync(rutaJson)) {
    try {
      previa = JSON.parse(readFileSync(rutaJson, "utf8")) as Tirada;
    } catch {
      previa = null;
    }
  }
  const final = mezclar(previa, t);
  const json = limpiarSecretos(JSON.stringify(final, null, 2), secretos);
  const md = limpiarSecretos(renderizar(final), secretos);
  if (contieneSecreto(json, secretos) || contieneSecreto(md, secretos)) throw new Error("el informe contiene una clave: no se escribe");
  writeFileSync(rutaJson, json + "\n");
  writeFileSync(rutaMd, md);
  return { json: rutaJson, md: rutaMd };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argumento(nombre: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a?.slice(nombre.length + 3);
}

async function main(): Promise<void> {
  const vivo = process.argv.includes("--vivo");
  const solo = (argumento("solo")?.split(",").filter(Boolean) as NombreDeSonda[] | undefined) ?? [...SONDAS];
  for (const s of solo) if (!SONDAS.includes(s)) throw new Error(`sonda desconocida: ${s}`);
  const salida = argumento("salida") ?? (vivo ? join(RAIZ, "docs", "benchmarks", "2026-09-29") : join(RAIZ, "node_modules", ".cache", "bvsala-sondas", "seco"));
  const tope = argumento("tope") ? Number(argumento("tope")) : undefined;
  const o: Opciones = { vivo, solo, caducidad: process.argv.includes("--caducidad"), salida, xstest: argumento("xstest"), ...(tope ? { tope } : {}) };
  const t = await correrSondas(o);
  const secretos = [process.env["BVSALA_DEMO_ANTHROPIC_API_KEY"], process.env["BVSALA_DEMO_API_KEY"], process.env["BVSALA_SONDA_API_KEY"]].filter((x): x is string => !!x);
  const rutas = escribir(t, salida, secretos);
  console.log(`\nGasto de esta tirada: ${t.gastoTotalUsd} $ (tope ${t.topeUsd} $). Hosts: ${JSON.stringify(t.hostsVistos)}; bloqueados: ${JSON.stringify(t.hostsBloqueados)}`);
  console.log(`Escrito: ${rutas.json}\n         ${rutas.md}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
