import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { revokeLicense } from "@/lib/license/issue";

/**
 * Admin revoke — records a jti in the append-only revocation ledger so the SDK's
 * `GET /licenses/revocations` publishes it. Fail-closed: refused unless the caller
 * presents `Authorization: Bearer ${LICENSE_ADMIN_TOKEN}`. Idempotent (unique jti).
 *
 * This is the CP-0 admin write path (lets us revoke + test now). In production the
 * Stripe `customer.subscription.deleted` webhook inserts here instead of a bearer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const adminToken = process.env.LICENSE_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { error: "Revoke isn't configured (LICENSE_ADMIN_TOKEN unset)." },
      { status: 501 },
    );
  }

  const authorization = req.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  // Constant-time compare over fixed-length sha256 digests — no length/prefix timing
  // leak of LICENSE_ADMIN_TOKEN.
  const ok =
    presented.length > 0 &&
    timingSafeEqual(
      createHash("sha256").update(presented).digest(),
      createHash("sha256").update(adminToken).digest(),
    );
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { jti?: string; reason?: string };
  try {
    body = (await req.json()) as { jti?: string; reason?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.jti) {
    return NextResponse.json({ error: "jti is required" }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    // Por revokeLicense(), NO un upsert crudo al ledger. La ruta solo escribía
    // `revocations` y nunca marcaba `licenses.revoked`, y de esa columna dependen
    // los DOS candados del servidor: `/api/license/current` filtra
    // `.eq("revoked", false)` — re-ENTREGABA la credencial revocada a cualquier
    // miembro/máquina — y `decideEntitlement` la lee para bloquear el ingest.
    // Una revocación manual (fraude, chargeback, token filtrado) solo la
    // aplicaba el poller del SDK del cliente, que es parcheable.
    // revokeLicense hace ledger PRIMERO (fail-closed) y después la fila.
    await revokeLicense(supabase, body.jti, body.reason ?? "admin revoke");
  } catch (err) {
    console.error("[license/revoke] insert error:", err);
    return NextResponse.json({ error: "could not record revocation" }, { status: 500 });
  }

  return NextResponse.json({ revoked: true, jti: body.jti });
}
