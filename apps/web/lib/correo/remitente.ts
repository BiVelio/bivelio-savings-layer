/**
 * DE QUIÉN SALEN LOS CORREOS DE SAVINGS — configurable, con los valores de siempre por defecto.
 *
 * POR QUÉ EXISTE. Todos los correos de esta app (auth, invitaciones, la petición
 * de llamada y las alertas) salen por la cuenta de Resend que comparten Savings,
 * Privacy y GPOS, desde el dominio verificado `bivelio.com`. Para que Savings
 * tenga su propia cuenta de Resend hace falta un dominio (o subdominio) de envío
 * verificado EN ESA cuenta, y entonces el remitente cambia. Hasta hoy estaba
 * escrito en cuatro sitios; ahora sale de aquí.
 *
 *   BVSALA_CORREO_REMITENTE           remitente de auth, invitaciones y contacto
 *   BVSALA_CORREO_RESPONDER_A         a dónde van las respuestas (reply_to)
 *   BVSALA_CORREO_REMITENTE_ALERTAS   remitente de las alertas críticas; si no
 *                                     está, se usa BVSALA_CORREO_REMITENTE
 *
 * Vacías (hoy) = exactamente lo de antes. Un valor que no parezca una dirección
 * (o «Nombre <dirección>») se IGNORA con un aviso: una errata no puede dejar sin
 * correo a nadie de una forma nueva; como mucho deja el remitente de siempre.
 * La clave de Resend sigue siendo `RESEND_API_KEY`: cambiar de cuenta es cambiar
 * su VALOR en Vercel, sin tocar código.
 */

/** Lo que leemos del entorno; `process.env` en producción, un objeto en los tests. */
export type Entorno = Readonly<Record<string, string | undefined>>;

export const REMITENTE_POR_DEFECTO = "BiVelio <no-reply@bivelio.com>";
export const RESPUESTAS_POR_DEFECTO = "support@bivelio.com";
export const REMITENTE_ALERTAS_POR_DEFECTO = "BiVelio Savings <alertas@bivelio.com>";

export const VAR_REMITENTE = "BVSALA_CORREO_REMITENTE";
export const VAR_RESPONDER_A = "BVSALA_CORREO_RESPONDER_A";
export const VAR_REMITENTE_ALERTAS = "BVSALA_CORREO_REMITENTE_ALERTAS";

const DIRECCION = /^[^\s@<>",;]+@[^\s@<>",;.]+(?:\.[^\s@<>",;.]+)+$/;
const CON_NOMBRE = /^([^<>"\r\n,;]{1,80}) <([^<>\s]+)>$/;

/** ¿Es «dirección» o «Nombre <dirección>»? Sin saltos de línea: irían a una cabecera. */
export function esRemitenteValido(v: string): boolean {
  if (v.length > 200 || /[\r\n]/.test(v)) return false;
  const m = v.match(CON_NOMBRE);
  return DIRECCION.test(m ? m[2]! : v);
}

function leer(env: Entorno, nombre: string): string | undefined {
  const v = env[nombre]?.trim();
  if (!v) return undefined;
  if (esRemitenteValido(v)) return v;
  console.warn(`[correo] ${nombre} no es una dirección válida: se usa la de siempre`);
  return undefined;
}

export function remitente(env: Entorno = process.env): string {
  return leer(env, VAR_REMITENTE) ?? REMITENTE_POR_DEFECTO;
}

export function responderA(env: Entorno = process.env): string {
  return leer(env, VAR_RESPONDER_A) ?? RESPUESTAS_POR_DEFECTO;
}

/**
 * Las alertas, con su propia variable y, si no, el remitente general: al mudar
 * Savings a su propia cuenta de Resend basta con poner BVSALA_CORREO_REMITENTE
 * para que las alertas críticas no se queden saliendo de un dominio que esa
 * cuenta no tiene verificado (y no llegando).
 */
export function remitenteDeAlertas(env: Entorno = process.env): string {
  return leer(env, VAR_REMITENTE_ALERTAS) ?? leer(env, VAR_REMITENTE) ?? REMITENTE_ALERTAS_POR_DEFECTO;
}
