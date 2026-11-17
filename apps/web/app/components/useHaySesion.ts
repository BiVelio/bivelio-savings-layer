"use client";

import { useEffect, useState } from "react";

import { alCrearseElCliente } from "@/lib/supabase/aviso-del-cliente";
import { authConfigured } from "@/lib/supabase/env";

/**
 * ¿HAY SESIÓN? — decidido en el navegador, para que la portada pueda ser
 * ESTÁTICA.
 *
 * LO QUE PASABA. `NavBar` es un componente de servidor y preguntaba a Supabase
 * por el usuario en cada petición (`createReadOnlyClient` → `cookies()` →
 * `getUser()`). Leer las cookies convierte la ruta entera en dinámica, así que
 * la portada, «Cómo funciona», el alta y el restablecimiento de contraseña se
 * renderizaban en una función en cada visita, con un viaje al servidor de Auth
 * por medio, en vez de servirse desde la caché del borde. Medido el
 * 22-09-2026: 240-350 ms de TTFB para una página de marketing que no cambia.
 * Y en el panel, donde la barra pública ni se ve, ese `getUser()` se hacía
 * igualmente en cada render, de balde.
 *
 * AHORA la barra se pinta como invitado en el servidor y, al montar, el
 * navegador mira su propia sesión: `getSession()` del cliente de navegador lee
 * la cookie en local, sin red, y `onAuthStateChange` sigue los cambios. Quien
 * tiene sesión ve «Iniciar sesión» un instante y luego «Panel»; es el mismo
 * efecto secundario aceptado que ya documenta `lib/supabase/server.ts` para el
 * token caducado, y a cambio la portada llega en decenas de milisegundos.
 *
 * Y SIN CARGAR SUPABASE-JS SI NO HACE FALTA (17-11-2026, anuncios en móvil).
 * Importarlo aquí de forma estática metía ~250 KB de JS (GoTrueClient y
 * compañía) en el arranque de TODAS las páginas públicas, por delante del LCP
 * en una red móvil. Ahora el cliente se carga con `import()` solo si el
 * navegador guarda una cookie de Auth (`sb-…-auth-token`, sus trozos o el
 * `-code-verifier` del PKCE): sin ella no hay sesión que leer, y tampoco nada
 * que el cliente pudiera recoger de la URL al iniciarse. Los cambios que antes
 * llegaban por `onAuthStateChange` sin cookie previa se siguen viendo:
 *   · alguien de esta pestaña crea el cliente y entra (invitación, alta,
 *     login) → `createClient` avisa y la barra se suscribe a ese cliente;
 *   · se entra en OTRA pestaña → al volver a esta (foco, visibilidad o
 *     restauración desde la caché de historial) se mira la cookie de nuevo.
 *
 * NO ES UNA DECISIÓN DE SEGURIDAD: cambia el texto de un botón. La puerta del
 * panel sigue siendo el layout de /dashboard, en el servidor.
 */
export function useHaySesion(): boolean {
  const [hay, setHay] = useState(false);
  useEffect(() => {
    if (!authConfigured) return;
    return vigilarSesion({
      leerCookies: () => document.cookie,
      cargarCliente: () => import("@/lib/supabase/client").then(({ createClient }) => createClient()),
      alCrearseElCliente,
      alVolverALaPagina: (comprobar) => {
        const siSeVe = () => {
          if (document.visibilityState === "visible") comprobar();
        };
        window.addEventListener("focus", comprobar);
        window.addEventListener("pageshow", comprobar);
        document.addEventListener("visibilitychange", siSeVe);
        return () => {
          window.removeEventListener("focus", comprobar);
          window.removeEventListener("pageshow", comprobar);
          document.removeEventListener("visibilitychange", siSeVe);
        };
      },
      alCambiar: setHay,
    });
  }, []);
  return hay;
}

/** Lo que la barra usa del cliente de Supabase. El real (`SupabaseClient`) lo cumple. */
export type AuthDelNavegador = {
  auth: {
    getSession(): Promise<{ data: { session: unknown } }>;
    onAuthStateChange(alCambiar: (evento: string, sesion: unknown) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
};

/**
 * Las cookies que deja Auth de Supabase con `@supabase/ssr`: `sb-<ref>-auth-token`,
 * sus trozos (`.0`, `.1`…) y `sb-<ref>-auth-token-code-verifier`. No son
 * httpOnly (las lee el propio cliente de navegador con `document.cookie`).
 */
const RASTRO_DE_AUTH = /(?:^|;\s*)sb-[^=;\s]+-auth-token/;

export function hayRastroDeAuth(cookies: string): boolean {
  return RASTRO_DE_AUTH.test(cookies);
}

export type EntornoDeSesion = {
  leerCookies: () => string;
  cargarCliente: () => Promise<AuthDelNavegador>;
  alCrearseElCliente: (oyente: (cliente: AuthDelNavegador) => void) => () => void;
  alVolverALaPagina: (comprobar: () => void) => () => void;
  alCambiar: (hay: boolean) => void;
};

/**
 * El cuerpo del efecto, sin React ni DOM para poder probarlo. Se suscribe UNA
 * vez al cliente —el que carga él si hay cookie de Auth, o el que cree otro
 * componente de la pestaña— y desde ahí hace lo de siempre: `getSession()` y
 * `onAuthStateChange`. Devuelve la limpieza del efecto.
 */
export function vigilarSesion(entorno: EntornoDeSesion): () => void {
  let vivo = true;
  let cargando = false;
  let darDeBaja: (() => void) | null = null;

  const seguir = (cliente: AuthDelNavegador) => {
    if (!vivo || darDeBaja) return;
    quitarAviso();
    quitarRegreso();
    // Si ya llegó un evento, es más reciente que la foto de `getSession()`: al
    // suscribirse justo antes de un `signInWithPassword` (la invitación), un
    // `null` leído antes del inicio de sesión no debe pisar el SIGNED_IN.
    let hayEvento = false;
    cliente.auth
      .getSession()
      .then(({ data }) => {
        if (vivo && !hayEvento) entorno.alCambiar(Boolean(data.session));
      })
      .catch(() => {
        /* sin sesión legible: se queda como invitado */
      });
    const {
      data: { subscription },
    } = cliente.auth.onAuthStateChange((_evento, sesion) => {
      hayEvento = true;
      if (vivo) entorno.alCambiar(Boolean(sesion));
    });
    darDeBaja = () => subscription.unsubscribe();
  };

  const comprobar = () => {
    if (!vivo || darDeBaja || cargando || !hayRastroDeAuth(entorno.leerCookies())) return;
    cargando = true;
    entorno
      .cargarCliente()
      .then(seguir)
      .catch(() => {
        /* el chunk no llegó: invitado, y se reintenta al volver a la página */
      })
      .finally(() => {
        cargando = false;
      });
  };

  const quitarAviso = entorno.alCrearseElCliente(seguir);
  const quitarRegreso = entorno.alVolverALaPagina(comprobar);
  comprobar();

  return () => {
    vivo = false;
    quitarAviso();
    quitarRegreso();
    darDeBaja?.();
  };
}
