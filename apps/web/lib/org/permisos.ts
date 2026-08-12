/**
 * QUÉ PUEDE HACER CADA ROL. Tabla pura, sin base de datos y sin red.
 *
 * Los cuatro roles existen en el esquema desde 0001 (`org_members.role`, con su
 * `check`), y hasta ahora NINGUNA ruta los miraba. Daba igual porque cada
 * organización tenía exactamente un miembro; deja de dar igual en cuanto se pueda
 * invitar a alguien, y entonces el agujero es concreto:
 * `/api/license/current` entrega el **token firmado completo** de la organización
 * a cualquier miembro, y `/api/service-accounts` acuña una `bvk_` que sirve para
 * descargar ese mismo token desde cualquier máquina del mundo.
 *
 * Por eso esta fase va ANTES que las invitaciones y no después: sin ella, invitar
 * a un becario a ver el panel de gasto le da también la credencial de producción.
 *
 * ⚠️ NO se resuelve con una función `SECURITY DEFINER` en Postgres. Resolvería por
 * `auth.uid()`, y TODAS las decisiones de autorización de este producto se toman
 * con el cliente `service_role`, donde `auth.uid()` es NULL siempre: devolvería
 * NULL en el 100 % de los casos y —según cómo se interpretara— o deniega todo o
 * abre todo. El rol se lee con el resolvedor y se comprueba aquí.
 */

/** Las acciones que el producto sabe distinguir. */
export type Accion =
  /** Ver el panel: gasto, ahorro, asientos. No incluye credenciales. */
  | "ver_panel"
  /** Descargar el TOKEN de licencia firmado desde la sesión del navegador. */
  | "descargar_licencia"
  /** Acuñar o revocar claves de servicio `bvk_` — la otra puerta al mismo token. */
  | "gestionar_claves"
  /** Abrir un checkout: mueve dinero real. */
  | "comprar"
  /** Entrar al portal de Stripe: tarjeta, facturas, cancelar, cambiar asientos. */
  | "gestionar_facturacion"
  /** Invitar, cambiar el rol de alguien o expulsarlo (fase 8). */
  | "gestionar_miembros"
  /** Transferir la propiedad de la organización (fase 8). */
  | "transferir_propiedad";

/**
 * La tabla. Se lee por filas: «un `billing` puede ver el panel, comprar y
 * gestionar la facturación, y nada más».
 *
 * El criterio que separa `billing` de `admin` es el que importa para vender: quien
 * lleva las facturas de una empresa NO tiene por qué poder descargarse la
 * credencial de producción. Son dos trabajos distintos y hasta ahora eran el mismo
 * permiso.
 *
 * `member` es deliberadamente pobre: ve el panel y ya. No es un castigo, es el
 * valor por defecto correcto — `org_members.role` tiene `default 'member'`
 * (0001:44), así que es lo que le toca a quien entre por un camino que todavía no
 * exista. Un valor por defecto tiene que ser el que menos daño haga.
 *
 * ES UN `Map` Y NO UN OBJETO LITERAL, a propósito. Con un objeto, `TABLA["constructor"]`
 * devuelve una función y `TABLA["__proto__"]` el prototipo: `.includes` sobre eso
 * no es que conceda de más, es que LANZA, y la ruta responde 500 en vez de 403. El
 * rol sale de una fila de base de datos, así que "esa cadena nunca llegará" no es
 * una garantía que se pueda dar. Un `Map` no tiene claves heredadas.
 */
const TABLA = new Map<string, readonly Accion[]>(Object.entries({
  owner: [
    "ver_panel",
    "descargar_licencia",
    "gestionar_claves",
    "comprar",
    "gestionar_facturacion",
    "gestionar_miembros",
    "transferir_propiedad",
  ],
  // Todo menos transferir la propiedad: eso solo lo hace quien la tiene, o un
  // administrador podría quedarse con la organización de su empresa.
  admin: [
    "ver_panel",
    "descargar_licencia",
    "gestionar_claves",
    "comprar",
    "gestionar_facturacion",
    "gestionar_miembros",
  ],
  // El dinero, sin las credenciales.
  billing: ["ver_panel", "comprar", "gestionar_facturacion"],
  member: ["ver_panel"],
} as Record<string, readonly Accion[]>));

/**
 * ¿Puede este rol hacer esto?
 *
 * FALLA CERRADA ante lo desconocido, y esa es la mitad del valor de este fichero.
 * Un rol que no esté en la tabla —una fila con un valor raro, un rol nuevo que se
 * añada al `check` de la base y se olvide aquí, `null`, `undefined`, `"Owner"` con
 * mayúscula— no concede NADA. La alternativa (asumir el rol más generoso, o
 * tratar lo desconocido como `member`) convierte cualquier despiste futuro en una
 * fuga de credenciales silenciosa.
 */
export function puede(rol: string | null | undefined, accion: Accion): boolean {
  if (!rol) return false;
  return TABLA.get(rol)?.includes(accion) ?? false;
}

/** Los roles que la tabla conoce. Para tests y para la interfaz de la fase 8. */
export function rolesConocidos(): string[] {
  return [...TABLA.keys()];
}

/**
 * El mensaje que se le devuelve a quien no puede. NO dice qué rol tiene ni cuál
 * haría falta: quien pide algo que no le toca no necesita un mapa de la
 * organización, y a quien lo pide sondeando tampoco se le regala uno.
 */
export const NO_AUTORIZADO = "Your role doesn't allow this. Ask an owner or admin.";
