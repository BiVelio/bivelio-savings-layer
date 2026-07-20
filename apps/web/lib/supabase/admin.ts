import { createClient } from "@supabase/supabase-js";

import { SUPABASE_URL } from "./env";

/**
 * Server-only Supabase client using the SERVICE ROLE key — bypasses RLS for
 * control-plane reads/writes (the revocation ledger, later Stripe-driven issuance).
 *
 * NEVER import this from client components. The service-role key must never reach
 * the browser; it is read from `SUPABASE_SERVICE_ROLE_KEY` (Node runtime only).
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // BV-SALA control-plane lives in its own schema (the project's `public` schema
    // belongs to the shared platform app). All admin reads/writes target `bvsala`.
    db: { schema: "bvsala" },
  });
}
