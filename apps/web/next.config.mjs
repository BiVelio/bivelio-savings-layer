import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */

// CSP for the whole surface. The static landing (public/landing.html) uses inline
// <style> and a JSON data block; the Next auth pages need their hydration script.
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
  // The marketing landing stays the exact static page (byte-identical, already
  // branded + verified): serve it at "/" without a React port.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
