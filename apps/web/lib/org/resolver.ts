import type { AdminClient } from "@/lib/supabase/admin";

/**
 * QUÉ ORGANIZACIÓN ES LA DE ESTE USUARIO. La única respuesta del producto.
 *
 * Hasta ahora no había ninguna: `org_id == user_id` era una convención de la
 * aplicación repetida en 21 puntos de llamada de 7 ficheros, y las DOS únicas
 * copias del código correcto (`api/license/current/route.ts:156` y
 * `api/license/trial/route.ts:36`) no estaban compartidas, así que cada ruta
 * nueva volvía a elegir mal.
 *
 * ⚠️ LO QUE NO HACE, Y ES DELIBERADO: no renumera nada. Las organizaciones cuyo
 * id coincide con un user id se quedan exactamente como están. Cambiar un
 * `organizations.id` apagaría la flota del cliente que paga — el `org_id` va
 * FIRMADO dentro de las licencias ya desplegadas y `src/license/refresher.ts:155`
 * descarta en silencio cualquier token renovado cuyo org no case. Y no pasaría ni
 * de la base: las 8 claves ajenas contra `organizations(id)` están sin
 * `on update cascade`, y tres llevan `org_id` dentro de su clave primaria.
 * Ver `docs/PLAN-ORGANIZACION-REAL.md`.
 *
 * Usa el cliente ADMIN a propósito: `org_members` tiene RLS, y la resolución
 * tiene que ocurrir ANTES de saber en qué organización estás. El `userId` tiene
 * que venir SIEMPRE de una sesión verificada (`supabase.auth.getUser()`), nunca
 * del cuerpo de una petición: esto salta la RLS.
 */

export interface OrgResuelta {
  orgId: string;
  /** El rol del usuario en ella. Declarado desde 0001 y hasta ahora nunca leído. */
  role: string;
}

interface FilaDePertenencia {
  org_id: string;
  role: string;
  created_at: string;
}

/** Estados de suscripción en los que la organización está pagando o su dinero va en camino. */
const PAGANDO = ["active", "trialing", "past_due", "incomplete"];

/**
 * La organización del usuario, o `null` si no pertenece a ninguna. SOLO LEE.
 *
 * EL DESEMPATE ES EXPLÍCITO Y ESO ES EL PUNTO. Hoy `data.ts:98` y
 * `license/current:157` hacen `.limit(1)` SIN `order`, así que Postgres devuelve
 * una fila arbitraria: con dos pertenencias, la organización que ves puede
 * cambiar entre dos peticiones seguidas — y con ella la licencia, los asientos y
 * la factura. Orden, de más a menos importante:
 *
 *   1. la que tenga una suscripción viva (es de la que cuelga el dinero);
 *   2. `org_id == userId` (la convención heredada: conserva lo que ya veía);
 *   3. la más antigua.
 *
 * Nadie pertenece hoy a dos organizaciones (comprobado en producción, 2026-08-12),
 * así que esto no cambia nada ahora mismo. Existe para que el día que ocurra no
 * sea un sorteo.
 */
export async function resolverOrgSiExiste(
  admin: AdminClient,
  userId: string,
): Promise<OrgResuelta | null> {
  if (!userId) return null;

  const { data, error } = await admin
    .from("org_members")
    .select("org_id, role, created_at")
    .eq("user_id", userId);
  if (error) throw error; // falla CERRADA: quien llama devuelve 503, nunca cae a user.id
  const filas = (data ?? []) as FilaDePertenencia[];
  if (filas.length === 0) return null;
  if (filas.length === 1) return { orgId: filas[0]!.org_id, role: filas[0]!.role };

  // Solo se consulta el estado de las suscripciones cuando de verdad hay que
  // desempatar. Es el caso raro y no merece un viaje en cada carga del panel.
  const { data: subs, error: subErr } = await admin
    .from("subscriptions")
    .select("org_id, status")
    .in("org_id", filas.map((f) => f.org_id));
  if (subErr) throw subErr;
  const conDinero = new Set(
    ((subs ?? []) as { org_id: string; status: string }[])
      .filter((s) => PAGANDO.includes(s.status))
      .map((s) => s.org_id),
  );

  const ordenadas = [...filas].sort((a, b) => {
    const pagaA = conDinero.has(a.org_id) ? 0 : 1;
    const pagaB = conDinero.has(b.org_id) ? 0 : 1;
    if (pagaA !== pagaB) return pagaA - pagaB;
    const heredadaA = a.org_id === userId ? 0 : 1;
    const heredadaB = b.org_id === userId ? 0 : 1;
    if (heredadaA !== heredadaB) return heredadaA - heredadaB;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return { orgId: ordenadas[0]!.org_id, role: ordenadas[0]!.role };
}

/**
 * La organización del usuario, creándola si no tiene ninguna.
 *
 * FALLA CERRADA: si no puede resolver ni crear, LANZA. Quien llama devuelve 503.
 * Jamás cae a `user.id`, que es exactamente el defecto que este fichero cierra —
 * un respaldo silencioso a `user.id` volvería a acuñar organizaciones fantasma,
 * que es la forma más cara de fallar que tiene este producto: la clave `bvk_`
 * queda atada a una organización vacía, el ingest muere con 402, la licencia no
 * se renueva y la flota del cliente se apaga fail-closed SEMANAS DESPUÉS, sin un
 * solo error visible.
 *
 * `id` se deja a `gen_random_uuid()` de la propia tabla: NUNCA se pasa `user.id`.
 */
export async function resolverOrgDelUsuario(
  admin: AdminClient,
  userId: string,
  nombre?: string | null,
): Promise<OrgResuelta> {
  if (!userId) throw new Error("resolverOrgDelUsuario: falta el userId de la sesión");

  const yaTiene = await resolverOrgSiExiste(admin, userId);
  if (yaTiene) return yaTiene;

  // NACE CON DUEÑO. `owner_user_id` no se deja para que lo rellene el webhook más
  // tarde: es la premisa entera de la 0013 —una organización sin dueño no la puede
  // gestionar nadie, ni cambiar la tarjeta ni cancelar, y la suscripción sigue
  // cobrando— y el hueco entre crearla y pagar puede durar días con un adeudo SEPA.
  // `ensureOrg` del webhook solo lo escribe cuando está a null, así que esto no
  // pisa nada; simplemente hace que ese caso no llegue a existir.
  const { data: orgCreada, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: nombre?.trim() || "Mi organización", owner_user_id: userId })
    .select("id")
    .single();
  if (orgErr) throw orgErr;
  const orgId = (orgCreada as { id?: string } | null)?.id;
  if (!orgId) throw new Error("resolverOrgDelUsuario: la organización no devolvió id");

  const { error: memErr } = await admin
    .from("org_members")
    .insert({ org_id: orgId, user_id: userId, role: "owner" });
  if (memErr) {
    // Si la pertenencia no se escribe, la organización queda huérfana: nadie la
    // resolvería nunca y el siguiente intento crearía otra. Se lanza para que el
    // llamante devuelva 503 y el cliente reintente, en vez de seguir con una
    // organización que no es de nadie.
    throw memErr;
  }

  return { orgId, role: "owner" };
}

/**
 * La organización con la que el panel debe consultar, o `null`.
 *
 * Existe como función propia por UN motivo: para que se pueda probar que NUNCA
 * cae a `user.id`. Ese respaldo es la forma más fácil de reabrir el defecto por
 * la puerta de atrás —un panel que "casi siempre funciona" y que a un miembro
 * invitado le enseña los datos de otra organización, o ninguno— y era invisible
 * para los tests mientras vivía dentro de `loadDashboard`, que no se puede
 * cargar desde vitest (importa `next-intl/server` y clientes de Supabase).
 *
 * Sin organización resuelta, el panel se pinta VACÍO. Es peor experiencia y es la
 * respuesta correcta: enseñar datos de quien no eres no es una alternativa.
 */
export function orgParaElPanel(resuelta: OrgResuelta | null): string | null {
  return resuelta?.orgId ?? null;
}
