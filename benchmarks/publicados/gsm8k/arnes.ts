/**
 * `pnpm bench:gsm8k` — batería pública GSM8K: caché exacta, caché semántica y
 * compresión, A/B contra el proveedor directo, SIN PERDER EXACTITUD.
 *
 *   --seco                 sin red: proveedor falso en todos los brazos (lo que corre la CI)
 *   --sin-red              solo la repetición sin red sobre el split de test entero
 *   --modelos a,b          por defecto los cuatro de la batería
 *   --n-unicos N           tope de problemas únicos por modelo (por defecto 100)
 *   --presupuesto USD      tope DURO por modelo, todos los brazos juntos (máximo 0,80 en OpenAI y 1,25 en Anthropic)
 *   --mismo-flujo-que F    fija los únicos de cada modelo a los del artefacto F (misma semilla ⇒ el
 *                          MISMO flujo, petición a petición) y compara con él; la caja sigue mandando
 *   --brazos A,B,S,E       por defecto los cuatro (ver DESCRIPCION_DE_BRAZOS en medir.ts)
 *   --docs                 escribe docs/benchmarks/2026-09-28/gsm8k-0431.{json,md} (el nombre sale de la versión)
 *   --sufijo S             con --docs, escribe gsm8k-0431-S.{json,md} (p. ej. `claude`) y no pisa la tirada sin sufijo
 *
 * Las claves se leen SOLO del entorno (`tsx --env-file=…`) y solo se pasan al
 * adaptador: nada de aquí imprime cabeceras, URLs completas ni configuración de
 * clientes, y todo texto de error pasa por `sinSecretos` antes de guardarse.
 *
 *   --desde-fuente         brazos con capa desde el FUENTE de la etiqueta sin licencia en vez del paquete de npm (ver capa.ts)
 *
 * SOBRE «LA CAPA» (0.4.31 desde el 2026-09-28; la tirada de la 0.4.30 es gsm8k.{json,md}). Por defecto el brazo B carga el paquete PUBLICADO de
 * npm (verificado por sha256) con `BIVELIO_LICENSE_KEY`; sin esa variable la
 * tirada LIVE aborta antes de la primera llamada de pago (`capa.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { InMemorySemanticCache, Provider, SavingsRequest } from "../../../src/index.js";
import type { ProviderRequest, ProviderResponse } from "../../../src/providers/types.js";
import { BV_SALA_VERSION } from "../../../src/version.js";
import { construirBrazoNaive } from "../../brazos.js";
import { costeDeLlamada, escriturasDeLlamada, precioYPrima } from "../../coste.js";
import { configDesdeEntorno } from "../../modelos.js";
import { muestreoPareadoPara } from "../../scenarios.js";
import { mulberry32 } from "../../stats.js";
import { endpointDeModelo, fetchConPlazo, proveedorDelBanco, sinSecretos, type ConfigDeTransporte } from "../../transporte.js";
import { fabricaDeCapa, PAQUETE_NPM, SinLicencia, type FabricaDeCapa } from "./capa.js";
import { comparar, type ArtefactoComparable, type Comparacion0430 } from "./comparar.js";
import { escribirDocumento } from "./documento.js";
import {
  construirFlujo,
  ejemplosFewShot,
  extraerNumeroFinal,
  mensajeDeUsuario,
  mismaCifra,
  systemPrompt,
  type Flujo,
  type Peticion,
} from "./flujo.js";
import {
  asegurarDatos,
  DIR_SALIDA_GSM8K,
  FUENTE_GSM8K_TEST,
  FUENTE_GSM8K_TRAIN,
  GSM8K_COMMIT,
  leerSplit,
  type FilaGsm8k,
} from "./fuente.js";
import { DESCRIPCION_DE_BRAZOS, desgloseDelAhorro, resumir, type Brazo, type DesgloseDeBrazo, type Ensayo, type Resumen } from "./medir.js";
import { CONFIGS_SIN_RED, JUEZ_ID, juezNumerico, preguntasSinRed, repetirSinRed, type ResultadoSinRed } from "./sin-red.js";

export const MODELOS_DE_LA_BATERIA = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-4o-mini",
  "openai/gpt-5.4-mini",
] as const;
export const TOPE_DURO_POR_MODELO_USD = 1.25;
/** Tope DURO de un modelo de OpenAI, todos los brazos juntos (decisión del 2026-09-28 para la tirada 0.4.31). */
export const TOPE_DURO_OPENAI_USD = 0.8;
export function topeDuroPara(model: string): number {
  return model.startsWith("openai/") ? TOPE_DURO_OPENAI_USD : TOPE_DURO_POR_MODELO_USD;
}
/** Los proveedores y, solo para los datos de GSM8K (verificados por sha256), raw.githubusercontent.com. */
export const HOSTS_PERMITIDOS: readonly string[] = ["api.openai.com", "api.anthropic.com", "raw.githubusercontent.com"];
export const SEMILLA = 20260928;
export const FECHA = "2026-09-28";

/** De dónde sale el código del brazo B (comprobado el 2026-09-28; ver capa.ts). */
export function procedencia(origen: FabricaDeCapa["origen"]) {
  return {
    paquete: PAQUETE_NPM.nombre,
    version: BV_SALA_VERSION,
    npmLatest: PAQUETE_NPM.version,
    npmIntegrity: PAQUETE_NPM.integrity,
    tarballSha256: PAQUETE_NPM.tarballSha256,
    distIndexSha256: PAQUETE_NPM.distIndexSha256,
    commitDelFuente: `${PAQUETE_NPM.commit} (${PAQUETE_NPM.etiqueta}, chore(release): ${PAQUETE_NPM.version})`,
    origen,
    modo:
      origen === "npm"
        ? "the published npm tarball (npm pack, sha256-verified), licensed offline with BIVELIO_LICENSE_KEY; no licenseServerUrl, no metering"
        : `${PAQUETE_NPM.etiqueta} (source of the tag, BVSALA_DEV_OPEN=1, devUnlicensed: true; npm = same commit, verified identical): ` +
          `\`git diff ${PAQUETE_NPM.etiqueta} -- src/ packages/\` only touches a comment and VERSION_MINIMA_REFERENCIA in src/version.ts, which the bundle does not contain; ` +
          `\`pnpm build\` of this tree and of \`git archive ${PAQUETE_NPM.etiqueta}\` both give a dist/index.js with the npm tarball's sha256`,
  };
}

/**
 * El tope de salida: 1024 tokens, el MISMO en todos los brazos. Hasta la 0.4.30
 * un tope solo viajaba dentro de un `OutputContract` (que exige `schema`) y la
 * tirada de la 0.4.30 fue sin tope. La 0.4.31 (#381) acepta
 * `SavingsRequest.maxOutputTokens` en texto libre y, contra api.openai.com, lo
 * manda como `max_completion_tokens` (gpt-5.x rechaza `max_tokens`). El brazo A
 * lo lleva en su `ProviderRequest`, por el mismo adaptador.
 *
 * Por qué 1024: la salida más larga de la tirada 0.4.30 (sin tope) fue 957 tokens
 * en gpt-4o-mini y 391 en gpt-5.4-mini (p99: 572 y 207). Con 1024 ninguna de
 * aquellas respuestas se habría cortado, así que el tope no cambia lo que se
 * compara con la 0.4.30 y sí baja la peor llamada que la caja reserva (4096 → 1024).
 */
export const TOPE_DE_SALIDA = 1024;
export function topeDeSalida(_model: string): number | null {
  return TOPE_DE_SALIDA;
}
/** Para la caja: el peor caso de salida de una llamada sin tope declarado. */
export const SALIDA_PEOR_CASO = 4096;

// ─── Proveedores del banco: reintentos 429/5xx y contador de gasto ───────────

export class PresupuestoAgotado extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PresupuestoAgotado";
  }
}

const REINTENTABLE = /^provider (429|500|502|503|504|529)\b/;
const PAUSAS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

/** Reintenta con espera creciente lo que el proveedor no cobró: 429 y 5xx, y los fallos de red. */
export function conReintentos(p: Provider, dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Provider {
  return {
    id: p.id,
    async generate(req, opts) {
      for (let i = 0; ; i++) {
        try {
          return await p.generate(req, opts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const red = /fetch failed|socket hang up|timeout|ECONNRESET/i.test(msg);
          if (i >= PAUSAS_MS.length || !(REINTENTABLE.test(msg) || red)) throw err;
          await dormir(PAUSAS_MS[i]! * (1 + Math.random() * 0.25));
        }
      }
    },
  };
}

export interface Contador {
  coste: number;
  llamadas: number;
  entrada: number;
  cacheada: number;
  escrita: number;
  salida: number;
  ultimoFinish?: string;
}
const contadorNuevo = (): Contador => ({ coste: 0, llamadas: 0, entrada: 0, cacheada: 0, escrita: 0, salida: 0 });

export interface Caja {
  tope: number;
  gasto: number;
  /** El peor coste de UNA llamada: entrada estimada + salida al tope. */
  peorLlamada: number;
}

/** Cada llamada que sale al proveedor pasa por aquí: se comprueba la caja ANTES y se apunta DESPUÉS. */
export function conContador(p: Provider, model: string, caja: Caja, c: Contador): Provider {
  const { precio, prima } = precioYPrima(model);
  return {
    id: p.id,
    async generate(req, opts) {
      if (caja.gasto + caja.peorLlamada > caja.tope) {
        throw new PresupuestoAgotado(`budget: spent ${caja.gasto.toFixed(4)} of ${caja.tope} USD`);
      }
      const resp: ProviderResponse = await p.generate(req, opts);
      const { escrituras } = escriturasDeLlamada(resp);
      const usd = costeDeLlamada(precio, prima, resp.usage, escrituras);
      caja.gasto += usd;
      c.coste += usd;
      c.llamadas += 1;
      c.entrada += resp.usage.inputTokens;
      c.cacheada += resp.usage.cachedInputTokens ?? 0;
      c.escrita += escrituras;
      c.salida += resp.usage.outputTokens;
      if (resp.finishReason !== undefined) c.ultimoFinish = String(resp.finishReason);
      return resp;
    },
  };
}

/** El proveedor falso de `--seco`: contesta el oro si lo conoce, sin red. */
export function proveedorSeco(oros: Map<string, number>): Provider {
  return {
    id: "gsm8k-seco",
    async generate(req: ProviderRequest) {
      const u = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      return {
        text: `Step omitted.\n#### ${oros.get(u) ?? 0}`,
        usage: { inputTokens: Math.ceil((sys.length + u.length) / 4), outputTokens: 12, cachedInputTokens: 0 },
        finishReason: "stop",
      };
    },
  };
}

// ─── Un modelo ───────────────────────────────────────────────────────────────

export interface OpcionesDeModelo {
  model: string;
  test: readonly FilaGsm8k[];
  sistema: string;
  brazos: readonly Brazo[];
  nUnicosMax: number;
  /**
   * Únicos FIJOS (los de una tirada anterior, para repetir su flujo exacto). Se
   * usan aunque la previsión diga menos: la caja sigue siendo dura y, si se
   * agota, el flujo se corta en un prefijo del mismo flujo, que sigue siendo
   * comparable petición a petición.
   */
  nUnicosFijo?: number;
  topeUsd: number;
  /** Fábrica del proveedor crudo de cada brazo. En LIVE, el del banco; en seco, el falso. */
  crudo: () => Provider;
  /** Solo host, para el artefacto. */
  host: string | null;
  runId: string;
  capa: FabricaDeCapa;
  log?: (s: string) => void;
}

export interface MedicionDeModelo {
  modelo: string;
  estado: "medido" | "no-medible" | "abortado-presupuesto";
  motivo?: string;
  host: string | null;
  muestreo: Record<string, unknown>;
  topeDeSalida: number | null;
  sonda?: { peticiones: number; salidaMedia: number; costeUsd: number };
  nUnicos?: number;
  flujo?: Flujo["cuenta"];
  peticionesCompletadas?: number;
  estimacion?: { porPeticionUsd: number; peorLlamadaUsd: number; previstoUsd: number; nUnicosPrevisto?: number };
  gasto: { topeUsd: number; totalUsd: number; porBrazo: Partial<Record<Brazo | "sonda", number>> };
  resumen?: Resumen;
  /** De dónde sale el ahorro de cada brazo: lo que no llamó frente a la caché de prefijo del proveedor. */
  desglose?: DesgloseDeBrazo[];
  calibracionS?: unknown;
  registrosSemanticos?: Partial<Record<Brazo, number>>;
  evidencias?: Evidencia[];
  ensayos?: Ensayo[];
}

export interface Evidencia {
  brazo: Brazo;
  pos: number;
  clase: string;
  preguntada: string;
  original: string;
  similitud?: number;
  numeroServido: number | null;
  numeroA: number | null;
  respuestaServidaExtracto: string;
  respuestaAExtracto: string;
}

const huella = (t: string): string => createHash("sha256").update(t).digest("hex").slice(0, 12);
const salSistema = (runId: string, carril: string, sistema: string): string => `[run ${runId} lane ${carril}]\n${sistema}`;

/**
 * La petición de los brazos. La caché semántica NO se pide aquí: en la 0.4.31 la
 * enciende la capa con `semanticCacheDefault: true` (#380), como el fragmento
 * «Serverless» del README.
 */
export function peticionDe(model: string, sistema: string, texto: string, tope: number | null): SavingsRequest {
  return {
    model,
    messages: [
      { role: "system", content: sistema },
      { role: "user", content: mensajeDeUsuario(texto) },
    ],
    ...muestreoPareadoPara(model),
    ...(tope !== null ? { maxOutputTokens: tope } : {}),
  };
}

/** El brazo A: el naive del banco con el MISMO tope que la capa (construirBrazoNaive solo copia el del contrato). */
export function peticionDirecta(req: SavingsRequest, model: string): ProviderRequest {
  return { ...construirBrazoNaive(req, model), ...(req.maxOutputTokens != null ? { maxOutputTokens: req.maxOutputTokens } : {}) };
}

export async function medirModelo(o: OpcionesDeModelo): Promise<MedicionDeModelo> {
  const log = o.log ?? (() => {});
  const { model } = o;
  const { precio, conocido } = precioYPrima(model);
  const tope = topeDeSalida(model);
  const caja: Caja = { tope: Math.min(o.topeUsd, topeDuroPara(model)), gasto: 0, peorLlamada: 0 };
  const entradaEst = Math.ceil((o.sistema.length + 1200) / 3.2); // conservador: ~3,2 caracteres por token
  caja.peorLlamada = (entradaEst / 1000) * precio.inputPer1k + ((tope ?? SALIDA_PEOR_CASO) / 1000) * precio.outputPer1k;
  const base: MedicionDeModelo = {
    modelo: model,
    estado: "medido",
    host: o.host,
    muestreo: muestreoPareadoPara(model),
    topeDeSalida: tope,
    gasto: { topeUsd: caja.tope, totalUsd: 0, porBrazo: {} },
  };
  if (!conocido) return { ...base, estado: "no-medible", motivo: "no list price in the SDK catalogue" };

  // 1. Sonda: 3 problemas por el brazo A, que confirman el id y dan la salida media.
  const cSonda = contadorNuevo();
  const provSonda = conContador(conReintentos(o.crudo()), model, caja, cSonda);
  const sondaTextos = [0, 1, 2].map((i) => o.test[(i * 419) % o.test.length]!.question.trim());
  try {
    for (const t of sondaTextos) {
      await provSonda.generate(peticionDirecta(peticionDe(model, salSistema(o.runId, "p", o.sistema), t, tope), model));
    }
  } catch (err) {
    base.gasto.totalUsd = caja.gasto;
    base.gasto.porBrazo.sonda = cSonda.coste;
    return { ...base, estado: "no-medible", motivo: sinSecretos(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
  const salidaMedia = cSonda.salida / Math.max(1, cSonda.llamadas);
  base.sonda = { peticiones: cSonda.llamadas, salidaMedia, costeUsd: cSonda.coste };
  base.gasto.porBrazo.sonda = cSonda.coste;

  // 2. Tamaño del flujo: que quepa lo previsto (salida media ×1,3, entrada sin caché,
  //    brazos con capa al 80 % de A) en el 85 % de lo que queda de caja.
  const porLlamada = (entradaEst / 1000) * precio.inputPer1k + ((salidaMedia * 1.3) / 1000) * precio.outputPer1k;
  const porPeticion = porLlamada * (1 + 0.8 * (o.brazos.length - 1));
  const queda = caja.tope - caja.gasto;
  const nPrevisto = Math.max(0, Math.min(o.nUnicosMax, Math.floor((0.85 * queda) / (2 * porPeticion))));
  const nUnicos = o.nUnicosFijo !== undefined ? Math.min(o.nUnicosFijo, o.test.length) : nPrevisto;
  base.estimacion = { porPeticionUsd: porPeticion, peorLlamadaUsd: caja.peorLlamada, previstoUsd: porPeticion * 2 * nUnicos, nUnicosPrevisto: nPrevisto };
  if (nUnicos < 10) return { ...base, estado: "no-medible", motivo: `budget fits only ${nUnicos} unique problems` };
  const flujo = construirFlujo(o.test, { nUnicos, semilla: SEMILLA });
  base.nUnicos = nUnicos;
  base.flujo = flujo.cuenta;
  log(
    `  ${model}: ${nUnicos} únicos${o.nUnicosFijo !== undefined ? ` (fijados; la previsión conservadora daba ${nPrevisto})` : ""}, ` +
      `${flujo.peticiones.length} peticiones, previsto ~$${base.estimacion.previstoUsd.toFixed(3)} (tope $${caja.tope})`,
  );

  // 3. Los brazos.
  const cont: Partial<Record<Brazo, Contador>> = {};
  const prov: Partial<Record<Brazo, Provider>> = {};
  for (const b of o.brazos) {
    cont[b] = contadorNuevo();
    prov[b] = conContador(conReintentos(o.crudo()), model, caja, cont[b]!);
  }
  const caches: Partial<Record<Brazo, InMemorySemanticCache>> = {
    ...(o.brazos.includes("S")
      ? {
          S: new o.capa.api.InMemorySemanticCache({
            calibration: { maxErrorRate: 0.02, judge: juezNumerico, judgeId: JUEZ_ID, random: mulberry32(0xca11b) },
          }),
        }
      : {}),
    ...(o.brazos.includes("E") ? { E: new o.capa.api.InMemorySemanticCache() } : {}),
  };
  const capas = Object.fromEntries(
    o.brazos
      .filter((b) => b !== "A")
      .map((b) => [
        b,
        o.capa.api.createSavingsLayer({
          provider: prov[b]!,
          ...o.capa.licencia,
          silenceWarnings: true,
          ...(caches[b] ? { semanticCache: caches[b], semanticCacheDefault: true } : {}),
        }),
      ]),
  );

  const ensayos: Ensayo[] = [];
  const textos = new Map<string, { pos: number; texto: string; A?: string; porBrazo: Partial<Record<Brazo, string>> }>();
  const originalDe = new Map(flujo.problemas.map((p) => [p.idx, p.pregunta]));
  let completadas = 0;
  let abortado: string | undefined;

  const medirBrazo = async (b: Brazo, q: Peticion): Promise<Ensayo> => {
    const c = cont[b]!;
    const antes = { ...c };
    const t0 = performance.now();
    const fila: Ensayo = {
      pos: q.pos, familia: q.familia, clase: q.clase, oro: q.oro, huella: huella(q.texto), brazo: b,
      numero: null, correcto: null, coste: 0, llamadas: 0, entrada: 0, cacheada: 0, escrita: 0, salida: 0,
      latenciaMs: 0, fuente: "provider",
    };
    let texto = "";
    try {
      if (b === "A") {
        const r = await prov.A!.generate(peticionDirecta(peticionDe(model, salSistema(o.runId, "a", o.sistema), q.texto, tope), model));
        texto = r.text;
      } else {
        const carril = b.toLowerCase();
        const r = await capas[b]!.generate(peticionDe(model, salSistema(o.runId, carril, o.sistema), q.texto, tope));
        texto = r.text;
        const rep = r.report;
        fila.fuente = rep.qualityLedger?.source ?? (rep.cache.result === "miss" ? "provider" : rep.cache.result);
        fila.base = rep.cost.basis;
        fila.lineaBaseCapa = rep.cost.baselineEstimate;
        fila.realCapa = rep.cost.actual;
        fila.comprimidos = rep.tokens.compressedInput;
        const cm = rep.qualityLedger?.cacheMatch;
        if (cm && cm.kind === "semantic") fila.similitud = cm.similarity;
      }
    } catch (err) {
      if (err instanceof PresupuestoAgotado) throw err;
      fila.error = sinSecretos(err instanceof Error ? err.message : String(err)).slice(0, 300);
    }
    fila.latenciaMs = performance.now() - t0;
    fila.coste = c.coste - antes.coste;
    fila.llamadas = c.llamadas - antes.llamadas;
    fila.entrada = c.entrada - antes.entrada;
    fila.cacheada = c.cacheada - antes.cacheada;
    fila.escrita = c.escrita - antes.escrita;
    fila.salida = c.salida - antes.salida;
    if (fila.llamadas > 0 && c.ultimoFinish !== undefined) fila.finishReason = c.ultimoFinish;
    fila.numero = fila.error ? null : extraerNumeroFinal(texto);
    fila.correcto = q.oro === null ? null : fila.error ? false : mismaCifra(fila.numero, q.oro);
    const t = textos.get(`${q.pos}`) ?? { pos: q.pos, texto: q.texto, porBrazo: {} };
    t.porBrazo[b] = texto;
    textos.set(`${q.pos}`, t);
    return fila;
  };

  for (const q of flujo.peticiones) {
    if (caja.gasto + o.brazos.length * caja.peorLlamada > caja.tope) {
      abortado = `stopped before request ${q.pos}: spent ${caja.gasto.toFixed(4)} + ${o.brazos.length} worst-case calls would pass the ${caja.tope} USD cap`;
      break;
    }
    try {
      const filas = await Promise.all(o.brazos.map((b) => medirBrazo(b, q)));
      ensayos.push(...filas);
      completadas++;
    } catch (err) {
      if (err instanceof PresupuestoAgotado) {
        abortado = err.message;
        break;
      }
      throw err;
    }
    if (completadas % 20 === 0) log(`    ${completadas}/${flujo.peticiones.length}  gasto $${caja.gasto.toFixed(4)}`);
  }
  for (const s of Object.values(caches)) await s?.settled();
  for (const capa of Object.values(capas)) capa.close();

  const resumen = resumir(ensayos);
  const evidencias: Evidencia[] = resumen.variantesServidasDeOtra.map((h) => {
    const t = textos.get(`${h.pos}`)!;
    return {
      brazo: h.brazo,
      pos: h.pos,
      clase: h.clase,
      preguntada: t.texto,
      original: originalDe.get(h.familia) ?? "",
      ...(h.similitud !== undefined ? { similitud: h.similitud } : {}),
      numeroServido: h.numeroServido,
      numeroA: h.numeroA,
      respuestaServidaExtracto: (t.porBrazo[h.brazo] ?? "").slice(-300),
      respuestaAExtracto: (t.porBrazo.A ?? "").slice(-300),
    };
  });
  base.gasto.totalUsd = caja.gasto;
  for (const b of o.brazos) base.gasto.porBrazo[b] = cont[b]!.coste;
  return {
    ...base,
    estado: abortado ? "abortado-presupuesto" : "medido",
    ...(abortado ? { motivo: abortado } : {}),
    peticionesCompletadas: completadas,
    resumen,
    desglose: desgloseDelAhorro(ensayos, {
      inputPer1k: precio.inputPer1k,
      cachedInputPer1k: precio.cachedInputPer1k ?? precio.inputPer1k,
      prima: precioYPrima(model).prima,
    }),
    ...(caches.S ? { calibracionS: caches.S.calibrationStatus() } : {}),
    registrosSemanticos: Object.fromEntries(Object.entries(caches).map(([b, s]) => [b, s!.size])),
    evidencias,
    ensayos,
  };
}

// ─── Principal ───────────────────────────────────────────────────────────────

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const bandera = (nombre: string): boolean => process.argv.includes(`--${nombre}`);

/** La configuración de transporte, con OpenAI por su endpoint directo cuando la pasarela ES api.openai.com. */
export function transporteDelBanco(env: NodeJS.ProcessEnv): ConfigDeTransporte {
  const cfg = configDesdeEntorno(env);
  let host = "";
  try {
    host = cfg.baseUrl ? new URL(cfg.baseUrl).hostname : "";
  } catch {
    host = "";
  }
  if (!cfg.openaiBaseUrl && host === "api.openai.com") {
    return { ...cfg, openaiBaseUrl: cfg.baseUrl, openaiApiKey: cfg.apiKey, fetchImpl: fetchConPlazo(120_000) };
  }
  return { ...cfg, fetchImpl: fetchConPlazo(120_000) };
}

export interface Artefacto {
  bateria: "gsm8k";
  fecha: string;
  modo: "LIVE" | "SECO";
  runId: string;
  procedencia: ReturnType<typeof procedencia>;
  /** Hosts a los que salió alguna petición durante la medición (solo host, nunca URL ni cabeceras). */
  red?: { hostsPermitidos: string[]; hostsVistos: Record<string, number>; bloqueados: Record<string, number> };
  dataset: {
    nombre: string;
    repo: string;
    commit: string;
    licencia: string;
    ficheros: { id: string; url: string; sha256: string; filas: number }[];
    fewShotTrainIdx: number[];
  };
  flujo: { semilla: number; fraccionRepeticiones: number; fraccionParafrasis: number; nUnicosMax: number };
  brazos: Partial<Record<Brazo, string>>;
  presupuesto: { topePorModeloUsd: number; topesPorModelo?: Record<string, number>; gastoTotalUsd: number };
  /** Tope de salida de todos los brazos (maxOutputTokens), o null si no hubo. */
  topeDeSalida?: number | null;
  /** Cómo se enciende la caché semántica en S y E. */
  interruptorSemantico?: string;
  modelos: MedicionDeModelo[];
  sinRed?: { preguntas: number; resultados: ResultadoSinRed[] };
  /** La misma tirada con la versión anterior (`--mismo-flujo-que`), comparada petición a petición. */
  comparacion?: Comparacion0430;
  limitaciones: string[];
}

async function principal(): Promise<void> {
  const seco = bandera("seco");
  const soloSinRed = bandera("sin-red");
  await asegurarDatos();
  const test = leerSplit(FUENTE_GSM8K_TEST);
  const train = leerSplit(FUENTE_GSM8K_TRAIN);
  const fewShot = ejemplosFewShot(train, SEMILLA);
  const sistema = systemPrompt(train, fewShot);
  const runId = randomBytes(3).toString("hex");
  const brazos = (arg("brazos") ?? "A,B,S,E").split(",").map((s) => s.trim()) as Brazo[];
  const modelos = (arg("modelos") ?? MODELOS_DE_LA_BATERIA.join(",")).split(",").map((s) => s.trim());
  const nUnicosMax = Number(arg("n-unicos") ?? (seco ? 20 : 100));
  const topeUsd = Number(arg("presupuesto") ?? TOPE_DURO_POR_MODELO_USD);
  const rutaAnterior = arg("mismo-flujo-que");
  const anterior = rutaAnterior ? (JSON.parse(readFileSync(rutaAnterior, "utf8")) as Artefacto & ArtefactoComparable) : null;
  if (!(topeUsd > 0 && topeUsd <= TOPE_DURO_POR_MODELO_USD)) {
    throw new Error(`--presupuesto must be in (0, ${TOPE_DURO_POR_MODELO_USD}] USD per model`);
  }
  const log = (s: string) => console.log(s);

  // LA RED DE LA MEDICIÓN: solo los dos proveedores. Cualquier otro host (licencias,
  // metering, telemetría) se BLOQUEA antes de salir y queda apuntado.
  const red = { hostsPermitidos: [...HOSTS_PERMITIDOS], hostsVistos: {} as Record<string, number>, bloqueados: {} as Record<string, number> };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    const host = new URL(url).host;
    if (!HOSTS_PERMITIDOS.includes(host)) {
      red.bloqueados[host] = (red.bloqueados[host] ?? 0) + 1;
      throw new Error(`blocked by the bench: ${host} is not a provider host`);
    }
    red.hostsVistos[host] = (red.hostsVistos[host] ?? 0) + 1;
    return fetchOriginal(input, init);
  }) as typeof fetch;

  // La capa ANTES de cualquier llamada de pago: sin licencia, se aborta aquí.
  let capa: FabricaDeCapa;
  if (seco) {
    capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
  } else {
    try {
      capa = await fabricaDeCapa({ desdeFuente: bandera("desde-fuente"), env: process.env });
    } catch (err) {
      if (err instanceof SinLicencia && soloSinRed) {
        // La repetición sin red no llama a nadie: con el fuente idéntico basta, y se declara.
        capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
      } else {
        throw err;
      }
    }
  }
  log(`capa: ${capa.origen}`);

  const art: Artefacto = {
    bateria: "gsm8k",
    fecha: FECHA,
    modo: seco ? "SECO" : "LIVE",
    runId,
    procedencia: procedencia(capa.origen),
    red,
    dataset: {
      nombre: "GSM8K (Cobbe et al. 2021)",
      repo: "https://github.com/openai/grade-school-math",
      commit: GSM8K_COMMIT,
      licencia: "MIT",
      ficheros: [FUENTE_GSM8K_TEST, FUENTE_GSM8K_TRAIN].map((f) => ({ id: f.id, url: f.url, sha256: f.sha256!, filas: f.filas })),
      fewShotTrainIdx: fewShot,
    },
    flujo: { semilla: SEMILLA, fraccionRepeticiones: 0.3, fraccionParafrasis: 0.2, nUnicosMax },
    brazos: Object.fromEntries(brazos.map((b) => [b, DESCRIPCION_DE_BRAZOS[b]])),
    presupuesto: {
      topePorModeloUsd: topeUsd,
      topesPorModelo: Object.fromEntries(modelos.map((m) => [m, Math.min(topeUsd, topeDuroPara(m))])),
      gastoTotalUsd: 0,
    },
    topeDeSalida: TOPE_DE_SALIDA,
    interruptorSemantico: "createSavingsLayer({ semanticCache, semanticCacheDefault: true }) — #380, new in 0.4.31; nothing on the request",
    modelos: [],
    limitaciones: [],
  };

  if (!soloSinRed) {
    const cfg = transporteDelBanco(process.env);
    const oros = new Map<string, number>();
    if (seco) {
      const f = construirFlujo(test, { nUnicos: Math.min(nUnicosMax, test.length), semilla: SEMILLA });
      for (const q of f.peticiones) if (q.oro !== null) oros.set(mensajeDeUsuario(q.texto), q.oro);
    }
    for (const model of modelos) {
      const e = seco ? null : endpointDeModelo(model, cfg);
      if (!seco && (!e || e.transporte === "mock")) {
        art.modelos.push({
          modelo: model, estado: "no-medible", motivo: "no endpoint declared for this model family", host: null,
          muestreo: muestreoPareadoPara(model), topeDeSalida: topeDeSalida(model), gasto: { topeUsd, totalUsd: 0, porBrazo: {} },
        });
        continue;
      }
      if (!seco && e!.transporte === "anthropic-nativo") {
        const clave = await claveAnthropicValida(e!.baseUrl!, e!.apiKey);
        if (clave !== "ok") {
          log(`• ${model}: no medible — ${clave}`);
          art.modelos.push({
            modelo: model, estado: "no-medible", motivo: clave, host: e!.host,
            muestreo: muestreoPareadoPara(model), topeDeSalida: topeDeSalida(model), gasto: { topeUsd: Math.min(topeUsd, topeDuroPara(model)), totalUsd: 0, porBrazo: {} },
          });
          continue;
        }
      }
      const nFijo = anterior?.modelos.find((x) => x.modelo === model)?.nUnicos;
      log(`• ${model} (${seco ? "seco" : e!.host})`);
      const m = await medirModelo({
        model, test, sistema, brazos, nUnicosMax, topeUsd, runId, log, capa,
        ...(nFijo !== undefined ? { nUnicosFijo: nFijo } : {}),
        host: seco ? null : e!.host,
        crudo: seco ? () => proveedorSeco(oros) : () => proveedorDelBanco(model, cfg),
      });
      log(`  → ${m.estado}${m.motivo ? `: ${m.motivo}` : ""}  gasto $${m.gasto.totalUsd.toFixed(4)}`);
      art.modelos.push(m);
    }
    art.presupuesto.gastoTotalUsd = art.modelos.reduce((s, m) => s + m.gasto.totalUsd, 0);
  }

  if (soloSinRed || !seco) {
    log("• repetición sin red sobre el split de test entero");
    const preguntas = preguntasSinRed(test, SEMILLA);
    const resultados: ResultadoSinRed[] = [];
    for (const c of CONFIGS_SIN_RED) {
      const r = await repetirSinRed(preguntas, c, sistema, capa);
      log(`  ${c}: ${r.llamadasAlProveedor}/${r.peticiones} llamadas, ${r.erroneas} respuestas de otra pregunta`);
      resultados.push({ ...r, evidencias: r.evidencias.slice(0, 12) });
    }
    art.sinRed = { preguntas: preguntas.length, resultados };
  }

  if (anterior) art.comparacion = comparar(anterior, art);
  art.limitaciones = limitaciones(art);
  mkdirSync(DIR_SALIDA_GSM8K, { recursive: true });
  const nombre = seco ? "seco.json" : soloSinRed ? "sin-red.json" : "resultado.json";
  const salida = join(DIR_SALIDA_GSM8K, nombre);
  writeFileSync(salida, JSON.stringify(art, null, 2));
  log(`escrito ${salida}`);
  if (bandera("docs")) {
    if (seco) throw new Error("--docs refuses a dry run: SECO figures are not measurements");
    const dir = fileURLToPath(new URL(`../../../docs/benchmarks/${FECHA}/`, import.meta.url));
    mkdirSync(dir, { recursive: true });
    const base = nombreDelDocumento(art.procedencia.version, arg("sufijo"));
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(art, null, 2));
    writeFileSync(join(dir, `${base}.md`), escribirDocumento(art));
    log(`escrito ${join(dir, `${base}.{json,md}`)}`);
  }
}

/** `gsm8k-0431` para la 0.4.31 (el de la 0.4.30, `gsm8k`, no se pisa); con sufijo, `gsm8k-0431-claude`. */
export function nombreDelDocumento(version: string, sufijo?: string): string {
  const base = `gsm8k-${version.replaceAll(".", "")}`;
  if (sufijo === undefined) return base;
  if (!/^[a-z0-9-]+$/.test(sufijo)) throw new Error(`--sufijo must match [a-z0-9-]+: ${sufijo}`);
  return `${base}-${sufijo}`;
}

/**
 * La comprobación GRATUITA de la clave de Anthropic: `GET /v1/models` no genera
 * nada y no se factura. 401/403 ⇒ «no medibles: clave inválida» sin gastar la
 * sonda. La clave solo viaja en la cabecera; el texto de error pasa por `sinSecretos`.
 */
export async function claveAnthropicValida(baseUrl: string, apiKey: string | undefined, f: typeof fetch = fetch): Promise<"ok" | string> {
  if (!apiKey) return "no medibles: sin clave de Anthropic en el entorno";
  const base = baseUrl.replace(/\/$/, "");
  try {
    const r = await f(`${base}/models?limit=1`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    if (r.status === 401 || r.status === 403) return `no medibles: clave inválida (${r.status} en GET /v1/models, comprobación sin coste)`;
    if (!r.ok) return sinSecretos(`no medibles: GET /v1/models respondió ${r.status}`);
    return "ok";
  } catch (err) {
    return sinSecretos(`no medibles: ${err instanceof Error ? err.message : String(err)}`).slice(0, 200);
  }
}

export function limitaciones(art: Artefacto): string[] {
  const l = [
    "Compression: the npm package ships no compressor (noopCompressor) and these requests carry no structuredData, so ledger 3 (compressed tokens) is 0 by construction; this battery cannot show a compression saving, and says so instead of reporting a 0 as a measured failure.",
    "Paraphrases are deterministic templates (case/punctuation, a preamble plus synonyms), not human rewrites; real paraphrases are harder for a lexical embedder, so semantic hit rates here are an upper bound for surface-level rewording.",
    "Variants (one number changed) have no published gold; they are used only to check whether another question's answer was served, never for accuracy.",
    "Each arm carries a distinct run/lane tag at the start of its system prompt, so no arm reads another arm's provider prompt cache. The tag costs the same few tokens in every arm.",
    "Stream size per model is set from a 3-request probe and the budget; models whose stream is smaller have wider intervals. Confidence intervals resample whole problem families (a problem with its repeats and paraphrases).",
    "Latency is wall-clock from this machine, with the four arms of each request running concurrently; it includes network and is not a provider SLA.",
  ];
  if (art.procedencia.origen === "fuente") {
    l.unshift(
      `Arms B, S and E ran the ${art.procedencia.version} SOURCE of the tag with devUnlicensed: true (--desde-fuente), not the npm tarball: the npm build has no unlicensed mode. The dist built from this source is byte-identical to the tarball's dist/index.js (sha256 in \`procedencia\`).`,
    );
  }
  const medidos = art.modelos.filter((m) => m.resumen);
  const soloAnthropic = medidos.length > 0 && medidos.every((m) => m.modelo.startsWith("anthropic/"));
  l.push(
    soloAnthropic
      ? `Every arm sends the same output cap, maxOutputTokens ${TOPE_DE_SALIDA} (0.4.31, #381); on api.anthropic.com it travels as max_tokens, which the Messages API requires anyway (the adapter's default without a cap is 4096).`
      : `Every arm sends the same output cap, maxOutputTokens ${TOPE_DE_SALIDA} (0.4.31, #381: free-text requests can carry it; on api.openai.com it travels as max_completion_tokens). The 0.4.30 run had no cap; its longest answers were 957 (gpt-4o-mini) and 391 (gpt-5.4-mini) tokens, so this cap would not have cut any of them.`,
    "Semantic cache in S and E is switched on with semanticCacheDefault: true on the layer (0.4.31, #380), not with savings.semanticCache on each request as in the 0.4.30 run. The no-network replay runs both mechanisms side by side (semantica-envio vs semantica-defecto-capa) to show they decide the same.",
  );
  if (art.comparacion) {
    const fijos = art.modelos
      .filter((m) => m.nUnicos !== undefined && m.estimacion?.nUnicosPrevisto !== undefined && m.estimacion.nUnicosPrevisto !== m.nUnicos)
      .map((m) => `${m.modelo} ${m.nUnicos} (the conservative forecast gave ${m.estimacion!.nUnicosPrevisto})`);
    l.push(
      `Uniques per model were FIXED to those of the ${art.comparacion.versionAntes} run (run ${art.comparacion.runAntes}) so both runs ask the same stream; the hard budget still applied to every call.` +
        (fijos.length ? ` Fixed above the forecast: ${fijos.join(", ")}.` : ""),
      `Accuracy changes between ${art.comparacion.versionAntes} and ${art.comparacion.versionDespues} of one or two answers are within the model's own run-to-run noise: arm A (no layer, same code in both runs) moved too. Served-from-another-question counts, cache sources and provider calls are the layer's decisions and do not share that noise.`,
    );
    for (const c of art.comparacion.modelos) {
      if (!c.mismoFlujo) {
        l.push(
          `${c.modelo}: the 0.4.30 comparison is NOT on an identical stream (${c.nUnicosAntes} vs ${c.nUnicosDespues} uniques, ${c.discrepancias} positions with a different question); read it as indicative.`,
        );
      }
    }
  }
  if (medidos.some((m) => m.modelo.startsWith("anthropic/"))) {
    l.push(
      "Anthropic caches a prefix only behind an explicit cache_control breakpoint. Arm A is the naive client and sends none, so every prefix-cache read in B/S/E is a breakpoint the layer placed; a client that marks its own system prompt would get that part without the layer. The breakdown table separates it from what the layer saved by not calling at all.",
      "Anthropic also caches nothing below the model's minimum cacheable prefix (4096 tokens for claude-haiku-4-5 on the official prompt-caching page; the SDK keeps the conservative 1024 for models without a published figure). The mean input per call in the breakdown table says on which side of that line this few-shot system prompt falls.",
      "Up to four arms run concurrently per request against one Anthropic key that sibling benchmark runs were also using; 429/529 are retried with backoff, and a retried call's wait is part of its latency.",
    );
  }
  for (const m of art.modelos.filter((x) => x.estado === "no-medible")) {
    l.push(`${m.modelo} not measured: ${m.motivo}`);
  }
  return l;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((err) => {
    console.error(sinSecretos(err instanceof Error ? (err instanceof SinLicencia ? err.message : (err.stack ?? err.message)) : String(err)));
    process.exit(1);
  });
}
