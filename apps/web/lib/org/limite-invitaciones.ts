import { RateLimiter } from "@/lib/rate-limit";
import { ESTADOS_CON_PLAN } from "@/lib/billing/plan-de-la-org";

/**
 * EL TOPE DE LAS INVITACIONES (auditoría del lanzamiento, 2026-11-19).
 *
 * Invitar manda un correo desde `no-reply@bivelio.com` a una dirección que
 * elige el usuario. Sin tope, cualquier cuenta gratuita podía usar la ruta de
 * REPETIDOR: cientos de correos con nuestro remitente a quien quisiera, y de
 * paso agotar la cuota de Resend que comparte el hook de auth — que es
 * fail-closed: sin cuota, nadie confirma su alta ni recupera su contraseña.
 *
 * DOS TOPES, y cubren cosas distintas:
 *
 *  · POR ORGANIZACIÓN, en la base de datos. Es el que aguanta: no depende de la
 *    instancia que atienda la petición. Se cuenta sobre `billing_audit`
 *    (append-only), NO sobre `org_invitations`: reinvitar y revocar BORRAN la
 *    fila de la invitación, así que contar ahí se saltaría con «invitar,
 *    revocar, invitar». Sin migración: la tabla ya existe y ya guarda los
 *    eventos del equipo (`org_member_removed`, …).
 *
 *  · POR USUARIO, en memoria (lib/rate-limit.ts). Frena la ráfaga de una sesión
 *    (10 por hora) y acota con su tope global (1.000 por hora y por instancia)
 *    lo que esta ruta puede gastar de la cuota de correo pase lo que pase. Es el
 *    cinturón; el de la base es el airbag.
 */

/** El `kind` con el que queda apuntado cada correo de invitación que se intenta. */
export const KIND_INVITACION = "org_invitation_sent";

/** Ventana del tope por organización. */
export const VENTANA_ORG_MS = 24 * 60 * 60_000;
/** Con una suscripción viva: un equipo entero se da de alta en un día. */
export const TOPE_ORG_DE_PAGO = 20;
/** Sin pagar: lo que necesita un equipo pequeño que está probando. */
export const TOPE_ORG_GRATIS = 5;

/** Ventana y topes del limitador en memoria (por usuario / total de la ruta). */
export const VENTANA_USUARIO_MS = 60 * 60_000;
export const TOPE_USUARIO = 10;
/**
 * Total de la ruta por hora y por instancia. Era 100; el dueño lo subió a 1.000
 * (2026-11-19) porque en el pico del lanzamiento 100 por hora dejaba fuera a
 * equipos legítimos dándose de alta a la vez. No es el freno del abuso —ese es
 * el tope por organización en la base y el de cada usuario—: es el techo de lo
 * que esta ruta puede gastar de la cuota de correo en una hora si todo lo demás
 * falla.
 */
export const TOPE_GLOBAL = 1_000;

export const limitePorUsuario = new RateLimiter(VENTANA_USUARIO_MS, TOPE_USUARIO, TOPE_GLOBAL);

/** El mínimo del cliente de Supabase que hace falta aquí (y que un doble imita). */
interface Consulta extends PromiseLike<{ data?: unknown; count?: number | null; error: unknown }> {
  eq(col: string, val: unknown): Consulta;
  in(col: string, vals: readonly unknown[]): Consulta;
  gte(col: string, val: unknown): Consulta;
  limit(n: number): Consulta;
}
interface Cliente {
  from(tabla: string): {
    select(cols: string, opts?: { count?: "exact"; head?: boolean }): unknown;
  };
}

export type Cupo =
  | { ok: true; usadas: number; tope: number }
  | { ok: false; motivo: "tope"; usadas: number; tope: number }
  /** No se pudo contar. Falla CERRADA: sin cuenta no sale correo. */
  | { ok: false; motivo: "error" };

/**
 * ¿Le queda cupo a la organización para mandar otra invitación?
 * No contabiliza: quien llama apunta el envío con `KIND_INVITACION` después.
 */
export async function cupoDeLaOrg(admin: unknown, orgId: string, ahora: Date = new Date()): Promise<Cupo> {
  const db = admin as Cliente;

  // ¿Paga? Si la consulta falla se aplica el tope bajo: equivocarse hacia
  // «gratis» retrasa a un cliente de pago unas invitaciones; hacia «de pago»
  // le regala el tope alto a quien no lo tiene.
  let dePago = false;
  try {
    const { data, error } = await (db.from("subscriptions").select("id") as Consulta)
      .eq("org_id", orgId)
      .in("status", ESTADOS_CON_PLAN)
      .limit(1);
    dePago = !error && Array.isArray(data) && data.length > 0;
  } catch {
    dePago = false;
  }
  const tope = dePago ? TOPE_ORG_DE_PAGO : TOPE_ORG_GRATIS;

  const desde = new Date(ahora.getTime() - VENTANA_ORG_MS).toISOString();
  try {
    const { count, error } = await (
      db.from("billing_audit").select("id", { count: "exact", head: true }) as Consulta
    )
      .eq("org_id", orgId)
      .eq("kind", KIND_INVITACION)
      .gte("at", desde);
    if (error || typeof count !== "number") return { ok: false, motivo: "error" };
    return count >= tope ? { ok: false, motivo: "tope", usadas: count, tope } : { ok: true, usadas: count, tope };
  } catch {
    return { ok: false, motivo: "error" };
  }
}
