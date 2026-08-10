import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Cliente de Supabase para RUTAS (Route Handlers y Server Actions), donde SÍ se
 * pueden escribir cookies. Aquí el refresco es seguro: si gotrue rota el token,
 * el nuevo se persiste.
 *
 * Para Server Components hay que usar `createReadOnlyClient` — ver abajo el
 * porqué, que no es una preferencia de estilo sino un defecto que deslogueaba a
 * todo el mundo a diario.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Contexto sin escritura de cookies. No debería ocurrir en una ruta;
          // si ocurre, quien llama debería estar usando createReadOnlyClient.
        }
      },
    },
  });
}

/**
 * Cliente de SOLO LECTURA para Server Components.
 *
 * EL DEFECTO QUE CIERRA: este fichero tenía un único cliente cuyo `setAll` fallaba
 * en silencio en un Server Component, con el comentario «the middleware refreshes
 * the session». Ese middleware NO EXISTE: `middleware.ts` solo monta next-intl y
 * `lib/supabase/middleware.ts` no lo importa nadie (no puede: en este Next 15.5 el
 * Edge rechaza realtime/ws y el middleware de Node peta — por eso existe
 * `/auth/refresh`).
 *
 * Consecuencia real: al renderizar un Server Component con el access token a punto
 * de caducar, `getUser()` disparaba un refresco, gotrue ROTABA el refresh token, y
 * el nuevo se perdía en ese `catch`. El viejo ya estaba consumido, así que la
 * siguiente petición no tenía con qué refrescar: sesión muerta. Le pasaba a todo
 * usuario logueado, todos los días, con solo pasar por la landing (la NavBar es
 * auth-aware y llama a getUser()).
 *
 * La regla: quien no puede persistir un token rotado, NO PUEDE PROVOCAR LA
 * ROTACIÓN. Con `autoRefreshToken: false` y `persistSession: false` este cliente
 * no refresca nunca. Si el token ha caducado devuelve "sin usuario", y quien
 * llama rebota a `/auth/refresh` —una ruta, que sí escribe cookies— exactamente
 * como ya estaba diseñado.
 *
 * Efecto secundario aceptado: con el token caducado la NavBar se pinta un instante
 * como desconectada hasta que se pasa por /auth/refresh. Es infinitamente
 * preferible a cerrarle la sesión de verdad.
 */
export async function createReadOnlyClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        /* deliberadamente vacío: este cliente nunca debe rotar nada */
      },
    },
  });
}
