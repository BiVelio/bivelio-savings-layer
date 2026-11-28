import { createClient } from "@supabase/supabase-js";

import { SUPABASE_URL } from "./env";

/**
 * LA LLAVE DE SERVICIO: la propia de Savings si está puesta, si no la de siempre.
 *
 * Hoy `SUPABASE_SERVICE_ROLE_KEY` es la `service_role` del proyecto compartido,
 * que según el inventario de 2026-11-28 tiene también la web de Privacy: rotarla
 * afecta a los dos productos a la vez, y desactivarla deja a los dos sin acceso
 * de servicio a la base. Supabase permite crear una
 * clave secreta por componente (las `sb_secret_…`), así que Savings puede tener
 * la suya y la `service_role` se puede retirar cuando nadie más la use.
 *
 * `BVSALA_SUPABASE_SECRET_KEY`, si está puesta, MANDA. Vacía (hoy) = la de
 * siempre, exactamente como antes. Deshacer = borrarla. El nombre lleva el
 * prefijo de Savings a propósito: un nombre genérico como `SUPABASE_SECRET_KEY`
 * lo puede crear por su cuenta una integración de Vercel, y cambiaría la llave
 * sin que nadie lo decidiera.
 */
export const VAR_CLAVE_PROPIA = "BVSALA_SUPABASE_SECRET_KEY";

export function claveDeServicio(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const propia = env[VAR_CLAVE_PROPIA]?.trim();
  return propia || env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Server-only Supabase client using the SERVICE ROLE key — bypasses RLS for
 * control-plane reads/writes (the revocation ledger, later Stripe-driven issuance).
 *
 * NEVER import this from client components. The service-role key must never reach
 * the browser; it is read from `BVSALA_SUPABASE_SECRET_KEY` or
 * `SUPABASE_SERVICE_ROLE_KEY` (Node runtime only).
 */
export function createAdminClient() {
  const key = claveDeServicio();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // BV-SALA control-plane lives in its own schema (the project's `public` schema
    // belongs to the shared platform app). All admin reads/writes target `bvsala`.
    db: { schema: "bvsala" },
  });
}

/** The exact `bvsala`-schema service-role client type (for helpers that take it). */
export type AdminClient = ReturnType<typeof createAdminClient>;
