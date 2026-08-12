import type { AdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste } from "./resolver";
import { puede, NO_AUTORIZADO, type Accion } from "./permisos";

/**
 * «¿Quién eres, de qué organización, y puedes hacer esto?» — las tres preguntas
 * juntas, una sola vez.
 *
 * Existe porque la fase 8 añade siete métodos nuevos que necesitan exactamente lo
 * mismo, y ese es el momento en que una comprobación repetida a mano empieza a
 * faltar en uno de los sitios. Aquí no se puede: no hay forma de obtener la
 * organización sin pasar por la comprobación de permiso.
 *
 * Devuelve un resultado en vez de lanzar, para que quien llama no pueda seguir sin
 * mirarlo — un `throw` se puede envolver en un `try` vacío por accidente.
 */
export type Contexto =
  | { ok: true; orgId: string; role: string }
  | { ok: false; status: number; error: string };

export async function contextoDeLaOrg(
  admin: AdminClient,
  userId: string,
  accion: Accion,
): Promise<Contexto> {
  let org;
  try {
    org = await resolverOrgSiExiste(admin, userId);
  } catch (err) {
    // Falla CERRADA: si no se puede leer la pertenencia no se decide nada. 503 y
    // que el cliente reintente, nunca "pues adelante".
    console.error("[org/guardia] no se pudo resolver la organización:", err);
    return { ok: false, status: 503, error: "Could not read your organization." };
  }
  // 404 y no 403: quien no está en ninguna organización no tiene que enterarse de
  // que este recurso existe.
  if (!org) return { ok: false, status: 404, error: "No organization." };
  if (!puede(org.role, accion)) return { ok: false, status: 403, error: NO_AUTORIZADO };
  return { ok: true, orgId: org.orgId, role: org.role };
}
