import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Los asientos que la org está USANDO de verdad este mes.
 *
 * POR QUÉ EXISTE. El panel solo pintaba los asientos PAGADOS (la columna de la
 * suscripción). Los usados los calcula `bvsala.billable_seats` desde el primer
 * día y NO LOS VEÍA NADIE: ni el cliente, para saber si se está pasando, ni
 * nosotros, para tener una conversación comercial sobre el exceso. El dato
 * estaba, y el hueco era solo de presentación.
 *
 * POR QUÉ CON EL CLIENTE DE SERVICIO. `billable_seats` está revocada para
 * `anon`/`authenticated` desde la migración 0005 —lo hicieron a propósito, para
 * que nadie pueda barrer la base compartida— y solo la puede ejecutar
 * `service_role`. De ahí que esto NO viva en `data.ts`, que usa la sesión del
 * usuario.
 *
 * ⚠️ EL `orgId` TIENE QUE VENIR DE LA SESIÓN, NUNCA DEL CLIENTE. Esta función
 * salta la RLS: si alguien pudiera elegir el `orgId`, leería los asientos de
 * cualquier otra organización. Su único llamador es `loadDashboard`, que lo saca
 * de `supabase.auth.getUser()`.
 */
export interface MedidaDeAsientos {
  /** `billable_seats` de este mes. `null` = no se ha podido medir (≠ cero). */
  usados: number | null;
  /**
   * ¿Se revocó alguna clave de servicio este mes? Rotarla cambia el `seat_id` de
   * TODAS las máquinas (es la llave del HMAC), y `billable_seats` cuenta ids
   * distintos, así que el recuento del mes queda inflado. Sin este dato el panel
   * le pediría al cliente que doblara su factura por haber rotado.
   */
  rotacionEsteMes: boolean;
}

export async function medirAsientos(orgId: string): Promise<MedidaDeAsientos> {
  const vacio: MedidaDeAsientos = { usados: null, rotacionEsteMes: false };
  if (!orgId) return vacio;
  // Mes natural en curso, en UTC: la misma frontera que usa la propia función
  // SQL para agrupar los días.
  const inicioDeMes = new Date().toISOString().slice(0, 7) + "-01";
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return vacio;
  }

  const [medida, rotacion] = await Promise.all([
    (async (): Promise<number | null> => {
      try {
        const { data, error } = await admin.rpc("billable_seats", { p_org: orgId, p_month: inicioDeMes });
        if (error) throw error;
        const n = Number(data ?? 0);
        return Number.isFinite(n) ? n : null;
      } catch (err) {
        // `null` significa "no se ha podido medir", que NO es lo mismo que cero.
        console.error("[asientos-usados] billable_seats falló:", err);
        return null;
      }
    })(),
    (async (): Promise<boolean> => {
      try {
        const { data, error } = await admin
          .from("billing_audit")
          .select("id")
          .eq("org_id", orgId)
          .eq("kind", "service_account_revoked")
          .gte("at", `${inicioDeMes}T00:00:00Z`)
          .limit(1);
        if (error) throw error;
        return (data ?? []).length > 0;
      } catch (err) {
        // Ante la duda, se ASUME rotación: el peor error aquí es pedirle a un
        // cliente que suba su suscripción por un recuento inflado.
        console.error("[asientos-usados] lectura de revocaciones falló:", err);
        return true;
      }
    })(),
  ]);

  return { usados: medida, rotacionEsteMes: rotacion };
}
