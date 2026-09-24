import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { cerrarPeriodo, periodoAnterior, resumenDelCierre, type UsoDeOrg } from "@/lib/billing/cierre";
import type { FilaDiaria } from "@/lib/billing/extracto";
import { obtenerFxCierre, type Fx } from "@/lib/billing/fx";
import { alertar } from "@/lib/observabilidad/alerta";
import { createAdminClient } from "@/lib/supabase/admin";
import { esColumnaInexistente, type ErrorDePostgrest } from "@/lib/supabase/esquema-pendiente";
import { leerTodo } from "@/lib/supabase/leer-todo";

/**
 * Cierre mensual de extractos (día 1, ver apps/web/vercel.json): fija en
 * bvsala.extractos el documento del período que acaba de terminar, una fila
 * inmutable por organización. Idempotente: la clave (org, período) hace que
 * repetir el cierre no reescriba nada (upsert ignore-duplicates) — se puede
 * relanzar a mano con el mismo Bearer sin miedo.
 *
 * FALLA CERRADO, como el resto de crons: sin CRON_SECRET, 501 y no toca nada.
 *
 * ENSAYO EN SECO (`?seco=1`, mismo Bearer): calcula el cierre y lo DEVUELVE
 * sin fijarlo. Es la única forma de ver el primer cierre real antes del día 1:
 * el extracto es inmutable y un cron mensual no tiene segunda oportunidad.
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

interface FilaUso {
  org_id: string;
  day: string;
  requests: number;
  baseline_cost: number;
  actual_cost: number;
  measured_requests: number;
  measured_baseline_cost: number;
  measured_actual_cost: number;
  /** El carril medido por referencia (0029). Ausente si la migración aún no está aplicada. */
  reference_requests?: number;
  reference_baseline_cost?: number;
  reference_actual_cost?: number;
}

/** Las columnas que el cierre lee de usage_daily, con el carril medido por referencia (0029). */
const COLUMNAS_USO =
  "org_id, day, requests, baseline_cost, actual_cost, measured_requests, measured_baseline_cost, measured_actual_cost, reference_requests, reference_baseline_cost, reference_actual_cost";
/** Las mismas sin el carril de 0029: el respaldo si el despliegue adelantó a la migración. */
const COLUMNAS_USO_SIN_REFERENCIA =
  "org_id, day, requests, baseline_cost, actual_cost, measured_requests, measured_baseline_cost, measured_actual_cost";
/** Las columnas de extractos que añade 0029: se retiran del upsert si la migración no está. */
const COLUMNAS_EXTRACTO_REFERENCIA = ["requests_referencia", "base_referencia_usd", "ahorro_referencia_usd", "regla_referencia"] as const;

// GET, como los demás crons: es el método con el que Vercel Cron invoca.
export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    // FALLO CERRADO, PERO NO SILENCIOSO (2026-09-12).
    await alertar({ nivel: "critico", asunto: "cron cierre-extractos no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/cierre-extractos" } });
    return NextResponse.json({ error: "cron sin configurar" }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  // `?periodo=YYYY-MM` permite cerrar un mes concreto a mano; por defecto, el anterior.
  const params = new URL(req.url).searchParams;
  const pedido = params.get("periodo");
  const periodo = pedido && /^\d{4}-\d{2}$/.test(pedido) ? pedido : periodoAnterior(new Date());
  const seco = params.get("seco") === "1";
  const desde = `${periodo}-01`;
  // Cota superior sin aritmética de meses: el primer día del período siguiente.
  const [y, m] = periodo.split("-").map(Number);
  const hasta = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);

  // PAGINADO: PostgREST corta a 1000 filas sin error, y con ≥34 orgs activas el
  // mes rebasa ese corte — el cierre sellaba extractos truncados e inmutables.
  const leerUso = (columnas: string) =>
    leerTodo<FilaUso>(() =>
      supabase
        .schema("bvsala")
        .from("usage_daily")
        .select(columnas)
        .gte("day", desde)
        .lt("day", hasta)
        // Orden estable: `.range()` pagina por OFFSET y sin ORDER BY el SQL no
        // garantiza el mismo orden entre páginas (riesgo teórico de saltar o
        // duplicar filas). (org_id, day) es la granularidad de usage_daily.
        .order("org_id", { ascending: true })
        .order("day", { ascending: true }),
    );
  // 0029 · EL DESPLIEGUE PUEDE ADELANTAR A LA MIGRACIÓN. Sin las columnas
  // reference_* (42703), el cierre se hace SIN el carril por referencia en vez
  // de aplazarse: sin 0029 la RPC tampoco acumula nada en ese carril, y el
  // extracto sellado es el mismo que antes de 0029.
  //
  // Pero la alerta es CRÍTICA (solo lo crítico llega por correo): si la web ya
  // acepta basis "reference" y el SDK ya lo emite, sin 0029 esas repeticiones
  // entran en la RPC de 0025 como estimado y se sellan FUERA de la base, mes
  // tras mes, sin ningún error visible. Es ingreso que se pierde en silencio.
  let conReferencia = true;
  let filas: FilaUso[];
  try {
    try {
      filas = await leerUso(COLUMNAS_USO);
    } catch (error) {
      if (!esColumnaInexistente(error as ErrorDePostgrest)) throw error;
      conReferencia = false;
      console.warn("[cierre-extractos] usage_daily sin las columnas reference_* (¿falta la migración 0029?); se cierra sin ese carril");
      await alertar({
        nivel: "critico",
        asunto: "Cierre de extractos sin el carril medido por referencia: falta aplicar la migración 0029",
        detalle: { periodo, motivo: (error as ErrorDePostgrest).message ?? String(error) },
      });
      filas = await leerUso(COLUMNAS_USO_SIN_REFERENCIA);
    }
  } catch (error) {
    console.error("[cierre-extractos] lectura de uso falló:", error);
    await alertar({
      nivel: "critico",
      asunto: "Cierre de extractos NO ejecutado: no se pudo leer usage_daily",
      detalle: { periodo, motivo: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({ error: "usage read failed" }, { status: 500 });
  }
  if (filas.length === 0) return NextResponse.json({ periodo, seco, orgs: 0, cerrados: 0 });

  // EL CAMBIO DEL BCE, antes de tocar nada. Si no está disponible se ABORTA el
  // cierre (503) en vez de sellar la fila inmutable con un FX inventado, que es
  // el bug que esto arregla. La recuperación NO es automática: el cron es
  // mensual y Vercel no reintenta una invocación fallida, así que se ALERTA y se
  // relanza a mano con `?periodo=YYYY-MM` (idempotente). En la práctica el XML
  // diario del BCE sirve siempre el último día publicado, así que la caída total
  // es poco probable. La sombra usa un FX fijo; el cierre real, no.
  let fx: Fx;
  try {
    fx = await obtenerFxCierre();
  } catch (error) {
    console.error("[cierre-extractos] FX del BCE no disponible, cierre aplazado:", error);
    // CRÍTICO, no aviso (2026-09-13): solo lo crítico llega por correo, y un
    // cierre mensual aplazado que nadie relanza es un mes sin facturar.
    await alertar({
      nivel: "critico",
      asunto: "Cierre de extractos aplazado: el FX del BCE no está disponible — relanzar a mano",
      detalle: { periodo, motivo: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({ error: "fx unavailable", periodo }, { status: 503 });
  }

  const porOrg = new Map<string, FilaDiaria[]>();
  for (const f of filas) {
    const lista = porOrg.get(f.org_id) ?? [];
    lista.push({
      day: String(f.day),
      requests: Number(f.requests ?? 0),
      baseline_cost: Number(f.baseline_cost ?? 0),
      actual_cost: Number(f.actual_cost ?? 0),
      measured_requests: Number(f.measured_requests ?? 0),
      measured_baseline_cost: Number(f.measured_baseline_cost ?? 0),
      measured_actual_cost: Number(f.measured_actual_cost ?? 0),
      // 0029 · el carril medido por referencia. `extracto.ts` decide si entra en
      // la base (COMISIONAR_REFERENCIA); aquí solo se lee y se normaliza.
      reference_requests: Number(f.reference_requests ?? 0),
      reference_baseline_cost: Number(f.reference_baseline_cost ?? 0),
      reference_actual_cost: Number(f.reference_actual_cost ?? 0),
    });
    porOrg.set(f.org_id, lista);
  }

  // La calibración REAL: el primer día con uso de toda la historia de cada org.
  // LAS EXENTAS DE COMISIÓN (probadores, cortesías): cargo 0 en su extracto.
  // Falla CERRADA: si no se puede leer la marca, el cierre se aplaza y se
  // relanza, porque cerrar sin ella facturaría a quien no debe pagar.
  const exentas = new Set<string>();
  try {
    const marcadas = await leerTodo<{ id: string }>(() =>
      supabase.schema("bvsala").from("organizations").select("id").eq("comision_exenta", true).order("id", { ascending: true }),
    );
    for (const o of marcadas) exentas.add(String(o.id));
  } catch (error) {
    console.error("[cierre-extractos] la exención de comisión no se pudo leer:", error);
    await alertar({
      nivel: "critico",
      asunto: "Cierre de extractos aplazado: no se pudo leer la exención de comisión",
      detalle: { periodo, motivo: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({ error: "orgs read failed", periodo }, { status: 500 });
  }
  const usoPorOrg: UsoDeOrg[] = [];
  for (const [orgId, filasOrg] of porOrg) {
    const { data: primera, error: errPrimera } = await supabase
      .schema("bvsala")
      .from("usage_daily")
      .select("day")
      .eq("org_id", orgId)
      .order("day", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (errPrimera) {
      console.error(`[cierre-extractos] primer uso de ${orgId} ilegible:`, errPrimera);
      continue; // mejor un cierre incompleto y relanzable que uno inventado
    }
    usoPorOrg.push({
      orgId,
      filas: filasOrg,
      primerPeriodoConUso: String(primera?.day ?? `${periodo}-01`).slice(0, 7),
      comisionExenta: exentas.has(orgId),
    });
  }

  const cierre = cerrarPeriodo(usoPorOrg, periodo, fx);
  if (seco) {
    return NextResponse.json({ periodo, seco: true, fx, orgs: porOrg.size, extractos: resumenDelCierre(cierre) });
  }
  // Sin 0029 (respaldo de arriba) la tabla extractos tampoco tiene las cuatro
  // columnas del carril: se retiran de la fila para que el upsert no dé PGRST204.
  // Van a 0/'' de todos modos, porque sin las columnas de uso no hay referencia.
  const filasACerrar: Array<Record<string, unknown>> = cierre.map((c) => {
    const fila: Record<string, unknown> = { ...c };
    if (!conReferencia) for (const col of COLUMNAS_EXTRACTO_REFERENCIA) delete fila[col];
    return fila;
  });
  // ignoreDuplicates: un extracto cerrado JAMÁS se reescribe (inmutabilidad).
  const { error: errInsert, count } = await supabase
    .schema("bvsala")
    .from("extractos")
    .upsert(filasACerrar, { onConflict: "org_id,periodo", ignoreDuplicates: true, count: "exact" });
  if (errInsert) {
    console.error("[cierre-extractos] el cierre no se pudo fijar:", errInsert);
    await alertar({
      nivel: "critico",
      asunto: "El cierre mensual de extractos está fallando",
      detalle: { periodo, orgs: cierre.length, motivo: errInsert.message ?? String(errInsert) },
    });
    return NextResponse.json({ error: "close failed" }, { status: 500 });
  }

  return NextResponse.json({ periodo, orgs: porOrg.size, cerrados: count ?? cierre.length });
}
