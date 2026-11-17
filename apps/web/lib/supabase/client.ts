"use client";

import { createBrowserClient } from "@supabase/ssr";

import { avisarDeCliente } from "./aviso-del-cliente";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Browser Supabase client (RLS-scoped, uses the publishable anon key).
 *
 * Cárgalo con `import()` y solo cuando haga falta: arrastra supabase-js entero
 * (~250 KB sin comprimir). Al crearlo avisa a quien lo espera sin haberlo
 * cargado (la cabecera pública, ver `aviso-del-cliente.ts`).
 */
export function createClient() {
  const cliente = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  avisarDeCliente(cliente);
  return cliente;
}
