"use client";

import { createBrowserClient } from "@supabase/ssr";

import { avisarDeCliente } from "./aviso-del-cliente";
import { COOKIE_DE_SESION, SUPABASE_ANON_KEY, SUPABASE_URL, opcionesDeCookie } from "./env";

/**
 * Browser Supabase client (RLS-scoped, uses the publishable anon key).
 *
 * Cárgalo con `import()` y solo cuando haga falta: arrastra supabase-js entero
 * (~250 KB sin comprimir). Al crearlo avisa a quien lo espera sin haberlo
 * cargado (la cabecera pública, ver `aviso-del-cliente.ts`).
 */
export function createClient() {
  // Sin cookie propia (hoy) se llama exactamente como antes, sin opciones.
  const cliente = COOKIE_DE_SESION
    ? createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, opcionesDeCookie(COOKIE_DE_SESION))
    : createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  avisarDeCliente(cliente);
  return cliente;
}
