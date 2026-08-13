import type { AdminClient } from "@/lib/supabase/admin";
import type { Invitacion } from "./invitaciones";

/**
 * ENTRAR EN LA ORGANIZACIÓN CON UNA INVITACIÓN YA VALIDADA.
 *
 * Existe compartido porque hay DOS puertas —quien ya tiene cuenta (`accept`) y
 * quien la crea en ese momento (`registrar`)— y son exactamente el mismo efecto.
 * Duplicarlo es cómo se separan: se arregla un fallo en una y no en la otra, y la
 * mitad de los invitados acaba con un rol distinto del que se le mandó.
 *
 * ⚠️ NO VALIDA NADA. Quien llama tiene que haber comprobado ya el token, la
 * caducidad y —lo más importante— que el correo de la sesión coincide con el de
 * la invitación. Aquí solo se escribe.
 */
export async function unirseAOrganizacion(
  admin: AdminClient,
  inv: Invitacion,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  // LA PERTENENCIA PRIMERO, LA MARCA DESPUÉS. Al revés, si el alta fallara tras
  // marcar la invitación como aceptada, el enlace quedaría quemado y la persona
  // FUERA, sin forma de reintentar. Así el peor caso es una invitación viva para
  // alguien que ya está dentro, que se resuelve sola en el siguiente intento.
  const { error: altaErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: inv.org_id, user_id: userId, role: inv.role },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    );
  if (altaErr) return { ok: false, error: altaErr };

  // `.is("accepted_at", null)` la hace de un solo uso: dos peticiones simultáneas
  // con el mismo enlace, solo una escribe.
  const { error: marcaErr } = await admin
    .from("org_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inv.id)
    .is("accepted_at", null);
  if (marcaErr) {
    // La persona YA está dentro; no se le devuelve un error por no haber podido
    // anotar. La invitación caduca sola en su fecha.
    console.error("[org/unirse] no se pudo marcar como aceptada:", marcaErr);
  }

  try {
    await admin.from("billing_audit").insert({
      org_id: inv.org_id,
      event_id: `invitacion_${inv.id}`,
      kind: "org_member_joined",
      detail: { userId, role: inv.role, invitacion: inv.id },
    });
  } catch (err) {
    console.error("[org/unirse] no se pudo anotar en el libro:", err);
  }

  return { ok: true };
}
