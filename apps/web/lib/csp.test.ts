/**
 * La CSP de la web se escribe en `next.config.mjs` y nadie la probaba: el gtag
 * de Google Ads mandaba pings a hosts que no estaban en la lista y el navegador
 * los bloqueaba en silencio (tres errores de consola en cada alta, 14-09).
 *
 * Esta prueba lee la cabecera tal y como la produce el config —no una copia—
 * y fija lo decidido el 16-09: `ad.doubleclick.net` puede recibir pings (fetch
 * e imagen) pero nunca ejecutar script; los candados estructurales no se
 * relajan por accidente.
 */
import { describe, expect, it } from "vitest";

// El config exporta el resultado de withNextIntl(nextConfig); `headers()` sigue
// siendo la función nuestra.
import config from "../next.config.mjs";

type Cabecera = { key: string; value: string };

async function csp(): Promise<Record<string, string[]>> {
  const reglas = await (config as { headers: () => Promise<{ headers: Cabecera[] }[]> }).headers();
  const cab = reglas[0].headers.find((h) => h.key === "Content-Security-Policy");
  expect(cab, "la CSP tiene que estar en las cabeceras de /:path*").toBeDefined();
  const dirs: Record<string, string[]> = {};
  for (const trozo of cab!.value.split(";")) {
    const [nombre, ...valores] = trozo.trim().split(/\s+/);
    if (nombre) dirs[nombre] = valores;
  }
  return dirs;
}

describe("CSP de la web", () => {
  it("deja pasar los pings de Google Ads, incluido ad.doubleclick.net (decisión del 16-09)", async () => {
    const d = await csp();
    for (const host of [
      "https://www.google.com",
      "https://www.googleadservices.com",
      "https://googleads.g.doubleclick.net",
      "https://ad.doubleclick.net",
    ]) {
      expect(d["connect-src"], `connect-src debe incluir ${host}`).toContain(host);
      expect(d["img-src"], `img-src debe incluir ${host}`).toContain(host);
    }
  });

  it("ad.doubleclick.net solo recibe pings: nunca sirve script", async () => {
    const d = await csp();
    expect(d["script-src"]).not.toContain("https://ad.doubleclick.net");
    expect(d["script-src"]).not.toContain("https://www.google.com");
  });

  it("los candados estructurales siguen cerrados", async () => {
    const d = await csp();
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["upgrade-insecure-requests"]).toEqual([]);
    // Ningún comodín: cada host se nombra entero.
    for (const valores of Object.values(d)) for (const v of valores) expect(v).not.toMatch(/\*/);
  });
});
