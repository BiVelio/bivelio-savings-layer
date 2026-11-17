import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AVISO DE «YA HAY CLIENTE DE SUPABASE EN ESTA PESTAÑA».
 *
 * Este módulo NO importa supabase-js (solo su tipo, que se borra al compilar),
 * y eso es todo su sentido. La cabecera pública (`useHaySesion`) ya no carga el
 * cliente de navegador al arrancar —son unos 250 KB de JS que un visitante sin
 * sesión no necesita—, pero tiene que enterarse igual que antes cuando otro
 * componente de la misma pestaña lo carga y abre sesión: la invitación que crea
 * la cuenta y entra sin cambiar de página (`AceptarInvitacion`), el alta, el
 * login. Esos componentes ya lo cargan con `import()` al enviar; `createClient`
 * avisa aquí y la cabecera se suscribe en ese momento al MISMO cliente (en el
 * navegador es único, `createBrowserClient` lo reutiliza).
 */
type Oyente = (cliente: SupabaseClient) => void;

const oyentes = new Set<Oyente>();

/** Llama a `oyente` cada vez que alguien cree el cliente de navegador. Devuelve la baja. */
export function alCrearseElCliente(oyente: Oyente): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

/** Lo llama `createClient()` de `./client` con el cliente que acaba de dar. */
export function avisarDeCliente(cliente: SupabaseClient): void {
  for (const oyente of [...oyentes]) oyente(cliente);
}
