import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */

// CSP for the whole surface. Las páginas de Next necesitan su script de hidratación
// y estilos inline.
//
// NOTA: `'unsafe-inline'` se justificaba antes por la landing ESTÁTICA
// (public/landing.html), que ya no existe. Sigue haciendo falta por el runtime de
// Next, pero conviene revisar si puede estrecharse — no en este cambio.
//
// `connect-src` SE DERIVA de NEXT_PUBLIC_SUPABASE_URL, no se escribe a mano.
// Antes listaba dos hosts fijos (el proyecto canónico y el dominio propio
// auth.bivelio.com) mientras el código leía el host de una variable de entorno:
// dos fuentes de verdad para el mismo dato. Cambiar la variable a un tercer host
// —o a cualquiera de los dos que no estuviera en la lista— rompía el login en
// silencio, y de la peor manera: el formulario se envía, la CSP bloquea el fetch,
// y el usuario ve un fallo genérico sin nada en el servidor.
//
// El login SÍ llama a Supabase desde el navegador (app/components/AuthForm.tsx es
// "use client" y hace signInWithPassword/signUp tras un import() dinámico). Ese
// import diferido es la razón de que un escaneo de los chunks de la portada no
// vea ninguna llamada a Supabase: el chunk que la contiene no se pide hasta que
// alguien envía el formulario. Quitar el host de connect-src rompería el acceso.
const supabaseOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL no es una URL válida: ${raw}`);
  }
})();

// Sin la variable (desarrollo local, o un build de solo-marketing) se permiten
// los dos hosts conocidos de la identidad de BiVelio, que es lo que hacía antes.
// Con la variable puesta, la CSP se estrecha sola al host que de verdad se usa.
const authOrigins = supabaseOrigin
  ? [supabaseOrigin]
  : ["https://rsxebsvguppssbociwiu.supabase.co", "https://auth.bivelio.com"];

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${authOrigins.join(" ")}`,
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig = {
  reactStrictMode: true,
  // apps/web is a standalone project (its own lockfile); trace from here, not the
  // SDK repo root — silences the multi-lockfile warning and keeps traces tight.
  outputFileTracingRoot: import.meta.dirname,
  // NOTE: no Edge/Node middleware for session refresh. @supabase/ssr in Edge
  // middleware pulls in realtime-js/ws (Edge-unsupported → deploy fails), and
  // Node middleware in Next 15.5 (experimental.nodeMiddleware) deploys but fails
  // at runtime (500s every route). Auth works without it — the browser client
  // refreshes tokens; server components/routes validate on the Node runtime.
  // Re-add proper session-refresh middleware on Next 16 (proxy.ts, Node runtime).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /**
   * La landing de marketing ES la página React de `app/[locale]/page.tsx`. Hubo una
   * versión estática previa en `public/landing.html` que se quedó publicada por
   * inercia: nadie la enlazaba, pero era alcanzable por URL, `robots.ts` no la
   * bloqueaba —así que era indexable— y anunciaba el precio en DÓLARES cuando Stripe
   * cobra euros. Además llevaba incrustado el banco de pruebas MOCK antiguo.
   *
   * Se ha borrado, y su URL se redirige en vez de dar 404 para no romper enlaces
   * externos y para que los buscadores trasladen el histórico a la página buena.
   *
   * Se fija `statusCode: 301` explícitamente en vez de `permanent: true`, que en Next
   * emite **308**. Los dos son permanentes y Google los trata igual, pero el 301 lo
   * entiende cualquier cliente viejo o comprobador de enlaces. Son mutuamente
   * excluyentes: o uno, o el otro.
   *
   * Destino `/` y no `/es`: el middleware negocia el idioma del visitante. Mandar a
   * `/es` serviría español a quien llegue desde un enlace en inglés, que es otra
   * variante del mismo problema que esto viene a cerrar.
   */
  async redirects() {
    return [{ source: "/landing.html", destination: "/", statusCode: 301 }];
  },
};

export default withNextIntl(nextConfig);
