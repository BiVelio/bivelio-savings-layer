import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { decideEntitlement } from "@/lib/metering/entitlement";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Entitlements por organización para la PASARELA (S4a · gate per-org).
 *
 * Es el canal mínimo del control plane con la pasarela: no entrega licencias
 * (esas salen de /api/license/current), solo qué features concede la org y, si
 * está bloqueada, por qué. Se autentica con la misma clave de servicio bvk_ que
 * la ingesta (hash → service_accounts → org derivada del SERVIDOR, jamás del
 * cuerpo) y devuelve la lista de features de las licencias VIVAS de la org.
 *
 * El contrato con la pasarela es FAIL-CLOSED del lado del cliente: cualquier
 * respuesta que no sea un 200 con features — o ninguna respuesta — significa
 * «palanca apagada». Por eso aquí un error de BD es 503 (y no un fail-open
 * como en la ingesta): perder una petición de entitlements no pierde datos de
 * facturación, solo apaga una optimización hasta el próximo refresco.
 *
 * Una org bloqueada por `decideEntitlement` (revocada, caducada pasada la
 * gracia, o sin NINGUNA licencia ni suscripción: no hay free tier) recibe un 200
 * con features vacías y `reason`: es una respuesta DEFINITIVA, no un error, y
 * así la pasarela cachea el apagado en vez de reintentar.
 *
 * CONTRATO: `reason` presente ⇔ org bloqueada (la pasarela corta con cualquier
 * `reason`). Una org viva recibe el 200 SIN la clave `reason`, nunca con
 * `reason: null` ni con el motivo de la concesión: la pasarela que verja por
 * licencia trata cualquier `reason` no vacío como corte de las peticiones
 * nuevas, así que un motivo de concesión que se colara aquí cortaría a quien
 * paga. Las pasarelas anteriores lo ignoran y solo apagan palancas por las
 * features vacías. No hay código que tocar para cumplirlo: el `reason` sale de
 * `decideEntitlement` y solo se añade cuando `decision.blocked`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cada cuánto debe refrescar la pasarela (también es el techo de propagación de una retirada). */
const REFRESCO_SEGUNDOS = 300;

const DAY_MS = 86_400_000;

interface FilaConFeatures {
  revoked: boolean;
  expires_at: string;
  grace_days: number;
  features: string[] | null;
}

/** ¿Esta fila concreta sigue viva (no revocada, dentro de validez + gracia)? Mismo criterio que hasValidLicense. */
function filaViva(l: FilaConFeatures, nowMs: number): boolean {
  if (l.revoked) return false;
  const expira = Date.parse(l.expires_at);
  if (Number.isNaN(expira)) return false;
  return nowMs <= expira + (l.grace_days ?? 0) * DAY_MS;
}

function bearer(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const token = bearer(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const keyHash = createHash("sha256").update(token).digest("hex");

  const supabase = createAdminClient();

  const { data: sa, error: saErr } = await supabase
    .from("service_accounts")
    .select("org_id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (saErr) {
    console.error("[org/entitlements] service-account lookup failed:", saErr);
    return NextResponse.json({ error: "entitlements unavailable" }, { status: 503 });
  }
  if (!sa) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = sa.org_id as string;

  const [{ data: licenses, error: licErr }, { data: subs, error: subErr }] = await Promise.all([
    supabase.from("licenses").select("revoked, expires_at, grace_days, features").eq("org_id", orgId),
    supabase.from("subscriptions").select("status, current_period_end").eq("org_id", orgId),
  ]);
  if (licErr || subErr) {
    console.error("[org/entitlements] lookup failed (fail-closed en la pasarela):", licErr ?? subErr);
    return NextResponse.json({ error: "entitlements unavailable" }, { status: 503 });
  }

  const now = Date.now();
  const filas = (licenses ?? []) as FilaConFeatures[];
  const decision = decideEntitlement(filas, subs ?? [], now);

  // Features = unión de las licencias VIVAS. Una org bloqueada no aporta
  // ninguna aunque conserve filas: la retirada del feature o la revocación se
  // propagan a la pasarela en ≤ REFRESCO_SEGUNDOS.
  const features = decision.blocked
    ? []
    : [...new Set(filas.filter((l) => filaViva(l, now)).flatMap((l) => l.features ?? []))].sort();

  return NextResponse.json(
    { features, refreshAfterSeconds: REFRESCO_SEGUNDOS, ...(decision.blocked ? { reason: decision.reason } : {}) },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
