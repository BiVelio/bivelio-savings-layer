import { planDelPrecio, llevaComision, type CatalogoDeComision, type PreciosConfigurados } from "./planes";

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
 * fila se saca: cuándo empezó (`created_at`), y —si está cancelada— cuándo
 * terminó (`canceled_at`, o `current_period_end` si se canceló a fin de ciclo).
 * Con eso, la regla es la más prudente que sigue siendo verdad:
 *
 *   1. Hay comisión solo si se PRUEBA una suscripción con Price de comisión que
 *      tocó el período: empezó antes de que acabara y, si está cancelada, su
 *      final probado no es anterior al comienzo. Lo que no se puede probar
 *      (fechas ausentes, Price desconocido) no cobra.
 *   2. Si en el mismo período la organización tuvo TAMBIÉN una suscripción de
 *      Pro o Equipo (cambio de plan a mitad de mes), el cargo es 0: el extracto
 *      es mensual y no reparte el ahorro por días, así que cobrar el mes entero
 *      comisionaría días de cuota fija. Aquí la duda se resuelve a favor del
 *      cliente («pudo tocar el período» basta) y el cierre AVISA para que el
 *      dueño lo revise a mano.
 *   3. Una suscripción que nunca llegó a activarse (`incomplete`,
 *      `incomplete_expired`) no cuenta para nada.
 *
 * PRORRATEO: no lo hay ni lo había (el extracto es del mes natural entero). No
 * hace falta para el caso «comisión cancelada a mitad de mes»: al cancelarse,
 * la licencia de pago se revoca y la organización vuelve a «Medir», que el
 * ingest neutraliza (base = real), así que los días posteriores no aportan
 * ahorro medido y el cargo del mes ya es solo el de los días con comisión.
 *
 * LÍMITE CONOCIDO: un cambio de Price DENTRO de la misma suscripción no deja
 * rastro. De comisión a Pro, la fila ya dice Pro y el mes cierra a 0 (a favor
 * del cliente). De Pro a comisión —que no se vende y solo puede hacerse a mano
 * en Stripe— la fila diría comisión para el mes entero.
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
    if (!llevaComision(planDelPrecio(s.price_id, precios))) fuera.add(String(s.org_id));
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

/** Lo que la decisión lee de una fila de `bvsala.subscriptions` (0001 + 0004). */
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
}

/** Las columnas que el cierre, la facturación y el panel piden para decidir. */
export const COLUMNAS_SUSCRIPCION_DEL_PERIODO =
  "org_id, price_id, status, created_at, canceled_at, current_period_end, cancel_at_period_end";

/** Los estados de una suscripción que llegó a estar en su plan (y pudo dejar de pagarlo). */
export const ESTADOS_QUE_LLEVARON_EL_PLAN: readonly string[] = ["active", "trialing", "past_due", "unpaid", "canceled"];

/** Nunca se activó: el primer cobro no llegó a completarse. No cuenta para nada. */
const ESTADOS_NUNCA_ACTIVADA: readonly string[] = ["incomplete", "incomplete_expired"];

export type ComisionDelPeriodo =
  /** Una suscripción con Price de comisión tocó el período, y ninguna de Pro/Equipo. */
  | { comision: true }
  | {
      comision: false;
      motivo:
        /** No se prueba ninguna suscripción con Price de comisión en el período. */
        | "sin_suscripcion_con_comision"
        /** La hubo, pero en el mismo período hubo también Pro o Equipo: cargo 0 y revisión a mano. */
        | "plan_sin_comision_en_el_periodo";
    };

/** Todos los price ids que la decisión necesita ver (vacío = no hay nada que consultar). */
export function idsDelCatalogo(catalogo: CatalogoDeComision): string[] {
  return [...new Set([...catalogo.comision, ...catalogo.pro, ...catalogo.equipo])];
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
 * ¿Tocó esta suscripción el período?
 *
 * `probado`: solo si las fechas de la fila lo DEMUESTRAN (para cobrar). El final
 * de una cancelada es `canceled_at`, o `current_period_end` si se canceló a fin
 * de ciclo (ahí `canceled_at` es el día en que se pidió, anterior al final).
 *
 * `posible`: salvo que las fechas demuestren lo contrario (para NO cobrar). Sin
 * fechas, cuenta; y el final es la más tardía de las dos.
 */
function tocoElPeriodo(s: SuscripcionEnElPeriodo, periodo: string, modo: "probado" | "posible"): boolean {
  const { desde, hasta } = limitesDelPeriodo(periodo);
  const inicio = ms(s.created_at);
  if (inicio === null ? modo === "probado" : inicio >= hasta) return false;
  if (s.status !== "canceled") return true;
  const cancelada = ms(s.canceled_at);
  const finDeCiclo = ms(s.current_period_end);
  const candidatos =
    modo === "probado" ? [cancelada, s.cancel_at_period_end === true ? finDeCiclo : null] : [cancelada, finDeCiclo];
  const conocidos = candidatos.filter((t): t is number => t !== null);
  if (conocidos.length === 0) return modo === "posible";
  return Math.max(...conocidos) >= desde;
}

/**
 * La decisión para UNA organización, con todas sus filas de suscripción (las
 * del catálogo bastan; las demás se ignoran).
 */
export function decidirComisionDelPeriodo(
  suscripciones: readonly SuscripcionEnElPeriodo[],
  catalogo: CatalogoDeComision,
  periodo: string,
): ComisionDelPeriodo {
  const esPlano = (id: string | null) => id !== null && (catalogo.pro.includes(id) || catalogo.equipo.includes(id));
  // Un id que alguien haya puesto en las dos listas es de cuota fija: no cobra.
  const esDeComision = (id: string | null) => id !== null && catalogo.comision.includes(id) && !esPlano(id);

  const conComision = suscripciones.some(
    (s) => esDeComision(s.price_id) && ESTADOS_QUE_LLEVARON_EL_PLAN.includes(s.status) && tocoElPeriodo(s, periodo, "probado"),
  );
  if (!conComision) return { comision: false, motivo: "sin_suscripcion_con_comision" };

  const conPlanPlano = suscripciones.some(
    (s) => esPlano(s.price_id) && !ESTADOS_NUNCA_ACTIVADA.includes(s.status) && tocoElPeriodo(s, periodo, "posible"),
  );
  if (conPlanPlano) return { comision: false, motivo: "plan_sin_comision_en_el_periodo" };

  return { comision: true };
}

/**
 * La decisión de todas las organizaciones que aparecen en las filas leídas. Una
 * organización AUSENTE del mapa no tiene ninguna suscripción del catálogo:
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
  return decisiones.get(orgId) ?? { comision: false, motivo: "sin_suscripcion_con_comision" };
}
