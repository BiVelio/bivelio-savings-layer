// Public Supabase config. Bound to BiVelio's UNIFIED platform identity project
// (rsxebsvguppssbociwiu) — the single instance where savings, privacy, auth and
// app all live so a customer signs in ONCE across the suite (SSO). The anon key
// is a publishable key (safe in the browser; access is governed by RLS) and is
// read from the environment.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://rsxebsvguppssbociwiu.supabase.co";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** True when auth is configured; lets the marketing site run without Supabase env. */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
