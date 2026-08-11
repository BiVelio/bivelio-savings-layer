import type { MetadataRoute } from "next";

import { SITE_URL } from "@/i18n/site";

/**
 * `/robots.txt`. Antes no existía y devolvía 404, que para un rastreador
 * significa "recorre lo que quieras": exactamente lo contrario de lo que
 * necesitamos, porque bajo este mismo dominio conviven la landing (que sí debe
 * indexarse) y la aplicación (que no).
 *
 * El `noindex` por página sigue siendo el candado de verdad — `Disallow` solo
 * pide que no se rastree, no impide que una URL enlazada desde fuera acabe
 * apareciendo. Aquí se declaran ambos para que no dependa de uno solo.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/", // route handlers: nada que indexar
          "/auth/", // callback, refresh y signout — llevan tokens en la query
          "/licenses/", // endpoint público de revocaciones, es JSON firmado
          "/*/dashboard", // la aplicación, en cualquier idioma
          "/*/login",
          "/*/signup",
          "/*/reset-password",
          // OJO: `/landing.html` NO va aquí, y es deliberado. Esa página se borró y
          // su URL responde con un 301 hacia la landing buena. Un `Disallow` impediría
          // rastrearla, así que Googlebot nunca vería la redirección y la URL vieja
          // podría quedarse en el índice sin contenido. Un 301 ya es la instrucción
          // más fuerte que existe para retirarla.
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
