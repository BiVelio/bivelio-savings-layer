import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import {
  DIAS_DE_RETENCION,
  DIAS_DE_RETENCION_REFERENCIAS,
  DIAS_DE_RETENCION_VERIFICACION,
  fechaDeCorte,
  fechaDeCorteReferencias,
  fechaDeCorteVerificacion,
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
 * Desde 0030 purga también «tu propio banco» (la verificación A/B opcional):
 * `verification_samples` y `verification_daily` con más de
 * DIAS_DE_RETENCION_VERIFICACION días, y `verification_batches_seen` con el corte
 * de 30 días de la idempotencia. Sin las tablas, se salta sin alerta. Las claves
 * de la respuesta que ya existían no cambian; se añade `verificacion`.
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
  const corteVerificacion = fechaDeCorteVerificacion(ahora);
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
    const verificacion = await contarVerificacion(supabase, corteVerificacion, corte);
    if ("error" in verificacion) {
      return NextResponse.json({ error: "count failed", motivo: verificacion.error }, { status: 500 });
    }
    return NextResponse.json({
      seco: true,
      corte,
      dias: DIAS_DE_RETENCION,
      borraria: count ?? 0,
      referencias: errRef
        ? { tablaAusente: true }
        : { corte: corteReferencias, dias: DIAS_DE_RETENCION_REFERENCIAS, borraria: countRef ?? 0 },
      verificacion: verificacion.valor,
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
  let referencias: Record<string, unknown>;
  if (errRef && esTablaInexistente(errRef)) {
    console.warn("[cron/retencion] sin la tabla reference_hits (¿falta la migración 0029?); se salta su purga");
    referencias = { tablaAusente: true };
  } else if (errRef) {
    console.error("[cron/retencion] la purga de reference_hits falló:", errRef);
    await alertar({
      nivel: "critico",
      asunto: "La purga de reference_hits está fallando",
      detalle: { corte: corteReferencias, motivo: errRef.message },
    });
    return NextResponse.json({ error: "purge failed", borradas: count ?? 0 }, { status: 500 });
  } else {
    referencias = { corte: corteReferencias, dias: DIAS_DE_RETENCION_REFERENCIAS, borradas: borradasRef ?? 0 };
  }

  // 0030 · «tu propio banco», al final. Sin las tablas no hay nada que purgar.
  const verificacion = await purgarVerificacion(supabase, corteVerificacion, corte);
  if ("error" in verificacion) {
    console.error("[cron/retencion] la purga de la verificación A/B falló:", verificacion.error);
    await alertar({
      nivel: "critico",
      asunto: "La purga de las tablas de la verificación A/B está fallando",
      detalle: { corte: corteVerificacion, motivo: verificacion.error },
    });
    return NextResponse.json({ error: "purge failed", borradas: count ?? 0 }, { status: 500 });
  }
  return NextResponse.json({
    corte,
    dias: DIAS_DE_RETENCION,
    borradas: count ?? 0,
    referencias,
    verificacion: verificacion.valor,
  });
}

type Admin = ReturnType<typeof createAdminClient>;
type Resultado = { valor: Record<string, unknown> } | { error: string };

// Las tres tablas de 0030. Una tabla ausente (migración sin aplicar) es
// `tablaAusente`, sin alerta; cualquier otro error, un fallo.
async function purgarVerificacion(supabase: Admin, corteDia: string, corteLotes: string): Promise<Resultado> {
  const bv = supabase.schema("bvsala");
  const muestras = await bv.from("verification_samples").delete({ count: "exact" }).lt("day", corteDia);
  if (muestras.error && esTablaInexistente(muestras.error)) {
    console.warn("[cron/retencion] sin las tablas de la verificación (¿falta la migración 0030?); se salta su purga");
    return { valor: { tablaAusente: true } };
  }
  if (muestras.error) return { error: muestras.error.message };
  const diarios = await bv.from("verification_daily").delete({ count: "exact" }).lt("day", corteDia);
  if (diarios.error) return { error: diarios.error.message };
  const lotes = await bv.from("verification_batches_seen").delete({ count: "exact" }).lt("seen_at", corteLotes);
  if (lotes.error) return { error: lotes.error.message };
  return {
    valor: {
      corte: corteDia,
      dias: DIAS_DE_RETENCION_VERIFICACION,
      borradas: (muestras.count ?? 0) + (diarios.count ?? 0),
      lotesBorrados: lotes.count ?? 0,
    },
  };
}

async function contarVerificacion(supabase: Admin, corteDia: string, corteLotes: string): Promise<Resultado> {
  const bv = supabase.schema("bvsala");
  const muestras = await bv.from("verification_samples").select("*", { count: "exact", head: true }).lt("day", corteDia);
  if (muestras.error && esTablaInexistente(muestras.error)) return { valor: { tablaAusente: true } };
  if (muestras.error) return { error: muestras.error.message };
  const diarios = await bv.from("verification_daily").select("*", { count: "exact", head: true }).lt("day", corteDia);
  if (diarios.error) return { error: diarios.error.message };
  const lotes = await bv.from("verification_batches_seen").select("*", { count: "exact", head: true }).lt("seen_at", corteLotes);
  if (lotes.error) return { error: lotes.error.message };
  return {
    valor: {
      corte: corteDia,
      dias: DIAS_DE_RETENCION_VERIFICACION,
      borraria: (muestras.count ?? 0) + (diarios.count ?? 0),
      lotesBorraria: lotes.count ?? 0,
    },
  };
}
