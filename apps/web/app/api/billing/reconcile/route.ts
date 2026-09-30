import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { reconcileSeats, type ReconciliationDecision } from "@/lib/billing/seat-reconciliation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reconciliación de asientos (seat true-up), disparada por un cron o a mano.
 *
 * Para cada org con suscripción activa: compara los asientos USADOS
 * (`bvsala.billable_seats`) contra los PAGADOS, y devuelve la decisión. NO cobra
 * por sí solo: el cobro del exceso del mes cerrado lo hace el cron
 * /api/cron/cobrar-asientos (ver el comentario del bucle). Esto es la consulta
 * auditable, sin tocar la factura de nadie.
 *
 * Autenticado con el mismo token admin que /api/license/revoke, comparado en
 * tiempo constante. GET no; solo POST.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const adminToken = process.env.LICENSE_ADMIN_TOKEN;
  if (!adminToken) return false;
  const authorization = req.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (presented.length === 0) return false;
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(adminToken).digest(),
  );
}

interface OrgLine {
  orgId: string;
  usedSeats: number;
  paidSeats: number | null;
  requests: number;
  decision: ReconciliationDecision;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.LICENSE_ADMIN_TOKEN) {
    return NextResponse.json({ error: "Reconcile isn't configured (LICENSE_ADMIN_TOKEN unset)." }, { status: 501 });
  }
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Mes a reconciliar: por defecto el actual (UTC). Se admite `?month=YYYY-MM-01`.
  const url = new URL(req.url);
  const monthParam = url.searchParams.get("month");
  const month = monthParam ?? new Date().toISOString().slice(0, 7) + "-01";

  const supabase = createAdminClient();

  // Orgs con suscripción registrada. El true-up solo aplica a quien tiene un plan
  // de pago; una org sin suscripción se rige por el candado de entitlement del
  // ingest, no por esto.
  const { data: subs, error: subErr } = await supabase
    .from("subscriptions")
    .select("org_id, seats, status");
  if (subErr) {
    console.error("[billing/reconcile] subscriptions read failed:", subErr);
    return NextResponse.json({ error: "reconcile store unavailable" }, { status: 503 });
  }

  const lines: OrgLine[] = [];
  for (const sub of subs ?? []) {
    const orgId = sub.org_id as string;
    const paidSeats = ["active", "trialing", "past_due"].includes(sub.status as string)
      ? (sub.seats as number)
      : 0; // una suscripción cancelada no aporta asientos pagados

    const { data: used, error: seatErr } = await supabase.rpc("billable_seats", {
      p_org: orgId,
      p_month: month,
    });
    if (seatErr) {
      console.error(`[billing/reconcile] billable_seats failed for ${orgId}:`, seatErr);
      continue; // no romper el lote entero por una org
    }

    // Peticiones del mes para el contraste de volumen (anti colapso de seat_id).
    const { data: usage } = await supabase
      .from("usage_daily")
      .select("requests")
      .eq("org_id", orgId)
      .gte("day", month)
      .lt("day", nextMonth(month));
    const requests = (usage ?? []).reduce((n, r) => n + Number(r.requests ?? 0), 0);

    const decision = reconcileSeats({ usedSeats: Number(used ?? 0), paidSeats, requests });
    lines.push({ orgId, usedSeats: Number(used ?? 0), paidSeats, requests, decision });

    // ── EL COBRO NO VIVE AQUÍ ───────────────────────────────────────────────
    // Esta ruta es la consulta a mano del mes que se le pida (por defecto, el
    // EN CURSO). El cobro del exceso lo hace el cron mensual
    // /api/cron/cobrar-asientos sobre el mes CERRADO, con la misma decisión
    // (lib/billing/cobro-asientos.ts, que usa reconcileSeats) y su candado de
    // una sola vez (bvsala.ajustes_asientos, 0034). Cobrar desde aquí también
    // abriría una segunda vía de cobro sin ese candado.
  }

  const resumen = {
    month,
    orgs: lines.length,
    trueUp: lines.filter((l) => l.decision.action === "true-up").length,
    review: lines.filter((l) => l.decision.action === "review").length,
    lines,
  };
  return NextResponse.json(resumen, { status: 200 });
}

function nextMonth(month: string): string {
  const d = new Date(month + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
