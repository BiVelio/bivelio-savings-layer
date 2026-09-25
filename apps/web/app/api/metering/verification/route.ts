import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { decideEntitlement } from "@/lib/metering/entitlement";
import { alertar } from "@/lib/observabilidad/alerta";
import { createAdminClient } from "@/lib/supabase/admin";
import { esFuncionInexistente, esTablaInexistente } from "@/lib/supabase/esquema-pendiente";
import {
  leerInterruptorVerificacion,
  parseVerificationBatch,
  VerificationValidationError,
} from "@/lib/verificacion/wire";

/**
 * «TU PROPIO BANCO» — el ingest de la verificación A/B opcional del SDK.
 *
 * INSTRUMENTO, JAMÁS BASE: los pares entran por AQUÍ, a sus tablas propias
 * (0030, `ingest_verification_batch`), y nunca por el ingest de uso. Nada de lo
 * que se escribe desde esta ruta llega a `measured_*`, al extracto ni a la
 * comisión (test/banco-propio-nunca-factura.test.ts).
 *
 * Mismos pasos de autenticación que `metering/usage`: Bearer de la clave de
 * servicio → sha256 → `service_accounts` → la org se DERIVA en el servidor (el
 * cuerpo no lleva org). Después el candado de entitlement (402, fail-open ante
 * error de BD, como allí), el interruptor de incidencias
 * `BVSALA_INGEST_VERIFICATION_OFF` y el validador de lista blanca.
 *
 * Un fallo de la función SQL avisa en nivel «aviso», no crítico: no son datos de
 * facturación.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

export async function POST(req: Request): Promise<NextResponse> {
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
    console.error("[metering/verification] service-account lookup failed:", saErr);
    return NextResponse.json({ error: "verification store unavailable" }, { status: 503 });
  }
  if (!sa) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = sa.org_id as string;

  // El mismo candado que el ingest de uso: una org sin licencia ni suscripción
  // vigentes no ingiere (402). Fail-open ante error de BD, como allí.
  const [{ data: licenses, error: licErr }, { data: subs, error: subErr }] = await Promise.all([
    supabase.from("licenses").select("revoked, expires_at, grace_days").eq("org_id", orgId),
    supabase.from("subscriptions").select("status, current_period_end").eq("org_id", orgId),
  ]);
  if (licErr || subErr) {
    console.error("[metering/verification] entitlement lookup failed (fail-open):", licErr ?? subErr);
  } else {
    const decision = decideEntitlement(licenses ?? [], subs ?? [], Date.now());
    if (decision.blocked) {
      return NextResponse.json(
        {
          error: "subscription required",
          reason: decision.reason,
          detail: "This organization has no active BiVelio license or subscription. Renew at https://savings.bivelio.com",
        },
        { status: 402 },
      );
    }
  }

  // EL INTERRUPTOR DE INCIDENCIAS: variable de Vercel + redespliegue del mismo
  // commit. Falla hacia ENCENDIDO (un valor raro corta, con aviso).
  const interruptor = leerInterruptorVerificacion(process.env.BVSALA_INGEST_VERIFICATION_OFF);
  if (!interruptor.reconocido) {
    console.warn(
      "[metering/verification] BVSALA_INGEST_VERIFICATION_OFF con un valor no reconocido: se trata como ENCENDIDO (usa 1 o 0)",
    );
  }
  if (interruptor.activo) return NextResponse.json({ ingested: 0, disabled: true }, { status: 202 });

  let lote;
  try {
    lote = parseVerificationBatch(await req.json(), Date.now());
  } catch (err) {
    if (err instanceof VerificationValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (lote.samples.length === 0 && lote.counts.length === 0) {
    return NextResponse.json({ ingested: 0, dropped: lote.dropped }, { status: 202 });
  }

  const { data, error } = await supabase.rpc("ingest_verification_batch", {
    p_org: orgId,
    p_batch_id: lote.batchId,
    p_samples: lote.samples,
    p_counts: lote.counts,
  });
  if (error) {
    if (esFuncionInexistente(error) || esTablaInexistente(error)) {
      console.warn("[metering/verification] sin la función o las tablas de 0030 (¿migración sin aplicar?)", error);
      return NextResponse.json({ error: "verification store unavailable" }, { status: 503 });
    }
    console.error("[metering/verification] ingest RPC failed:", error);
    await alertar({
      nivel: "aviso",
      asunto: "El ingest de la verificación A/B está fallando (no son datos de facturación)",
      detalle: { org: orgId, muestras: lote.samples.length, conteos: lote.counts.length, motivo: error.message ?? String(error) },
    });
    return NextResponse.json({ error: "verification ingest failed" }, { status: 500 });
  }

  const ingested = typeof data === "number" ? data : 0;
  return NextResponse.json(
    { ingested, duplicate: ingested === 0 && lote.samples.length > 0, dropped: lote.dropped },
    { status: 202 },
  );
}
