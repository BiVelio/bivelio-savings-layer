import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { decidirDunning } from "@/lib/billing/dunning";
import { diasDeGracia } from "@/lib/billing/gracia";
import { hasValidLicense, type LicenseRow } from "@/lib/metering/entitlement";
import { createAdminClient } from "@/lib/supabase/admin";
import { alertar } from "@/lib/observabilidad/alerta";

/**
 * Barrido diario de impagos: el cron que el webhook lleva prometiendo por escrito
 * desde que existe ("a nightly cron downgrades only past-grace") y que no existía.
 *
 * Lo llama Vercel Cron (ver `apps/web/vercel.json`), que manda
 * `Authorization: Bearer $CRON_SECRET`. También se puede disparar a mano con el
 * mismo encabezado para probarlo.
 *
 * FALLA CERRADO: sin `CRON_SECRET` la ruta devuelve 501 y no toca nada. Una ruta
 * que degrada planes y es alcanzable sin autenticar sería un interruptor de
 * apagado para cualquiera.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function autorizado(req: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;
  const cabecera = req.headers.get("authorization") ?? "";
  const presentado = cabecera.startsWith("Bearer ") ? cabecera.slice(7).trim() : "";
  if (presentado.length === 0) return false;
  // Hash antes de comparar: `timingSafeEqual` exige longitudes iguales y lanzaría
  // con una cadena de otro tamaño, lo que además filtraría la longitud del secreto.
  return timingSafeEqual(
    createHash("sha256").update(presentado).digest(),
    createHash("sha256").update(secreto).digest(),
  );
}

interface FilaImpago {
  id: string;
  org_id: string | null;
  status: string;
  past_due_since: string | null;
  current_period_start: string | null;
  stripe_subscription_id: string | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    // FALLO CERRADO, PERO NO SILENCIOSO: sin esto el cron respondía 501 y nadie se
    // enteraba salvo mirando el panel de Vercel (2026-09-12).
    await alertar({ nivel: "critico", asunto: "cron dunning no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/dunning" } });
    return NextResponse.json({ error: "Cron isn't configured (CRON_SECRET unset)." }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "store unavailable" }, { status: 503 });
  }

  // SE PAGINA. PostgREST corta en 1000 filas por respuesta y no avisa: sin esto,
  // a partir de la fila 1001 nadie se sella ni se degrada NUNCA — y como no hay
  // orden declarado, el subconjunto que se cae puede ser siempre el mismo.
  const PAGINA = 500;
  const filas: FilaImpago[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await admin
      .from("subscriptions")
      .select("id, org_id, status, past_due_since, current_period_start, stripe_subscription_id")
      .eq("status", "past_due")
      .order("id", { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) {
      console.error("[cron/dunning] lectura de subscriptions falló:", error);
      return NextResponse.json({ error: "store unavailable" }, { status: 503 });
    }
    const lote = (data ?? []) as FilaImpago[];
    filas.push(...lote);
    if (lote.length < PAGINA) break;
  }

  const ahora = Date.now();
  const gracia = diasDeGracia();
  const sellados: string[] = [];
  const degradados: string[] = [];
  const fallos: string[] = [];

  for (const fila of filas) {
    // ¿Le queda licencia viva? Si la hay no se degrada, aunque nuestro reloj haya
    // pasado: el SDK le sigue funcionando y el panel no puede decir lo contrario.
    // Se usa el MISMO predicado que el candado del ingest, no una copia.
    let licenciaViva = false;
    try {
      const { data: lics, error: licErr } = await admin
        .from("licenses")
        .select("revoked, expires_at, grace_days")
        .eq("org_id", fila.org_id ?? "");
      if (licErr) throw licErr;
      licenciaViva = hasValidLicense((lics ?? []) as LicenseRow[], ahora);
    } catch (err) {
      // No se ha podido comprobar: NO se degrada. Falla del lado que no corta el
      // servicio de nadie; mañana se vuelve a intentar.
      console.error(`[cron/dunning] no se pudo leer la licencia de ${fila.org_id}:`, err);
      fallos.push(fila.id);
      continue;
    }

    const decision = decidirDunning({
      status: fila.status,
      pastDueSince: fila.past_due_since,
      periodStart: fila.current_period_start,
      licenciaViva,
      nowMs: ahora,
      graciaDias: gracia,
    });
    if (decision === "nada") continue;

    try {
      if (decision === "sellar") {
        // Impago sin fecha de inicio: se sella ahora y la cuenta empieza aquí.
        // Nunca se degrada en la misma pasada — eso castigaría por un dato que
        // falta, no por un impago demostrado.
        // `supabase-js` DEVUELVE el error, no lo lanza: sin mirarlo, un sellado
        // que falla se contaba como hecho, el reloj de gracia no arrancaba nunca
        // y el panel de crons daba verde todos los días.
        const { error: selloErr } = await admin
          .from("subscriptions")
          .update({ past_due_since: new Date(ahora).toISOString(), updated_at: new Date(ahora).toISOString() })
          .eq("id", fila.id);
        if (selloErr) throw selloErr;
        sellados.push(fila.id);
        await auditar(admin, fila.org_id, "dunning_sellado", {
          subId: fila.stripe_subscription_id,
        });
        continue;
      }

      // decision === "degradar". Se degrada el PLAN y nada más.
      //
      // NO se revoca la licencia a propósito: lleva su propia gracia FIRMADA en el
      // token y caduca sola en `period_end + gracia`, que es justo por aquí.
      // Revocar sería ejecutar el mismo castigo dos veces por dos caminos, y encima
      // destructivo — un `invoice.payment_failed` puede venir de una factura de
      // prorrateo a mitad de ciclo, con el periodo principal PAGADO.
      if (fila.org_id) {
        const { error: planErr } = await admin
          .from("organizations")
          .update({ plan: "free" })
          .eq("id", fila.org_id);
        if (planErr) throw planErr;
      }
      degradados.push(fila.id);
      await auditar(admin, fila.org_id, "dunning_degradado", {
        subId: fila.stripe_subscription_id,
        pastDueSince: fila.past_due_since,
        graciaDias: gracia,
      });
    } catch (err) {
      // Una org que falla no puede tumbar el barrido entero: el resto sigue.
      console.error(`[cron/dunning] ${fila.id} falló:`, err);
      fallos.push(fila.id);
    }
  }

  return NextResponse.json(
    {
      revisadas: filas.length,
      sellados: sellados.length,
      degradados: degradados.length,
      fallos: fallos.length,
      graciaDias: gracia,
    },
    // 207 cuando algo falló, para que un fallo parcial no se lea como éxito en
    // el panel de crons de Vercel.
    { status: fallos.length > 0 ? 207 : 200 },
  );
}

async function auditar(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string | null,
  kind: string,
  detail: Record<string, unknown>,
) {
  try {
    await admin.from("billing_audit").insert({ org_id: orgId, event_id: `cron_${Date.now()}`, kind, detail });
  } catch (err) {
    // El rastro es deseable, no imprescindible: no se deshace el trabajo por él.
    console.error("[cron/dunning] auditoría falló:", err);
  }
}
