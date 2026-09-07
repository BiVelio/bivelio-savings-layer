/**
 * LA VERJA DE APTITUD DE LA ELISIÓN — dónde elidir gana dinero y dónde lo cuesta.
 *
 * EL HECHO QUE LA MOTIVA. La misma política de elisión no rinde igual en todos
 * los modelos, y en algunos PIERDE. Medido el 2026-09-07 por dos caminos
 * independientes que coinciden:
 *   · Replay del corpus (7,8 GB, 4.232 turnos, 45 sesiones; el agregado está
 *     congelado en benchmarks/evidencia/sombra-corpus-2026-09-07.json):
 *         claude-fable-5  +27,4 %      claude-opus-4-8  −3,6 %
 *         claude-sonnet-5   0,0 %      claude-opus-5    −0,4 %
 *   · Carril sombra en vivo (bvsala.usage_daily, 2.288 peticiones): el 05-09,
 *     con un 72,7 % del coste en opus-4-8, la jornada entera dio −3,6 %. El
 *     mismo número que el replay predijo para ese modelo, por otro método.
 *
 * QUÉ SE GUARDA Y QUÉ SE DERIVA — y por qué esta es toda la idea.
 *
 * Se guarda R = tokens_invalidados / tokens_elididos: cuántos tokens de caché
 * hay que reescribir por cada token que se quita. Es ADIMENSIONAL y describe la
 * FORMA del tráfico de ese modelo, no su precio.
 *
 * Se DERIVA del catálogo el umbral R* = r/(w−r), con r = lectura/entrada y
 * w = prima de escritura. Elidir gana mientras R ≤ R*.
 *
 * Esta partición es la única propiedad que ninguna lista escrita a mano tiene.
 * Los cinco modelos del corpus comparten r = 0,1 exacto, así que R* = 0,052632
 * para todos; pero `claude-fable-5-1` lee la caché a 0,025× (catalogo.ts) y su
 * R* baja a 0,012658, 4,2× más estricto. El R medido de `claude-fable-5`
 * (0,01281) queda POR ENCIMA de ese umbral: si alguien confunde las dos
 * generaciones de la familia —el error que ya costó aquí una factura de $279
 * en vez de $1.232,91— la verja lo caza SOLA, sin volver a medir nada. Guardar
 * un porcentaje de ahorro por modelo, en cambio, envejece en silencio en cuanto
 * cambia un precio.
 *
 * LAS TRES COSAS INCÓMODAS, que van aquí y no en una nota al pie:
 *
 * 1. LA EVIDENCIA ES DE OTRO MECANISMO. R se midió sobre la política de sombra
 *    v0 (edad × KB sobre nuestro modelo de bloques, simulada), y lo que esta
 *    verja gatea es `clear_tool_uses` del proveedor. Es una TRANSFERENCIA
 *    declarada, no una medición del mecanismo que se enciende.
 * 2. HOY ES TOLERABLE porque la elisión aporta 0 € a la base de comisión: el
 *    `netSavings` sale solo de `sobrecosteEvitado`, que es la rebaja de TTL.
 *    CONDICIÓN DE SALIDA: el día que el dinero de la elisión entre en la base
 *    de comisión, esta verja necesita su propia medición por modelo.
 * 3. LA VENTANA SON NUEVE DÍAS del tráfico de UNA persona con Claude Code. El
 *    id de modelo es aquí un PROXY de qué carga corrió; la causa real es la
 *    forma del tráfico. Se aplica a todo cliente hasta que caduque.
 *
 * DOCTRINA DE LA DUDA: un modelo sin fila, sin precio o con la medición
 * caducada NO se elide. Se actúa solo con evidencia positiva y fresca; ante
 * cualquier duda el tráfico pasa intacto. No ahorrar de menos no cuesta
 * credibilidad; ahorrar de más, sí.
 */
import { claveDeCatalogo, precioDeLista } from "./catalogo.js";
import { primaDeEscritura1h } from "./primas.js";

/** Día de la medición, al estilo de `PRECIOS_AL_DIA` y `DELTAS_AL_DIA`. */
export const VEREDICTOS_AL_DIA = "2026-09-07";

/**
 * A los 60 días una fila deja de contar y su modelo vuelve a «sin medición».
 * Protege EL CAMPO, no el repositorio: la versión ya instalada por npm deja de
 * elidir sola, sin depender de que nadie mire un CI. El vigía avisa a los 45
 * para que dé tiempo a re-medir.
 */
export const CADUCIDAD_DIAS = 60;

/**
 * Margen relativo exigido sobre el umbral: se aplica si R ≤ R* × (1 − MARGEN).
 *
 * Existe por un empate real, no por prudencia decorativa: `claude-sonnet-5`
 * sale con R = 0,052632, EXACTAMENTE su R*, y un `≤` a secas lo abriría para
 * ganar 0,00 €. Y el propio replay declara un sesgo del simulador
 * (`ratioSimSobreReal: 1,2`), así que un 10 % contra un sesgo declarado del
 * 20 % no es holgura de sobra.
 */
export const MARGEN_RELATIVO = 0.1;

/** La forma del tráfico medida para un modelo, con su procedencia. */
export interface FormaMedida {
  /** R = tokens invalidados / tokens elididos. Adimensional. */
  R: number;
  /** Mecanismo con el que se midió. Parte de la clave: una política nueva NO
   *  hereda la evidencia de la vieja en silencio. */
  mecanismo: "sombra-v0";
  /** Turnos que respaldan la cifra. Pocos turnos = evidencia floja. */
  turnos: number;
  /** De dónde sale, verificable. */
  fuente: string;
}

/**
 * LA TABLA. Clave = clave de catálogo + mecanismo. Solo modelos MEDIDOS; un
 * modelo que no está aquí no se elide.
 *
 * Refrescar: `pnpm sombra:corpus` y copiar `porModelo[<modelo>].v0.R`, con la
 * fecha y el fichero como fuente.
 */
export const FORMA_DE_TRAFICO_MEDIDA: Readonly<Record<string, FormaMedida>> = {
  // veredicto el 2026-09-07: ABRE (R 0,01281 ≤ R* 0,052632 × 0,9 = 0,047368)
  "claude-fable-5·sombra-v0": {
    R: 0.01281,
    mecanismo: "sombra-v0",
    turnos: 3305,
    fuente: "benchmarks/evidencia/sombra-corpus-2026-09-07.json · 1.068,65 → 776,12 USD (+27,4 %)",
  },
  // veredicto el 2026-09-07: CIERRA (R 0,0577 > 0,047368)
  "claude-opus-4-8·sombra-v0": {
    R: 0.0577,
    mecanismo: "sombra-v0",
    turnos: 209,
    fuente: "benchmarks/evidencia/sombra-corpus-2026-09-07.json · 233,08 → 241,43 USD (−3,6 %)",
  },
  // veredicto el 2026-09-07: CIERRA (R 0,0534 > 0,047368)
  "claude-opus-5·sombra-v0": {
    R: 0.0534,
    mecanismo: "sombra-v0",
    turnos: 96,
    fuente: "benchmarks/evidencia/sombra-corpus-2026-09-07.json · 29,40 → 29,52 USD (−0,4 %)",
  },
  // veredicto el 2026-09-07: CIERRA por el margen (R = R* exacto, ahorro 0,00 USD)
  "claude-sonnet-5·sombra-v0": {
    R: 0.052632,
    mecanismo: "sombra-v0",
    turnos: 331,
    fuente: "benchmarks/evidencia/sombra-corpus-2026-09-07.json · 46,64 → 46,64 USD (0,0 %)",
  },
};

export type MotivoDeVerja =
  | "aplica"
  | "sin-medicion"
  | "sin-precio"
  | "medicion-caducada"
  | "no-compensa";

export interface VeredictoDeElision {
  aplicar: boolean;
  motivo: MotivoDeVerja;
  /** R medido y R* derivado, para poder explicar la decisión sin re-calcularla. */
  R?: number;
  umbral?: number;
}

/**
 * R* = r/(w−r): el ratio máximo de invalidación que compensa, DERIVADO de los
 * precios de hoy. Elidir un token ahorra su LECTURA (r) y obliga a reescribir
 * lo posterior a precio de escritura (w). Devuelve null sin precio de catálogo.
 */
export function puntoDeEquilibrio(model: string): number | null {
  const precio = precioDeLista(model);
  if (!precio?.cachedInputPer1k || !precio.inputPer1k) return null;
  const r = precio.cachedInputPer1k / precio.inputPer1k;
  const w = primaDeEscritura1h(model);
  if (!(w > r)) return null;
  return r / (w - r);
}

/**
 * ¿Se elide en este modelo? Función PURA: `hoyUtcIso` entra por parámetro para
 * que no haya relojes escondidos y el test sea determinista.
 */
export function decidirElision(
  model: string,
  hoyUtcIso: string,
  mecanismo: FormaMedida["mecanismo"] = "sombra-v0",
): VeredictoDeElision {
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return { aplicar: false, motivo: "sin-precio" };

  const forma = FORMA_DE_TRAFICO_MEDIDA[`${clave}·${mecanismo}`];
  if (forma === undefined) return { aplicar: false, motivo: "sin-medicion" };

  if (diasEntre(VEREDICTOS_AL_DIA, hoyUtcIso) > CADUCIDAD_DIAS) {
    return { aplicar: false, motivo: "medicion-caducada", R: forma.R };
  }

  const umbral = puntoDeEquilibrio(model);
  if (umbral === null) return { aplicar: false, motivo: "sin-precio", R: forma.R };

  const aplicar = forma.R <= umbral * (1 - MARGEN_RELATIVO);
  return { aplicar, motivo: aplicar ? "aplica" : "no-compensa", R: forma.R, umbral };
}

/** Días naturales entre dos fechas YYYY-MM-DD. Infinito si alguna no es válida. */
function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}
