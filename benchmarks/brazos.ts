/**
 * LOS BRAZOS DE CONTROL DEL BANCO A/B — funciones puras, sin red ni entorno,
 * para que `test/brazos-del-banco.test.ts` pueda afirmar exactamente qué manda
 * cada brazo sin ejecutar `ab-live.ts` (que arranca la tirada al importarse).
 *
 * Hasta el 2026-09-12 el banco tenía UN solo brazo de control, el naive (B0),
 * y el titular se publicaba solo frente a él. La guía de investigación del SDK
 * (R01) exige DOS baselines y publicar frente a ambos:
 *
 *   B0 · la integración actual del cliente, sin Savings: JSON compacto, todas
 *        las herramientas, sin marcar caché, mismo contrato y mismos parámetros.
 *   B1 · «la misma integración razonablemente optimizada»: JSON compacto
 *        cuando proceda, CACHÉ NATIVA CONFIGURADA y mismos parámetros. Es lo que
 *        hace cualquier equipo que lea la documentación de su proveedor.
 *
 * Y la razón de que importe es la doctrina de la casa: «si el dato no es mérito
 * nuestro, no va en su panel». El +78 % que la web llegó a publicar sobre
 * Anthropic era el descuento del proveedor frente a un cliente que no había
 * puesto `cache_control`; frente a B1 ese escenario vale lo que valga de verdad.
 * Sin B1 no se sabe qué parte del titular es mérito del SDK.
 *
 * QUÉ HACE B1 DISTINTO DE B0, y solo eso:
 *
 *   1. Marca su prefijo estable para la caché nativa del proveedor
 *      (`stablePrefixMessages` = los mensajes `system` iniciales, que el
 *      adaptador de Anthropic convierte en `cache_control`; y `promptCacheKey`
 *      como pista de enrutado para los endpoints OpenAI-compatibles). SOLO en
 *      los escenarios cuyo prefijo se repite de verdad entre peticiones: en los
 *      salados con frío el prefijo cambia en cada repetición y un cliente
 *      razonable no marca lo que nunca va a acertar (pagaría la prima de
 *      escritura, 1,25×, sin ninguna lectura).
 *   2. Manda solo las herramientas que un integrador diligente pasaría para
 *      ESA petición, cuando el escenario las declara a mano (`toolsB1`). Sin
 *      declaración, manda todas, como B0: elegirlas por él sería inventarle una
 *      capa que no tiene.
 *
 * Todo lo demás —payload, contrato, tope, temperatura, semilla, posición de los
 * datos— es idéntico a B0 a propósito: la diferencia B0→B1 tiene que ser
 * atribuible a esas dos cosas y a nada más.
 */
import type { SavingsRequest, ToolDescriptor } from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { MUESTREO_PAREADO } from "./scenarios.js";

/** El marcador que `conSalDeFrio` antepone; no forma parte del prefijo del cliente. */
const ES_SAL_DE_FRIO = /^\[medicion-fria /;

/**
 * Brazo A (B0) — the naive request an un-optimized team would send: full JSON
 * payload inline, all tools transmitted natively, NO cache marks, and the
 * caller's own contract and output cap (they are the caller's requirement, not
 * something the layer adds, so an arm without them would solve an easier task).
 */
export function construirBrazoNaive(req: SavingsRequest, model: string): ProviderRequest {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.structuredData !== undefined) {
    messages.push({ role: "user", content: JSON.stringify(req.structuredData) });
  }
  return {
    model,
    messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    ...(req.response?.schema ? { schema: req.response.schema } : {}),
    ...(req.response?.maxOutputTokens != null
      ? { maxOutputTokens: req.response.maxOutputTokens }
      : {}),
    // El MISMO muestreo que el brazo B (`conMuestreoPareado`): una sola constante.
    ...MUESTREO_PAREADO,
  };
}

/**
 * Cuántos mensajes iniciales forman el prefijo que un cliente razonable
 * declararía estable: los `system` de cabecera, sin contar la sal de frío del
 * banco (que no es suya y cambia en cada repetición).
 */
export function mensajesDePrefijoRazonable(messages: SavingsRequest["messages"]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "system") break;
    if (ES_SAL_DE_FRIO.test(m.content)) continue;
    n++;
  }
  // Con sal delante, el prefijo NO es estable de verdad: la sal va antes que el
  // system y cambia por repetición, así que el emparejamiento por bytes nunca
  // acertaría. Un cliente razonable no marca eso.
  const conSal = messages.some((m) => m.role === "system" && ES_SAL_DE_FRIO.test(m.content));
  return conSal ? 0 : n;
}

export interface OpcionesB1 {
  /**
   * Ids de las herramientas que un integrador diligente pasaría para esta
   * petición. `undefined` = todas, como B0. Un id que no exista en la petición
   * es un error del escenario, no algo que tapar en silencio.
   */
  toolsB1?: readonly string[];
}

/**
 * Brazo A1 (B1) — «la misma integración razonablemente optimizada».
 * Ver la cabecera del fichero: B0 más caché nativa configurada y, si el
 * escenario las declara, solo las herramientas relevantes.
 */
export function construirBrazoRazonable(
  req: SavingsRequest,
  model: string,
  opts: OpcionesB1 = {},
): ProviderRequest {
  const base = construirBrazoNaive(req, model);
  const prefijo = mensajesDePrefijoRazonable(req.messages);
  let tools: ToolDescriptor[] | undefined = base.tools;
  if (opts.toolsB1 && tools) {
    const ids = new Set(opts.toolsB1);
    const desconocidos = opts.toolsB1.filter((id) => !tools!.some((t) => t.id === id));
    if (desconocidos.length) {
      throw new Error(`toolsB1 declara herramientas que la petición no tiene: ${desconocidos.join(", ")}`);
    }
    tools = tools.filter((t) => ids.has(t.id));
  }
  return {
    ...base,
    ...(tools && tools.length ? { tools } : {}),
    ...(prefijo > 0
      ? {
          stablePrefixMessages: prefijo,
          // Pista de enrutado, nunca identidad: agrupa las peticiones que
          // comparten prefijo en el mismo fragmento de caché del proveedor.
          promptCacheKey: `bvsala-ab-b1-${model.replace(/[^a-z0-9]+/gi, "-")}`,
        }
      : {}),
  };
}

/** Descripción de los brazos, para el artefacto y para el README: UNA fuente. */
export const DEFINICION_DE_BRAZOS = {
  A: "B0 · naive: full compact JSON payload, all tools, no cache marks; same contract, cap, temperature and seed as the other arms.",
  A1: "B1 · reasonably optimized (research guide R01): B0 plus native provider cache configured on the stable prefix (cache_control on Anthropic via stablePrefixMessages; prompt_cache_key hint on OpenAI-compatible endpoints) only where the prefix really repeats, and only the tools a diligent integrator would send when the scenario declares them (toolsB1). Everything else identical to B0.",
  B: "BV-SALA: the same task through the layer.",
} as const;
