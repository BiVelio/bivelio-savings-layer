// Same-origin redirect guard for the auth routes. `next` comes straight from the
// query string, so resolving it unchecked is an open redirect (CWE-601):
// `//evil.com`, `/\evil.com` and `@evil.com` all escape our origin. A raw-string
// prefix check is NOT enough: the WHATWG URL parser (the sink, `new URL(next,
// origin)`) STRIPS tab/newline/CR before parsing, so a decoded `/\t/evil.com`
// slips a leading-slash guard yet resolves to `//evil.com`.
//
// So we (1) reject any C0 control character up front, then (2) resolve against a
// throwaway sentinel origin with the SAME parser as the sink and honour the path
// only if it stayed on that origin. Anything else — protocol-relative, absolute,
// backslash, `@host`, control-char smuggling, null/empty — falls back to the
// dashboard. The returned value is always a plain same-origin path.
//
// Ported from bivelio-privacy-gateway (app/auth/callback/safe-next.ts), which
// already carried this guard and its test. Here it lives one level up because
// BOTH /auth/callback and /auth/refresh take a `next`.
export function safeNextPath(next: string | null): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/dashboard";
  // Reject control chars (incl. tab/LF/CR) the URL parser would strip away.
  // Comparación por código, no por regex: escritos como literales dentro de una
  // clase de caracteres, estos bytes son invisibles en el fuente y cualquier
  // herramienta que "limpie" el fichero los borra sin que nadie lo note.
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return "/dashboard";
  }
  try {
    const SENTINEL = "https://x.invalid";
    const url = new URL(next, SENTINEL);
    if (url.origin !== SENTINEL) return "/dashboard";
    // `..` segment collapsing can leave a protocol-relative pathname (e.g.
    // `/..//evil.com` -> `//evil.com`) that stayed on SENTINEL here but which the
    // caller's `new URL(result, origin)` would re-parse as an off-origin host.
    // Re-resolve the FINAL string against SENTINEL and require it to stay put.
    const result = url.pathname + url.search + url.hash;
    if (new URL(result, SENTINEL).origin !== SENTINEL) return "/dashboard";
    return result;
  } catch {
    return "/dashboard";
  }
}
