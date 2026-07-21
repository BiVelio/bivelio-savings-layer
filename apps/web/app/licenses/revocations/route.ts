import { NextResponse } from "next/server";

import { loadPrivateKey, signRevocationList, revocationEtag } from "@/lib/license/sign";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * PUBLIC revocation call-home. The SDK polls `${licenseServerUrl}/licenses/revocations`
 * (so this lives at `/licenses/revocations`, matching the base URL customers pass).
 * It returns a SIGNED, monotonic revocation list; integrity comes from the Ed25519
 * signature, not from auth — so no credentials, and a proxy can't strip a revocation.
 *
 * Never-brick contract: on a store error we return 503 (NOT an authentic empty list),
 * so the SDK fail-opens and keeps its sticky last-known-good snapshot.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "If-None-Match, Accept",
};

export async function OPTIONS(): Promise<NextResponse> {
  // `If-None-Match` is not a CORS-safelisted request header → browsers preflight.
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: Request): Promise<NextResponse> {
  const privateKey = loadPrivateKey();
  if (!privateKey) {
    return NextResponse.json(
      { error: "Revocation signing isn't configured (LICENSE_PRIVATE_KEY missing)." },
      { status: 501, headers: CORS },
    );
  }

  let seq = 0;
  const revoked: string[] = [];
  try {
    const supabase = createAdminClient();
    // Fetch the WHOLE ledger, ordered by seq, in pages. A single unordered select
    // is silently truncated to PostgREST's db-max-rows (default 1000); on this
    // append-only table that drops the NEWEST (highest-seq) revocations from the
    // signed list, so a just-revoked jti keeps validating — a fail-open kill-switch.
    // Also, seq computed as max-over-returned-rows would then UNDER-report the true
    // max, so the truncated list still clears the SDK's seq gate and gets applied.
    const PAGE = 1000; // must be <= the deployment's PostgREST db-max-rows
    let total: number | null = null;
    for (let from = 0; ; from += PAGE) {
      const { data, error, count } = await supabase
        .from("revocations")
        .select("jti, seq", { count: "exact" })
        .order("seq", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (count != null) total = count;
      const rows = data ?? [];
      for (const row of rows) {
        revoked.push(row.jti as string);
        const s = Number(row.seq) || 0;
        if (s > seq) seq = s;
      }
      if (rows.length < PAGE) break; // last (short) page reached
    }
    // Fail CLOSED: if the store says more rows exist than we fetched (db-max-rows set
    // below PAGE, or any other cap), do NOT publish a truncated list — degrade to the
    // never-brick 503 below. `<` (not `!=`) tolerates concurrent appends to this
    // append-only table (count only ever grows).
    if (total != null && revoked.length < total) {
      throw new Error(`revocation list truncated (${revoked.length}/${total})`);
    }
  } catch (err) {
    // Durability contract: a store error must NOT emit an authentic empty list
    // (which clients with a higher accepted seq would reject as a rollback, and
    // which would also stall fresh revocations). Return 503 → the SDK fail-opens.
    console.error("[licenses/revocations] store error:", err);
    return NextResponse.json(
      { error: "revocation store unavailable" },
      { status: 503, headers: CORS },
    );
  }

  const etag = revocationEtag(seq);
  const cacheHeaders: Record<string, string> = { "cache-control": "public, max-age=30", etag };

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ...CORS, ...cacheHeaders } });
  }

  const list = signRevocationList(
    { asOf: Math.floor(Date.now() / 1000), seq, revoked },
    privateKey,
  );
  return NextResponse.json({ list }, { headers: { ...CORS, ...cacheHeaders } });
}
