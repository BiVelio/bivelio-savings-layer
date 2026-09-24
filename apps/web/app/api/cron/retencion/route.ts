import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import {
  DIAS_DE_RETENCION,
  DIAS_DE_RETENCION_REFERENCIAS,
  fechaDeCorte,
  fechaDeCorteReferencias,
} from "@/lib/metering/retencion";
import { alertar } from "@/lib/observabilidad/alerta";
import { createAdminClient } from "@/lib/supabase/admin";
import { esTablaInexistente } from "@/lib/supabase/esquema-pendiente";

/**
 * Purga nocturna de `bvsala.usage_ingest_seen` (ver apps/web/vercel.json):
 * borra las filas de idempotencia con más de DIAS_DE_RETENCION días. La
 * migración 0009 la documentó y nadie la programó; la tabla crecía sin tope.
 *
 * Desde 0029 purga también `bvsala.reference_hits` (el CSV de las repeticiones
 * medidas por referencia) con más de DIAS_DE_RETENCION_REFERENCIAS días, DESPUÉS
 * de la purga de idempotencia. Sin la tabla (migración aún no aplicada) esa
 * segunda purga se salta: no hay nada que borrar.
 *
 * Mismo contrato que el resto de crons: Bearer CRON_SECRET, FALLA CERRADO
 * (501 sin secreto, 401 sin Bearer) y avisa en crítico si no puede borrar.
 * `?seco=1` cuenta lo que borraría en las dos tablas sin borrar nada.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function autorizado(req: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;
  const cabecera = req.headers.get("authorization") ?? "";
  const presentado = cabecera.startsWith("Bearer ") ? cabecera.slice(7).trim() : "";
  if (presentado.length === 0) return false;
  return timingSafeEqual(
    createHash("sha256").update(presentado).digest(),
    createHash("sha256").update(secreto).digest(),
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    await alertar({ nivel: "critico", asunto: "cron retencion no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/retencion" } });
    return NextResponse.json({ error: "Cron isn't configured (CRON_SECRET unset)." }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const seco = new URL(req.url).searchParams.get("seco") === "1";
  const ahora = new Date();
  const corte = fechaDeCorte(ahora);
  const corteReferencias = fechaDeCorteReferencias(ahora);
  const supabase = createAdminClient();

  if (seco) {
    const { count, error } = await supabase
      .schema("bvsala")
      .from("usage_ingest_seen")
      .select("*", { count: "exact", head: true })
      .lt("seen_at", corte);
    if (error) return NextResponse.json({ error: "count failed", motivo: error.message }, { status: 500 });
    const { count: countRef, error: errRef } = await supabase
      .schema("bvsala")
      .from("reference_hits")
      .select("*", { count: "exact", head: true })
      .lt("day", corteReferencias);
    if (errRef && !esTablaInexistente(errRef)) {
      return NextResponse.json({ error: "count failed", motivo: errRef.message }, { status: 500 });
    }
    return NextResponse.json({
      seco: true,
      corte,
      dias: DIAS_DE_RETENCION,
      borraria: count ?? 0,
      referencias: errRef
        ? { tablaAusente: true }
        : { corte: corteReferencias, dias: DIAS_DE_RETENCION_REFERENCIAS, borraria: countRef ?? 0 },
    });
  }

  const { count, error } = await supabase
    .schema("bvsala")
    .from("usage_ingest_seen")
    .delete({ count: "exact" })
    .lt("seen_at", corte);
  if (error) {
    console.error("[cron/retencion] la purga falló:", error);
    // Crítico: si la purga falla noche tras noche, la tabla vuelve a crecer sin
    // tope y nadie lo ve hasta que Supabase avise del disco.
    await alertar({
      nivel: "critico",
      asunto: "La purga de usage_ingest_seen está fallando",
      detalle: { corte, motivo: error.message },
    });
    return NextResponse.json({ error: "purge failed" }, { status: 500 });
  }

  // 0029 · reference_hits, tras la purga de idempotencia. Sin la tabla (el
  // despliegue adelantó a la migración) no hay nada que purgar: se avisa en el
  // registro y se sigue, sin alerta — no es un fallo.
  const { count: borradasRef, error: errRef } = await supabase
    .schema("bvsala")
    .from("reference_hits")
    .delete({ count: "exact" })
    .lt("day", corteReferencias);
  if (errRef && esTablaInexistente(errRef)) {
    console.warn("[cron/retencion] sin la tabla reference_hits (¿falta la migración 0029?); se salta su purga");
    return NextResponse.json({ corte, dias: DIAS_DE_RETENCION, borradas: count ?? 0, referencias: { tablaAusente: true } });
  }
  if (errRef) {
    console.error("[cron/retencion] la purga de reference_hits falló:", errRef);
    await alertar({
      nivel: "critico",
      asunto: "La purga de reference_hits está fallando",
      detalle: { corte: corteReferencias, motivo: errRef.message },
    });
    return NextResponse.json({ error: "purge failed", borradas: count ?? 0 }, { status: 500 });
  }
  return NextResponse.json({
    corte,
    dias: DIAS_DE_RETENCION,
    borradas: count ?? 0,
    referencias: { corte: corteReferencias, dias: DIAS_DE_RETENCION_REFERENCIAS, borradas: borradasRef ?? 0 },
  });
}
