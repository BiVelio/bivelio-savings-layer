"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
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
 * NO ES UNA DECISIÓN DE SEGURIDAD: cambia el texto de un botón. La puerta del
 * panel sigue siendo el layout de /dashboard, en el servidor.
 */
export function useHaySesion(): boolean {
  const [hay, setHay] = useState(false);
  useEffect(() => {
    if (!authConfigured) return;
    let vivo = true;
    const supabase = createClient();
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (vivo) setHay(Boolean(data.session));
      })
      .catch(() => {
        /* sin sesión legible: se queda como invitado */
      });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_evento, sesion) => {
      if (vivo) setHay(Boolean(sesion));
    });
    return () => {
      vivo = false;
      subscription.unsubscribe();
    };
  }, []);
  return hay;
}
