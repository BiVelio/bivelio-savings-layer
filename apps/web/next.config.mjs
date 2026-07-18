/** @type {import('next').NextConfig} */

// CSP for the whole surface. The static landing (public/landing.html) uses inline
// <style> and a JSON data block; the Next auth pages need their hydration script;
// Supabase auth calls go to auth.bivelio.com — hence the connect-src entry.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://auth.bivelio.com",
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
  // The marketing landing stays the exact static page (byte-identical, already
  // branded + verified): serve it at "/" without a React port.
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/landing.html" }],
    };
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
