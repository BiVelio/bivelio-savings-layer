import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * LA 404 ES NUESTRA, NO LA DE NEXT.
 *
 * POR QUÉ EXISTE. Hasta la 0.4.20, `GET /es/ruta-que-no-existe` devolvía la
 * 404 genérica de Next —`<title>404: This page could not be found.</title>`,
 * `<h1 class="next-error-h1">`—, en inglés, sin la cabecera de la web y sin
 * enlace de vuelta. Nada se ponía rojo: no es un error de compilación ni de
 * tipos, es una RUTA QUE FALTA. Un probador que se equivocara al copiar una
 * URL del README o del panel aterrizaba en una pantalla que no parecía de
 * BiVelio.
 *
 * El arreglo son ficheros que Next resuelve por convención de nombre, así que
 * lo que se comprueba aquí es que EXISTEN y que hacen lo que tienen que hacer:
 * el catch-all lanza `notFound()` (sin él, el layout del idioma ni se monta y
 * Next vuelve a su página), la 404 del idioma enlaza con el `Link` de
 * next-intl (con el de `next/link`, «volver al inicio» perdería el idioma) y
 * la raíz sustituye al componente por defecto de Next, que es el que mete
 * `next-error-h1` en el payload de todas las páginas. El render de verdad solo
 * lo valida `next build` + `next start`, que es lo que corre el CI.
 */

// `fileURLToPath` y no `.pathname`: la ruta lleva `[locale]`, que en una URL
// sale escapado como `%5Blocale%5D` y no existe en el disco.
const AQUI = fileURLToPath(new URL("./", import.meta.url));
const APP = fileURLToPath(new URL("../", import.meta.url));
const MENSAJES = fileURLToPath(new URL("../../messages/", import.meta.url));
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];

describe("la 404 de la web es propia y traducida", () => {
  it("hay un catch-all bajo [locale] que lanza notFound()", () => {
    expect(existsSync(AQUI + "[...rest]/page.tsx")).toBe(true);
    const src = readFileSync(AQUI + "[...rest]/page.tsx", "utf8");
    expect(src).toMatch(/import \{ notFound \} from "next\/navigation"/);
    expect(src).toMatch(/notFound\(\)/);
  });

  it("hay un not-found.tsx bajo [locale] con textos de los mensajes y enlace al inicio con el Link de next-intl", () => {
    expect(existsSync(AQUI + "not-found.tsx")).toBe(true);
    const src = readFileSync(AQUI + "not-found.tsx", "utf8");
    expect(src).toMatch(/getTranslations\("notFound"\)/);
    expect(src).toMatch(/from "@\/i18n\/navigation"/);
    expect(src).not.toMatch(/from "next\/link"/);
    expect(src).toMatch(/<Link href="\/"/);
    // El título de la pestaña también traducido, no el «404: This page…» de Next.
    expect(src).toMatch(/generateMetadata/);
  });

  it("una URL del panel que no existe ofrece la vuelta al resumen (la NavBar pública no se ve bajo /dashboard)", () => {
    const src = readFileSync(AQUI + "not-found.tsx", "utf8");
    // La distinción por ruta la hace el NAVEGADOR (SegunRuta → usePathname), no
    // `headers()`: leer cabeceras en el límite de «no encontrado» hacía dinámico
    // el segmento entero y la portada perdía el prerender (22-09-2026).
    expect(src).toMatch(/SegunRuta/);
    expect(src).not.toMatch(/from "next\/headers"/);
    expect(src).toMatch(/<Link href="\/dashboard"/);
    expect(src).toMatch(/estado\.volverAlResumen/);
    const cliente = readFileSync(APP + "components/SegunRuta.tsx", "utf8");
    expect(cliente).toMatch(/^"use client";/);
    expect(cliente).toMatch(/usePathname\(\)/);
  });

  it("no hay una 404 dentro de /dashboard: con loading.tsx delante nunca podría dar 404", () => {
    // Comprobado con `next start`: el shell (200) ya se ha enviado cuando la
    // página lanza notFound(), y el HTML sale con «Cargando el panel…».
    expect(existsSync(AQUI + "dashboard/not-found.tsx")).toBe(false);
    expect(existsSync(AQUI + "dashboard/[...rest]")).toBe(false);
  });

  it("la 404 raíz sustituye a la de Next y pinta su propio <html> (el layout raíz es un paso a través)", () => {
    expect(existsSync(APP + "not-found.tsx")).toBe(true);
    const src = readFileSync(APP + "not-found.tsx", "utf8");
    expect(src).toMatch(/<html lang="es">/);
    expect(src).toMatch(/import "\.\/globals\.css"/);
    // `next/error` es justo el componente con `next-error-h1` que se quiere fuera.
    expect(src).not.toMatch(/next\/error/);
    expect(src).toMatch(/href="\/"/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: tiene los textos de la 404 y de la variante del panel, no vacíos`, () => {
      const m = JSON.parse(readFileSync(`${MENSAJES}${loc}.json`, "utf8"));
      for (const k of ["metaTitle", "eyebrow", "title", "body", "home"]) {
        expect(typeof m.notFound?.[k], `notFound.${k}`).toBe("string");
        expect(m.notFound[k].length, `notFound.${k}`).toBeGreaterThan(0);
      }
      for (const k of ["noExisteTitulo", "noExisteCuerpo", "volverAlResumen"]) {
        expect(typeof m.dashboard.estado?.[k], `dashboard.estado.${k}`).toBe("string");
        expect(m.dashboard.estado[k].length, `dashboard.estado.${k}`).toBeGreaterThan(0);
      }
      // El título de la pestaña sigue la convención del sitio («X · BiVelio Savings Layer»).
      expect(m.notFound.metaTitle).toMatch(/ · BiVelio Savings Layer$/);
      // «Volver al inicio» es el MISMO enlace que el del login: una sola voz.
      expect(m.notFound.home).toBe(m.auth.backToVerifier);
    });
  }
});
