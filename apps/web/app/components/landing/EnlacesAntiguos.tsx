"use client";

import { useEffect } from "react";

import { useRouter } from "@/i18n/navigation";

/**
 * LOS ENLACES PROFUNDOS DE LA PORTADA ANTERIOR SIGUEN LLEGANDO A SU SITIO.
 *
 * La portada se acortó (dueño, 2026-11): el verificador, los cuatro libros y
 * la explicación en palabras normales viven ahora en /how-it-works, y el
 * bloque «para desarrolladores» se plegó en «Dónde lo conectas». Quien llega
 * con un ancla antigua —un marcador, un correo, bivelio.com— no debe caer en lo
 * alto de la página sin explicación:
 *
 *   #verify  → /how-it-works#verify      #ledgers → /how-it-works#ledgers
 *   #explica → /how-it-works#explica     #devs    → #offers (en esta página)
 *
 * El `router` de next-intl conserva el idioma. Además, #sdk, #sdk-install y
 * #gateway eligen su pestaña en «Dónde lo conectas» (sin script, la página ya
 * aterriza en el selector: las anclas están en sus etiquetas). No pinta nada.
 */
const MOVIDOS: Record<string, string> = {
  verify: "/how-it-works#verify",
  ledgers: "/how-it-works#ledgers",
  explica: "/how-it-works#explica",
};
const PESTANA: Record<string, "sdk" | "gateway"> = { sdk: "sdk", "sdk-install": "sdk", gateway: "gateway" };

export function EnlacesAntiguos() {
  const router = useRouter();
  useEffect(() => {
    const atender = () => {
      const ancla = decodeURIComponent(window.location.hash.slice(1));
      if (!ancla) return;
      const destino = MOVIDOS[ancla];
      if (destino) {
        router.replace(destino);
        return;
      }
      if (ancla === "devs") {
        window.location.replace("#offers");
        return;
      }
      const pestana = PESTANA[ancla];
      if (pestana) {
        const radio = document.querySelector<HTMLInputElement>(`#offers input[name="conecta"][value="${pestana}"]`);
        if (radio && !radio.checked) radio.checked = true;
      }
    };
    atender();
    window.addEventListener("hashchange", atender);
    return () => window.removeEventListener("hashchange", atender);
  }, [router]);
  return null;
}
