import type { AdminClient } from "@/lib/supabase/admin";

/**
 * ¿POR QUÉ ESTÁ VACÍO EL PANEL?
 *
 * Hay dos motivos que se ven EXACTAMENTE igual y que piden cosas opuestas:
 *
 *   · No hay tráfico todavía. Es normal el primer día: hay que instalar el SDK.
 *   · Las filas existen, pero la RLS no deja verlas a este usuario.
 *
 * Y no se distinguen solos, porque **una denegación de RLS en PostgREST no es un
 * error**: devuelve `[]` con `error: null`, idéntico a "no hay nada". Así que el
 * segundo caso —una política mal puesta, un miembro invitado que no encaja en
 * `is_org_member`, una migración a medias— se presenta al cliente como «aún no
 * has enviado ninguna petición», mientras sus datos están intactos en la base y
 * él está pagando por verlos.
 *
 * La única forma de separarlos es preguntárselo a alguien que no esté sujeto a la
 * RLS. El cliente `service_role` la salta, así que se le pregunta cuántas filas
 * hay DE VERDAD — y solo cuando el usuario ha visto cero, que es el caso raro.
 * En el camino normal (hay datos) no se paga ninguna consulta extra.
 */

export type Visibilidad =
  /** El usuario ve filas. Todo normal. */
  | "con_datos"
  /** No hay filas para nadie: es la primera instalación. */
  | "sin_trafico"
  /** ⚠️ Las filas existen y este usuario NO las ve. Es un fallo nuestro. */
  | "oculto"
  /** No se ha podido comprobar. Se trata como "sin tráfico" pero no se afirma. */
  | "desconocido";

/**
 * La decisión, aparte de la consulta, para poder probarla entera.
 *
 * @param vistas  filas que ha devuelto la lectura del USUARIO.
 * @param reales  filas que ve el `service_role`, o `null` si no se pudo mirar.
 */
export function diagnosticar(vistas: number, reales: number | null): Visibilidad {
  if (vistas > 0) return "con_datos";
  if (reales === null) return "desconocido";
  // `> 0` y no `!== vistas`: si el admin viera MENOS que el usuario sería un
  // absurdo (nadie ve más que service_role) y significaría que la comprobación
  // está mal, no que haya una fuga. Afirmar "oculto" ahí sería alarmar por un
  // fallo del propio diagnóstico.
  return reales > 0 ? "oculto" : "sin_trafico";
}

/**
 * Cuántas filas de uso tiene REALMENTE esta organización, saltándose la RLS.
 *
 * Devuelve `null` si no se puede saber. NUNCA lanza: esto es un diagnóstico, y un
 * diagnóstico que tumba la página que intentaba explicar es peor que no tenerlo.
 */
export async function contarFilasReales(
  admin: AdminClient,
  orgId: string,
  desde: string,
): Promise<number | null> {
  try {
    const { count, error } = await admin
      .from("usage_daily")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("day", desde);
    if (error) {
      console.error("[dashboard] no se pudo contar el uso real:", error);
      return null;
    }
    return typeof count === "number" ? count : null;
  } catch (err) {
    console.error("[dashboard] no se pudo contar el uso real:", err);
    return null;
  }
}
