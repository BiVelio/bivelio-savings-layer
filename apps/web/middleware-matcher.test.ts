import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * EL MIDDLEWARE TIENE QUE VER TODA URL QUE NO SEA UN FICHERO.
 *
 * POR QUÉ EXISTE. Con la 0.5.0 publicada, `GET /foo.png`, `/foo.bar`,
 * `/favicon.ico` o `/authors` daban **500** en vez de 404. El `matcher` del
 * middleware excluía «cualquier ruta con un punto» y cualquier ruta que
 * EMPEZARA por `api`, `auth`… (sin barra). Esas URL se saltaban next-intl,
 * `[locale]` recibía «foo.png» como idioma y `Intl.NumberFormat("foo.png")`
 * reventaba antes de que el `notFound()` del layout llegara a contar.
 *
 * El `matcher` tiene que ser un literal (Next lo lee en el build sin ejecutar
 * el módulo), así que no puede derivarse de la carpeta `public/`. Este test es
 * lo que impide que se desincronicen: si alguien añade un fichero a la raíz de
 * `public/` y no lo excluye, el middleware lo mandaría a `/<idioma>/…` y el
 * fichero dejaría de servirse.
 *
 * La conversión a RegExp imita la de Next para este patrón (un único grupo de
 * expresión regular, anclado): lo que de verdad lo valida es `next build` +
 * una petición real, que es lo que se hizo al escribirlo.
 */

const WEB = fileURLToPath(new URL("./", import.meta.url));

function matcher(): RegExp {
  const src = readFileSync(WEB + "middleware.ts", "utf8");
  const m = src.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  expect(m, "no se encuentra el matcher en middleware.ts").not.toBeNull();
  // El literal de TS lleva las barras escapadas: «\\.» en el fuente es «\.».
  const patron = JSON.parse(`"${m![1]}"`) as string;
  return new RegExp(`^${patron}$`);
}

const pasaPorElMiddleware = (ruta: string) => matcher().test(ruta);

describe("el matcher del middleware", () => {
  it("las URL con punto que NO son ficheros pasan por next-intl (antes, 500)", () => {
    for (const ruta of ["/foo.png", "/foo.bar", "/favicon.ico", "/apple-touch-icon.png", "/migrate-to-0.5", "/x.y/z"]) {
      expect(pasaPorElMiddleware(ruta), ruta).toBe(true);
    }
  });

  it("un prefijo reservado sin barra no se come la ruta (/authors no es /auth/)", () => {
    for (const ruta of ["/authors", "/apiary", "/licensesx", "/_vercelx", "/datos", "/fontsy"]) {
      expect(pasaPorElMiddleware(ruta), ruta).toBe(true);
    }
  });

  it("las páginas siguen pasando por él, con y sin idioma", () => {
    for (const ruta of ["/", "/es", "/en/pricing", "/pricing", "/en/migrate-to-0.5", "/es/foo.png", "/en/opengraph-image"]) {
      expect(pasaPorElMiddleware(ruta), ruta).toBe(true);
    }
  });

  it("los route handlers sin idioma y lo interno de Next/Vercel quedan fuera", () => {
    for (const ruta of [
      "/api/health",
      "/api/stripe/webhook",
      "/auth/callback",
      "/auth/signout",
      "/licenses/revocations",
      "/_next/static/chunks/main.js",
      "/_vercel/insights/script.js",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(pasaPorElMiddleware(ruta), ruta).toBe(false);
    }
  });

  it("los informes del banco (/benchmarks/data/…/x.json) quedan fuera; /benchmarks sin idioma, no", () => {
    expect(pasaPorElMiddleware("/benchmarks/data/2026-10-01/banco-semanal-5bec174.json")).toBe(false);
    expect(pasaPorElMiddleware("/benchmarks")).toBe(true);
    expect(pasaPorElMiddleware("/en/benchmarks")).toBe(true);
  });

  it("todo route handler fuera de [locale] queda fuera del middleware", () => {
    // Su prefijo estático (hasta el primer segmento dinámico) + algo con punto.
    const handlers: string[] = [];
    const recorrer = (dir: string, ruta: string[]) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "[locale]") recorrer(`${dir}/${e.name}`, [...ruta, e.name]);
        else if (e.name === "route.ts") handlers.push(ruta.join("/"));
      }
    };
    recorrer(WEB + "app", []);
    expect(handlers.length).toBeGreaterThan(3);
    for (const h of handlers) {
      const estatico = h.split("/").filter((s, i, a) => !a.slice(0, i + 1).some((x) => x.startsWith("[")));
      const ruta = `/${[...estatico, "x", "y.json"].join("/")}`;
      expect(pasaPorElMiddleware(ruta), `app/${h}/route.ts → ${ruta}`).toBe(false);
    }
  });

  it("todo lo que hay en la raíz de public/ queda fuera (si no, dejaría de servirse)", () => {
    const entradas = readdirSync(WEB + "public", { withFileTypes: true });
    expect(entradas.length).toBeGreaterThan(0);
    for (const e of entradas) {
      if (e.name.startsWith(".")) continue;
      const ruta = e.isDirectory() ? `/${e.name}/cualquier-cosa.png` : `/${e.name}`;
      expect(pasaPorElMiddleware(ruta), `public/${e.name} → ${ruta}`).toBe(false);
    }
  });
});
