// SOLO tipos: `scripts/auditoria-comision-indebida.mjs` importa este módulo con
// Node a secas (sin bundler), y un import de valor sin extensión no resolvería.
import type { CatalogoDeComision, PreciosConfigurados } from "./planes";

/**
 * ¿QUÉ ORGANIZACIONES PAGAN COMISIÓN EN UN PERÍODO CERRADO?
 *
 * LA REGLA (2026-11-16): SOLO las que, durante el período, tuvieron una
 * suscripción en un Price que LLEVA COMISIÓN — la lista explícita `comision`
 * del catálogo (lib/stripe/env.ts → `catalogoDeComision`). Todas las demás
 * cierran con cargo 0 y conservan su extracto para auditoría: Pro y Equipo
 * (vivos, cancelados o impagados), las de solo «Medir», las que no tienen
 * ninguna suscripción de pago y un Enterprise sin contrato con comisión.
 *
 * Es lo que dice LICENSE-CLOUD §6(b): hay comisión «only if your subscription
 * is on a plan that the Published Pricing lists as carrying a commission»; y la
 * nota del bloque histórico de /pricing: esas condiciones «govern only
 * subscriptions that already carry the commission plan».
 *
 * EL FALLO QUE ESTO CIERRA. Hasta ese día la regla estaba AL REVÉS: se cobraba
 * comisión a toda organización con uso salvo a la marcada `comision_exenta` y a
 * la que tuviera, EN EL INSTANTE del cierre, una suscripción viva
 * (active/trialing/past_due) en Pro o Equipo. Un cliente de Pro que cancelaba
 * el día 20, o cuyo cobro quedaba `unpaid`, ya no tenía esa suscripción viva el
 * día 1 y recibía una factura de comisión por los días en que estuvo en un
 * plan de cuota fija «sin comisión». Lo mismo un Enterprise sin suscripción en
 * Stripe, o cualquier Price que el despliegue no conociera.
 *
 * QUÉ SE PUEDE SABER. `bvsala.subscriptions` guarda UNA fila por suscripción de
 * Stripe con su estado y su Price ACTUALES; no hay historial de precios. De la
 * fila se saca cuándo empezó (`created_at`) y —si está cancelada— cuándo terminó
 * (ver `finDeLaCancelada`).
 *
 * SEGURA POR CONSTRUCCIÓN (revisión del 2026-11-16). Un extracto sellado es
 * inmutable, así que la decisión tiene TRES salidas, no dos:
 *
 *   · `comision: true`  — se sella con cargo.
 *   · `comision: false, revisar: false` — se sella con cargo 0, con su motivo.
 *   · `comision: false, revisar: true`  — NO SE SELLA: el cierre salta la
 *     organización (como cuando no puede leer su primer uso), manda una alerta
 *     crítica y se relanza a mano cuando el dueño lo resuelve. La facturación
 *     tampoco la factura. Es «no lo sé», y «no lo sé» no puede quedar escrito
 *     para siempre ni como cargo ni como 0.
 *
 * Cada Price de una fila se CLASIFICA contra el catálogo (`clasificarPrecio`):
 * con comisión, sin comisión (Pro, Equipo y la lista explícita `sinComision`) o
 * DESCONOCIDO. Toda fila de la tabla es nuestra (el webhook solo inserta lo que
 * atribuye por Price o por producto), así que un Price que no está en ninguna
 * lista es uno que el despliegue no ha declarado — el caso real: los Prices de
 * comisión anteriores a la rotación del 2026-08-13 (#53,
 * scripts/provision-precios-exclusive.mjs), que quedaron SOLO en
 * STRIPE_PRICE_IDS_EXTRA. Con la primera versión de esta regla esos clientes
 * cerraban a 0 en silencio. Ahora:
 *
 *   1. PRICE DESCONOCIDO que pudo tocar el período → revisar. Se resuelve
 *      declarando el Price en STRIPE_PRICE_IDS_COMISION o en
 *      STRIPE_PRICE_IDS_SIN_COMISION (o marcando la organización
 *      `comision_exenta`, que gana a todo) y relanzando.
 *   2. Sin ninguna suscripción con comisión que pudiera tocar el período →
 *      cargo 0 (`plan_de_cuota_fija` si hubo Pro/Equipo; si no,
 *      `sin_suscripcion_con_comision`).
 *   3. MES MIXTO: comisión y un plan sin comisión en el mismo período → revisar.
 *      El extracto es mensual y no reparte el ahorro por días: cobrar el mes
 *      entero comisionaría días de cuota fija, y sellar 0 regalaría los de
 *      comisión. Cuenta como plan sin comisión también una fila de Pro/Equipo
 *      todavía `incomplete` (un checkout a medias en el instante del cierre):
 *      mañana puede estar viva.
 *   4. Comisión PROBADA y nada de lo anterior → se cobra.
 *   5. Comisión posible pero no probada (una cancelada antigua sin
 *      `last_event_at` cuyo final no se puede fijar) → revisar.
 *
 * Una suscripción `incomplete_expired` nunca llegó a activarse y no cuenta para
 * nada. `paused` SÍ cuenta (no es «nunca activada»): Stripe pausa una
 * suscripción cuya prueba termina sin medio de pago, así que estuvo viva en SU
 * Price durante la prueba. Los días de prueba llevan comisión solo si la prueba
 * fue en un Price de comisión — que es lo que dice la fila, porque el Price de
 * la fila es el de la prueba. Mientras está pausada la licencia de pago está
 * revocada («Medir», base = real) y el cargo sale 0 por el propio extracto.
 *
 * PRORRATEO: no lo hay ni lo había (el extracto es del mes natural entero). No
 * hace falta para el caso «comisión cancelada a mitad de mes»: al cancelarse,
 * la licencia de pago se revoca y la organización vuelve a «Medir», que el
 * ingest neutraliza (base = real), así que los días posteriores no aportan
 * ahorro medido y el cargo del mes ya es solo el de los días con comisión.
 *
 * LÍMITE CONOCIDO: un cambio de Price DENTRO de la misma suscripción no deja
 * rastro. De comisión a Pro, la fila ya dice Pro y el mes cierra a 0 (a favor
 * del cliente). De Pro a comisión la fila diría comisión para el mes entero.
 */

/** Estados en los que una suscripción da derecho al plan (los de `planForStatus` del webhook). */
export const ESTADOS_CON_PLAN: readonly string[] = ["active", "trialing", "past_due"];

export interface SuscripcionDeOrg {
  org_id: string;
  price_id: string | null;
  status: string;
}

/**
 * Las organizaciones con una suscripción VIVA en Pro o Equipo.
 *
 * ⛔ YA NO DECIDE EL DINERO. Fue la regla del cierre hasta el 2026-11-16 («todo
 * el que no esté aquí paga comisión») y por eso cobraba a quien había cancelado
 * Pro. Se conserva como etiqueta de «plan vivo sin comisión» para quien la
 * necesite en pantalla; el cierre y la facturación usan
 * `decidirComisionDelPeriodo`.
 */
export function orgsSinComisionPorPlan(
  suscripciones: readonly SuscripcionDeOrg[],
  precios: PreciosConfigurados,
): Set<string> {
  const fuera = new Set<string>();
  for (const s of suscripciones) {
    if (!ESTADOS_CON_PLAN.includes(s.status)) continue;
    // Lo mismo que `!llevaComision(planDelPrecio(…))` de ./planes, sin importarlo.
    if (s.price_id && (precios.pro.includes(s.price_id) || precios.equipo.includes(s.price_id))) fuera.add(String(s.org_id));
  }
  return fuera;
}

/** Todos los price ids de planes sin comisión (vacío = no hay nada que consultar). */
export function idsSinComision(precios: PreciosConfigurados): string[] {
  return [...precios.pro, ...precios.equipo];
}

// ─────────────────────────────────────────────────────────────────────────────
// LA DECISIÓN DE LA COMISIÓN DE UN PERÍODO
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que la decisión lee de una fila de `bvsala.subscriptions` (0001 + 0004 + 0012). */
export interface SuscripcionEnElPeriodo {
  org_id: string;
  price_id: string | null;
  status: string;
  /** Alta de la fila: el webhook la inserta con el primer evento de la suscripción. */
  created_at?: string | null;
  /** Cuándo se pidió la cancelación (o cuándo ocurrió, si fue inmediata). */
  canceled_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  /** `event.created` del último evento de Stripe aplicado a la fila (0012). */
  last_event_at?: string | null;
}

/** Las columnas que el cierre, la facturación y el panel piden para decidir. */
export const COLUMNAS_SUSCRIPCION_DEL_PERIODO =
  "org_id, price_id, status, created_at, canceled_at, current_period_end, cancel_at_period_end, last_event_at";

/**
 * Los estados de una suscripción que llegó a estar en su plan (y pudo dejar de
 * pagarlo). `paused` entra: ver la cabecera.
 */
export const ESTADOS_QUE_LLEVARON_EL_PLAN: readonly string[] = ["active", "trialing", "past_due", "unpaid", "canceled", "paused"];

/** El primer cobro caducó sin completarse: nunca se activó, no cuenta para nada. */
const ESTADO_NUNCA_ACTIVADA = "incomplete_expired";
/** El primer cobro sigue en el aire en el instante de decidir. */
const ESTADO_A_MEDIAS = "incomplete";

export type MotivoSinComision =
  /** No se encuentra ninguna suscripción con Price de comisión que tocara el período. */
  | "sin_suscripcion_con_comision"
  /** Tampoco, y además llevó Pro, Equipo u otro Price declarado sin comisión. */
  | "plan_de_cuota_fija";

export type MotivoDeRevision =
  /** Una fila que pudo tocar el período lleva un Price que no está en ninguna lista. */
  | "precio_desconocido"
  /** Comisión y un plan sin comisión en el mismo período (cambio de plan a mitad de mes). */
  | "plan_sin_comision_en_el_periodo"
  /** Hay una suscripción con comisión, pero sus fechas no prueban que tocara el período. */
  | "final_no_probado";

export type ComisionDelPeriodo =
  /** Una suscripción con Price de comisión tocó el período, y nada lo pone en duda. */
  | { comision: true; revisar: false; motivo: "plan_con_comision" }
  /** No lleva comisión: se sella con cargo 0. */
  | { comision: false; revisar: false; motivo: MotivoSinComision }
  /**
   * NO SE PUEDE DECIDIR: no se sella ni se factura hasta que el dueño lo
   * resuelva. `precios`: los price ids implicados (no son secretos), para la alerta.
   */
  | { comision: false; revisar: true; motivo: MotivoDeRevision; precios: string[] };

export const SIN_SUSCRIPCION: ComisionDelPeriodo = { comision: false, revisar: false, motivo: "sin_suscripcion_con_comision" };

export type ClaseDePrecio = "comision" | "sin_comision" | "desconocido";

/**
 * De qué clase es un Price, contra las listas EXPLÍCITAS del catálogo. Lo que
 * no está en ninguna —también una fila sin Price— es `desconocido`, que no es
 * ni «cobra» ni «no cobra». Un id puesto por error en una lista de comisión Y
 * en una sin comisión es sin comisión: no cobra.
 */
export function clasificarPrecio(priceId: string | null | undefined, catalogo: CatalogoDeComision): ClaseDePrecio {
  if (!priceId) return "desconocido";
  if (catalogo.pro.includes(priceId) || catalogo.equipo.includes(priceId) || (catalogo.sinComision ?? []).includes(priceId)) {
    return "sin_comision";
  }
  if (catalogo.comision.includes(priceId)) return "comision";
  return "desconocido";
}

/** Todos los price ids declarados en el catálogo, sin repetir. */
export function idsDelCatalogo(catalogo: CatalogoDeComision): string[] {
  return [...new Set([...catalogo.comision, ...catalogo.pro, ...catalogo.equipo, ...(catalogo.sinComision ?? [])])];
}

function ms(fecha: string | null | undefined): number | null {
  if (!fecha) return null;
  const t = Date.parse(fecha);
  return Number.isFinite(t) ? t : null;
}

/** [desde, hasta) del período YYYY-MM, en UTC como el cierre. */
function limitesDelPeriodo(periodo: string): { desde: number; hasta: number } {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error(`período inválido: "${periodo}" (se espera YYYY-MM)`);
  const [y, m] = periodo.split("-").map(Number);
  return { desde: Date.UTC(y!, m! - 1, 1), hasta: Date.UTC(y!, m!, 1) };
}

/**
 * CUÁNDO TERMINÓ UNA SUSCRIPCIÓN CANCELADA. La tabla no guarda `ended_at`, así
 * que se reconstruye con lo que hay, SIN fiarse de `cancel_at_period_end`: el
 * portal cancela a fin de ciclo (scripts/provision-portal.mjs) y es la salida
 * normal de un cliente con comisión, pero según la versión de la API Stripe
 * puede entregar el objeto borrado con esa marca a `false`, y entonces el
 * último mes parcial —`canceled_at` es el día en que se PIDIÓ, a menudo del mes
 * anterior— se quedaba sin cobrar.
 *
 *   fin = max(canceled_at, min(current_period_end, last_event_at))
 *
 * · `status = canceled` solo lo escribe `customer.subscription.deleted`, que
 *   Stripe emite en el instante en que la suscripción termina: `last_event_at`
 *   (0012) es ese instante, o uno posterior si después llegó otro evento.
 * · A fin de ciclo, el final ES `current_period_end` y `last_event_at` ≈ igual.
 * · Cancelación inmediata: `current_period_end` queda en el futuro,
 *   `last_event_at` = `canceled_at`; el mínimo la deja en su día.
 * · El mínimo con `current_period_end` acota el caso de un evento tardío (una
 *   factura pagada tras la baja) que adelantaría `last_event_at`. Cota: ese
 *   evento tardío puede alargar el final como mucho hasta el fin del ciclo ya
 *   pagado; los días de más son de «Medir» y no aportan ahorro medido.
 *
 * Fila anterior a 0012 (sin `last_event_at`): lo PROBADO es `canceled_at`, o
 * `current_period_end` si la marca dice fin de ciclo; lo POSIBLE, la más tardía
 * de las dos. Si difieren, la decisión es «revisar», no un 0 callado.
 *
 * `null` = no hay ninguna fecha con la que saberlo.
 */
function finDeLaCancelada(s: SuscripcionEnElPeriodo, modo: "probado" | "posible"): number | null {
  const cancelada = ms(s.canceled_at);
  const finDeCiclo = ms(s.current_period_end);
  const ultimoEvento = ms(s.last_event_at);
  let candidatos: Array<number | null>;
  if (ultimoEvento !== null && finDeCiclo !== null) candidatos = [cancelada, Math.min(finDeCiclo, ultimoEvento)];
  else if (ultimoEvento !== null) candidatos = modo === "probado" ? [cancelada] : [cancelada, ultimoEvento];
  else candidatos = modo === "probado" ? [cancelada, s.cancel_at_period_end === true ? finDeCiclo : null] : [cancelada, finDeCiclo];
  const conocidos = candidatos.filter((t): t is number => t !== null);
  return conocidos.length === 0 ? null : Math.max(...conocidos);
}

/**
 * ¿Tocó esta suscripción el período?
 *
 * `probado`: solo si las fechas de la fila lo DEMUESTRAN (para cobrar).
 * `posible`: salvo que las fechas demuestren lo contrario (para dudar). Sin
 * fechas, cuenta.
 */
function tocoElPeriodo(s: SuscripcionEnElPeriodo, periodo: string, modo: "probado" | "posible"): boolean {
  const { desde, hasta } = limitesDelPeriodo(periodo);
  const inicio = ms(s.created_at);
  if (inicio === null ? modo === "probado" : inicio >= hasta) return false;
  if (s.status !== "canceled") return true;
  const fin = finDeLaCancelada(s, modo);
  if (fin === null) return modo === "posible";
  return fin >= desde;
}

const precios = (filas: readonly SuscripcionEnElPeriodo[]): string[] =>
  [...new Set(filas.map((s) => s.price_id ?? "(sin price_id)"))].sort();

/**
 * La decisión para UNA organización, con TODAS sus filas de suscripción (no
 * solo las del catálogo: una fila con un Price sin declarar es justo lo que
 * impide sellar).
 */
export function decidirComisionDelPeriodo(
  suscripciones: readonly SuscripcionEnElPeriodo[],
  catalogo: CatalogoDeComision,
  periodo: string,
): ComisionDelPeriodo {
  limitesDelPeriodo(periodo); // un período mal formado no se decide a ojo, ni con cero filas
  const vivas = suscripciones.filter((s) => s.status !== ESTADO_NUNCA_ACTIVADA);
  const posibles = vivas.filter((s) => tocoElPeriodo(s, periodo, "posible"));

  // 1) Un Price sin declarar que pudo tocar el período: no se sabe si lleva comisión.
  const desconocidas = posibles.filter((s) => clasificarPrecio(s.price_id, catalogo) === "desconocido");
  if (desconocidas.length > 0) return { comision: false, revisar: true, motivo: "precio_desconocido", precios: precios(desconocidas) };

  // Un estado que este código no conoce (Stripe añade alguno de tarde en tarde)
  // tampoco se decide a ojo: cuenta como «pudo llevar el plan».
  const llevoElPlan = (s: SuscripcionEnElPeriodo) => s.status !== ESTADO_A_MEDIAS;
  const deComision = posibles.filter((s) => clasificarPrecio(s.price_id, catalogo) === "comision" && llevoElPlan(s));
  // Para el plan sin comisión cuenta también la que está a medias (ver cabecera, punto 3).
  const sinComision = posibles.filter((s) => clasificarPrecio(s.price_id, catalogo) === "sin_comision");

  // 2) Ninguna suscripción con comisión pudo tocar el período: cargo 0.
  if (deComision.length === 0) {
    const planoQueLoLlevo = sinComision.some(llevoElPlan);
    return { comision: false, revisar: false, motivo: planoQueLoLlevo ? "plan_de_cuota_fija" : "sin_suscripcion_con_comision" };
  }
  // 3) El mes mixto.
  if (sinComision.length > 0) {
    return { comision: false, revisar: true, motivo: "plan_sin_comision_en_el_periodo", precios: precios([...deComision, ...sinComision]) };
  }
  // 4) Comisión probada.
  if (deComision.some((s) => ESTADOS_QUE_LLEVARON_EL_PLAN.includes(s.status) && tocoElPeriodo(s, periodo, "probado"))) {
    return { comision: true, revisar: false, motivo: "plan_con_comision" };
  }
  // 5) Posible, no probada.
  return { comision: false, revisar: true, motivo: "final_no_probado", precios: precios(deComision) };
}

/**
 * La decisión de todas las organizaciones que aparecen en las filas leídas. Una
 * organización AUSENTE del mapa no tiene ninguna fila de suscripción:
 * `comisionDe` le da «sin_suscripcion_con_comision» — cargo 0.
 */
export function comisionPorOrg(
  suscripciones: readonly SuscripcionEnElPeriodo[],
  catalogo: CatalogoDeComision,
  periodo: string,
): Map<string, ComisionDelPeriodo> {
  const porOrg = new Map<string, SuscripcionEnElPeriodo[]>();
  for (const s of suscripciones) {
    const id = String(s.org_id);
    const lista = porOrg.get(id) ?? [];
    lista.push(s);
    porOrg.set(id, lista);
  }
  const decisiones = new Map<string, ComisionDelPeriodo>();
  for (const [id, filas] of porOrg) decisiones.set(id, decidirComisionDelPeriodo(filas, catalogo, periodo));
  return decisiones;
}

export function comisionDe(decisiones: ReadonlyMap<string, ComisionDelPeriodo>, orgId: string): ComisionDelPeriodo {
  return decisiones.get(orgId) ?? SIN_SUSCRIPCION;
}
