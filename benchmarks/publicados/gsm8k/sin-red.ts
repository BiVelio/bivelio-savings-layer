/**
 * LA REPETICIÓN SIN RED: las DECISIONES de la capa sobre todo GSM8K, a coste cero.
 *
 * Lo que la capa decide servir de caché (exacta, semántica, resolver) no depende
 * de lo que conteste el modelo: depende del texto de la petición y del estado de
 * la caché. Así que se puede recorrer el split de test ENTERO por la capa
 * completa (`createSavingsLayer`, la misma que el brazo B) con un proveedor falso
 * que contesta «#### <verdad>» y mirar, petición a petición, si lo servido es la
 * respuesta de ESA pregunta o la de otra.
 *
 * La «verdad» del proveedor falso es el oro de GSM8K para el original y sus dos
 * paráfrasis que no cambian la respuesta, y un valor PROPIO de cada variante
 * (oro + 10⁶·k) para las que la cambian. Una variante que recibe el número de su
 * original ha recibido la respuesta de otra pregunta: es el fallo grave.
 *
 * Esto es MODELADO en lo económico (el proveedor es falso: no hay dinero) y
 * MEDIDO en lo que decide la capa (es el código que se envía, sin atajos).
 */
import type { InMemorySemanticCache, Provider } from "../../../src/index.js";
import type { ProviderRequest } from "../../../src/providers/types.js";
import { mulberry32 } from "../../stats.js";
import type { FabricaDeCapa } from "./capa.js";
import type { FilaGsm8k } from "./fuente.js";
import {
  aplicarPlantilla,
  CLASES_VARIANTE,
  extraerNumeroFinal,
  mensajeDeUsuario,
  mismaCifra,
  oroDe,
  type ClaseDePeticion,
} from "./flujo.js";

/**
 * `semantica-sin-interruptor` es la caché pasada a `createSavingsLayer` SIN
 * `savings.semanticCache: true` en la petición ni `semanticCacheDefault`: así no
 * se consulta ni se escribe nunca (en la 0.4.31, además, avisa; aquí se silencia).
 *
 * `semantica-defecto-capa` (nueva en la 0.4.31, #380) reproduce el fragmento
 * «Serverless» de la 0.4.31 con `semanticCacheDefault: true` en el constructor,
 * sin nada en la petición. `semantica-envio` usa el interruptor en cada petición.
 * Al no tener calibración, ambas quedan en modo sombra: pueden almacenar, pero no
 * sirven aciertos semánticos.
 */
export type ConfigSinRed =
  | "defecto"
  | "semantica-sin-interruptor"
  | "semantica-envio"
  | "semantica-defecto-capa"
  | "semantica-calibrada";
export const CONFIGS_SIN_RED: readonly ConfigSinRed[] = [
  "defecto",
  "semantica-sin-interruptor",
  "semantica-envio",
  "semantica-defecto-capa",
  "semantica-calibrada",
];

/** El juez de la calibración: misma respuesta numérica final. Es el que usaría un cliente de GSM8K. */
export const JUEZ_ID = "gsm8k-final-number-v1";
export function juezNumerico(guardada: { text: string }, fresca: { text: string }): boolean {
  return mismaCifra(extraerNumeroFinal(guardada.text), extraerNumeroFinal(fresca.text));
}

export function cacheSemanticaPara(config: ConfigSinRed, capa: FabricaDeCapa): InMemorySemanticCache | undefined {
  const { InMemorySemanticCache } = capa.api;
  if (config === "semantica-envio" || config === "semantica-sin-interruptor" || config === "semantica-defecto-capa") {
    return new InMemorySemanticCache();
  }
  if (config === "semantica-calibrada") {
    return new InMemorySemanticCache({
      calibration: { maxErrorRate: 0.02, judge: juezNumerico, judgeId: JUEZ_ID, random: mulberry32(0xca11b) },
    });
  }
  return undefined;
}

export interface EvidenciaDeReuso {
  config: ConfigSinRed;
  familia: number;
  clase: ClaseDePeticion;
  fuente: string;
  preguntada: string;
  original: string;
  verdad: number;
  servida: number | null;
  similitud?: number;
}

export interface ResultadoSinRed {
  config: ConfigSinRed;
  /** Qué código tomó las decisiones: el paquete de npm o el fuente idéntico de la etiqueta. */
  origenDeLaCapa: FabricaDeCapa["origen"];
  peticiones: number;
  porClase: Record<string, { n: number; exacta: number; semantica: number; resolver: number; coalescida: number; proveedor: number; erroneas: number }>;
  /** Peticiones cuya política apagó la caché exacta (marcadores de frescura/personales). */
  vetoCacheExacta: number;
  vetoCacheSemantica: number;
  llamadasAlProveedor: number;
  erroneas: number;
  evidencias: EvidenciaDeReuso[];
  calibracion?: unknown;
  /** Registros que quedaron en la caché semántica al terminar. */
  registrosSemanticos?: number;
}

interface Pregunta {
  familia: number;
  clase: ClaseDePeticion;
  texto: string;
  verdad: number;
  original: string;
}

/** Las preguntas de la repetición: cada problema seguido de sus derivadas aplicables. */
export function preguntasSinRed(test: readonly FilaGsm8k[], semilla: number, limite = test.length): Pregunta[] {
  const rng = mulberry32(semilla ^ 0xabcdef);
  const out: Pregunta[] = [];
  const clases: ClaseDePeticion[] = ["original", "superficie", "lexica", "variante-cifra", "variante-palabra"];
  for (let i = 0; i < Math.min(limite, test.length); i++) {
    const original = test[i]!.question.trim();
    const oro = oroDe(test[i]!.answer);
    clases.forEach((clase, k) => {
      const texto = clase === "original" ? original : aplicarPlantilla(clase, original, rng);
      if (texto === null || (clase !== "original" && texto === original)) return;
      const verdad = CLASES_VARIANTE.includes(clase) ? oro + 1_000_000 * k : oro;
      out.push({ familia: i, clase, texto, verdad, original });
    });
  }
  return out;
}

function proveedorFalso(verdades: Map<string, number>): Provider {
  return {
    id: "gsm8k-sin-red",
    async generate(req: ProviderRequest) {
      const usuario = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const v = verdades.get(usuario);
      return {
        text: `Working omitted.\n#### ${v ?? "unknown"}`,
        usage: { inputTokens: 1500, outputTokens: 40, cachedInputTokens: 0 },
        finishReason: "stop",
      };
    },
  };
}

export async function repetirSinRed(
  preguntas: readonly Pregunta[],
  config: ConfigSinRed,
  sistema: string,
  capa: FabricaDeCapa,
  model = "openai/gpt-4o-mini",
): Promise<ResultadoSinRed> {
  const verdades = new Map(preguntas.map((p) => [mensajeDeUsuario(p.texto), p.verdad]));
  let llamadas = 0;
  const base = proveedorFalso(verdades);
  const provider: Provider = {
    id: base.id,
    generate: (r) => {
      llamadas++;
      return base.generate(r);
    },
  };
  const semanticCache = cacheSemanticaPara(config, capa);
  const layer = capa.api.createSavingsLayer({
    provider,
    ...capa.licencia,
    silenceWarnings: true,
    ...(semanticCache ? { semanticCacheStore: semanticCache } : {}),
    ...(config === "semantica-defecto-capa" ? { semanticCacheDefault: true } : {}),
  });
  const porClase: ResultadoSinRed["porClase"] = {};
  const evidencias: EvidenciaDeReuso[] = [];
  let erroneas = 0;
  let vetoE = 0;
  let vetoS = 0;
  for (const p of preguntas) {
    const r = await layer.generate({
      model,
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: mensajeDeUsuario(p.texto) },
      ],
      temperature: 0,
      seed: 7,
      ...(config === "semantica-envio" || config === "semantica-calibrada" ? { savings: { semanticCache: true } } : {}),
    });
    const fila = (porClase[p.clase] ??= { n: 0, exacta: 0, semantica: 0, resolver: 0, coalescida: 0, proveedor: 0, erroneas: 0 });
    fila.n++;
    const fuente = r.report.qualityLedger?.source ?? r.report.cache.result;
    if (fuente === "exact_cache") fila.exacta++;
    else if (fuente === "semantic_cache") fila.semantica++;
    else if (fuente === "deterministic") fila.resolver++;
    else if (fuente === "coalesced") fila.coalescida++;
    else fila.proveedor++;
    const pol = r.report.traces.find((t) => t.stage === "policy");
    const datos = (pol?.detail ?? {}) as { allowExactCache?: boolean; allowSemanticCache?: boolean };
    if (datos.allowExactCache === false) vetoE++;
    if (datos.allowSemanticCache === false) vetoS++;
    const servida = extraerNumeroFinal(r.text);
    if (!mismaCifra(servida, p.verdad)) {
      erroneas++;
      fila.erroneas++;
      const cm = r.report.qualityLedger?.cacheMatch;
      evidencias.push({
        config,
        familia: p.familia,
        clase: p.clase,
        fuente: String(fuente),
        preguntada: p.texto,
        original: p.original,
        verdad: p.verdad,
        servida,
        ...(cm && cm.kind === "semantic" ? { similitud: cm.similarity } : {}),
      });
    }
  }
  await semanticCache?.settled();
  layer.close();
  return {
    config,
    origenDeLaCapa: capa.origen,
    peticiones: preguntas.length,
    porClase,
    vetoCacheExacta: vetoE,
    vetoCacheSemantica: vetoS,
    llamadasAlProveedor: llamadas,
    erroneas,
    evidencias,
    ...(semanticCache ? { registrosSemanticos: semanticCache.size } : {}),
    ...(semanticCache?.calibrated !== undefined && config === "semantica-calibrada"
      ? { calibracion: semanticCache.calibrationStatus() }
      : {}),
  };
}
