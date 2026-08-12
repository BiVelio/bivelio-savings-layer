import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * INVITACIONES. La parte pura: acuñar el token, guardarlo como hash, y decidir si
 * una invitación se puede aceptar.
 *
 * El fallo caro de esta superficie no es técnico, es de criterio: **un enlace de
 * invitación es una credencial**. Quien lo tenga entra en la organización de otra
 * empresa y —según el rol— se lleva su licencia firmada. Por eso aquí no basta con
 * "el token es válido": tiene que coincidir además el CORREO del usuario
 * autenticado. Sin esa comprobación, un enlace reenviado por error a una lista de
 * distribución mete a quien lo pille.
 */

/** El prefijo hace reconocible el secreto en un registro o en un pantallazo. */
const PREFIJO = "bvi_";

/** Siete días. Suficiente para unas vacaciones cortas y poco para un enlace
 *  olvidado en una bandeja de entrada durante meses. */
export const DIAS_DE_VIGENCIA = 7;

export interface TokenAcunado {
  /** El secreto. Se enseña UNA vez, dentro del enlace del correo. */
  token: string;
  /** Lo único que se guarda. Igual que `service_accounts.key_hash`. */
  hash: string;
  /** ISO. */
  expiraEn: string;
}

/**
 * Un token nuevo. 32 bytes de `randomBytes` — no `Math.random`, que es predecible
 * y convertiría el enlace en adivinable.
 */
export function acunarToken(ahora: Date = new Date()): TokenAcunado {
  const token = `${PREFIJO}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    hash: hashDeToken(token),
    expiraEn: new Date(ahora.getTime() + DIAS_DE_VIGENCIA * 86_400_000).toISOString(),
  };
}

export function hashDeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Comparación en tiempo constante de dos hashes hex.
 *
 * La búsqueda va por `token_hash` con un índice único, así que el tiempo de la
 * consulta ya filtra; esto cubre el resto de comparaciones. `timingSafeEqual`
 * LANZA si las longitudes difieren, así que se comprueba antes — un token de otra
 * longitud no puede convertirse en un 500.
 */
export function mismoHash(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Normaliza un correo para comparar: sin espacios y en minúsculas. NO se tocan
 *  los puntos ni los `+`: `a.b@gmail.com` y `ab@gmail.com` son la misma cuenta en
 *  Gmail pero NO en la mayoría de servidores corporativos, y aquí una equivalencia
 *  de más significa dejar entrar a quien no es. */
export function normalizarCorreo(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export interface Invitacion {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
}

export type Veredicto =
  | { ok: true }
  /** No existe, o el token no casa. Mismo mensaje que `caducada` hacia fuera. */
  | { ok: false; motivo: "invalida" }
  | { ok: false; motivo: "caducada" }
  | { ok: false; motivo: "ya_aceptada" }
  /** El token es bueno pero el correo del que ha iniciado sesión es OTRO. */
  | { ok: false; motivo: "otro_correo" };

/**
 * ¿Se puede aceptar esta invitación?
 *
 * El orden importa: primero lo que no depende de quién mira (caducada, ya
 * aceptada) y al final la identidad. Así el mensaje "esta invitación no es tuya"
 * solo aparece cuando la invitación sigue viva, y no se convierte en un oráculo
 * para averiguar si una dirección concreta tiene una invitación pendiente.
 */
export function sePuedeAceptar(
  inv: Invitacion | null,
  correoDelUsuario: string | null | undefined,
  ahora: Date = new Date(),
): Veredicto {
  if (!inv) return { ok: false, motivo: "invalida" };
  if (inv.accepted_at) return { ok: false, motivo: "ya_aceptada" };
  const expira = Date.parse(inv.expires_at);
  // Una fecha ilegible se trata como caducada. Fallar hacia "no entra" es lo
  // barato; fallar hacia "entra" mete a un tercero en la organización de un
  // cliente.
  if (!Number.isFinite(expira) || expira <= ahora.getTime()) return { ok: false, motivo: "caducada" };

  const suyo = normalizarCorreo(correoDelUsuario);
  const invitado = normalizarCorreo(inv.email);
  if (!suyo || !invitado || suyo !== invitado) return { ok: false, motivo: "otro_correo" };

  return { ok: true };
}

/** Los roles que se pueden invitar. `owner` NO: se transfiere, no se invita —y la
 *  base lo rechaza igualmente (`check` de 0013), pero un 400 claro es mejor que un
 *  500 con un error de Postgres dentro. */
export const ROLES_INVITABLES = ["admin", "member", "billing"] as const;
export type RolInvitable = (typeof ROLES_INVITABLES)[number];

export function esRolInvitable(rol: unknown): rol is RolInvitable {
  return typeof rol === "string" && (ROLES_INVITABLES as readonly string[]).includes(rol);
}

/** El enlace que va en el correo. El token viaja en el fragmento de ruta y no en
 *  la query: las query strings acaban en los registros de los proxies y en el
 *  `Referer` de la siguiente navegación. */
export function enlaceDeInvitacion(origen: string, locale: string, token: string): string {
  const loc = /^[a-z]{2}$/.test(locale) ? locale : "es";
  return `${origen.replace(/\/$/, "")}/${loc}/invitacion/${encodeURIComponent(token)}`;
}
