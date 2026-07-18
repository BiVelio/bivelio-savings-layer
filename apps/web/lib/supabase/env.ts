// Public Supabase config. The URL is BiVelio's existing custom auth domain
// (auth.bivelio.com → the shared platform project neynxrnfcscsszqvhjtk) — the
// SAME identity used by privacy.bivelio.com, so a customer signs in once across
// the BiVelio suite. The anon key is a publishable key (safe in the browser;
// access is governed by RLS) and is read from the environment.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://auth.bivelio.com";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** True when auth is configured; lets the marketing site run without Supabase env. */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
