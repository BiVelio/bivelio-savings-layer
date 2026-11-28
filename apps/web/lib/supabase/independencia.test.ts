import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { describe, it, expect, vi, afterEach } from "vitest";

import { hayRastroDeAuth } from "@/app/components/useHaySesion";
import { claveDeServicio } from "./admin";
import { COOKIE_DE_SESION, SUPABASE_URL, nombreDeCookieDeSesion, opcionesDeCookie } from "./env";

/**
 * LA BASE DE CUENTAS Y LA COOKIE, SEPARABLES DE PRIVACY
 * (docs/RUNBOOK-INDEPENDENCIA-DE-PRIVACY.md).
 *
 * Hoy Savings y Privacy usan el mismo proyecto de Supabase y, por eso, una
 * cookie de sesión con el MISMO nombre; Privacy la escribe en `.bivelio.com` y
 * esta app la lee. Aquí se fijan los dos interruptores nuevos:
 *   · NEXT_PUBLIC_BVSALA_COOKIE_SESION — el nombre de la cookie de Savings;
 *   · BVSALA_SUPABASE_SECRET_KEY       — la llave de servicio propia.
 * Los dos APAGADOS por defecto, y apagados todo es como antes.
 */

afterEach(() => vi.restoreAllMocks());

const REF = "rsxebsvguppssbociwiu";
const COOKIE_DE_LA_LIBRERIA = `sb-${REF}-auth-token`;

/** Una sesión que la librería acepta sin ir a la red: el token caduca dentro de una hora. */
function cookieDeSesion(): string {
  const ahora = Math.floor(Date.now() / 1000);
  const cabeza = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const cuerpo = Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000001", exp: ahora + 3600 })).toString("base64url");
  const sesion = {
    access_token: `${cabeza}.${cuerpo}.firma`,
    refresh_token: "r",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: ahora + 3600,
    user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", email: "persona@ejemplo.com" },
  };
  return "base64-" + Buffer.from(JSON.stringify(sesion)).toString("base64url");
}

/** Un cliente de servidor con las cookies que manda el navegador y las opciones que se le den. */
function clienteCon(cookies: { name: string; value: string }[], opciones: { cookieOptions?: { name: string } }) {
  return createServerClient(`https://${REF}.supabase.co`, "anon-de-prueba", {
    ...opciones,
    cookies: { getAll: () => cookies, setAll: () => {} },
  });
}

describe("cookie de sesión — apagado (hoy)", () => {
  it("sin la variable no hay nombre propio y las opciones quedan VACÍAS (byte a byte como antes)", () => {
    expect(process.env.NEXT_PUBLIC_BVSALA_COOKIE_SESION).toBeUndefined();
    expect(COOKIE_DE_SESION).toBeUndefined();
    expect(opcionesDeCookie()).toEqual({});
    expect(Object.keys(opcionesDeCookie(undefined))).toEqual([]);
  });

  it("el proyecto y su respaldo no cambian", () => {
    // El respaldo de siempre: con las variables de siempre, el mismo proyecto.
    expect(SUPABASE_URL).toBe(process.env.NEXT_PUBLIC_SUPABASE_URL ?? `https://${REF}.supabase.co`);
  });

  it("la librería, sin nombre propio, lee la cookie `sb-<ref>-auth-token` (también la que escribe Privacy en .bivelio.com)", async () => {
    const cliente = clienteCon([{ name: COOKIE_DE_LA_LIBRERIA, value: cookieDeSesion() }], opcionesDeCookie(undefined));
    const { data } = await cliente.auth.getSession();
    expect(data.session?.user.email).toBe("persona@ejemplo.com");
  });

  it("el detector de la cabecera sigue con la regla de siempre", () => {
    expect(hayRastroDeAuth(`${COOKIE_DE_LA_LIBRERIA}=base64-eyJ`)).toBe(true);
    expect(hayRastroDeAuth("_ga=GA1.1")).toBe(false);
  });
});

describe("cookie de sesión — encendido", () => {
  const PROPIA = "bvsala-auth-token";

  it("valida el nombre: uno bueno se usa; uno malo se ignora con aviso", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(nombreDeCookieDeSesion(PROPIA)).toBe(PROPIA);
    expect(nombreDeCookieDeSesion(`  ${PROPIA} `)).toBe(PROPIA);
    expect(nombreDeCookieDeSesion("")).toBeUndefined();
    for (const malo of ["con.punto", "con espacio", "a;b=c", "x".repeat(65), "ñ"]) {
      expect(nombreDeCookieDeSesion(malo), malo).toBeUndefined();
    }
    expect(aviso).toHaveBeenCalled();
    expect(opcionesDeCookie(PROPIA)).toEqual({ cookieOptions: { name: PROPIA } });
  });

  it("⛔ con nombre propio la cookie de Privacy (mismo nombre que la de la librería) YA NO abre sesión", async () => {
    const cliente = clienteCon([{ name: COOKIE_DE_LA_LIBRERIA, value: cookieDeSesion() }], opcionesDeCookie(PROPIA));
    const { data } = await cliente.auth.getSession();
    expect(data.session).toBeNull();
  });

  it("con nombre propio se lee SU cookie", async () => {
    const cliente = clienteCon(
      [
        { name: COOKIE_DE_LA_LIBRERIA, value: "base64-basura" },
        { name: PROPIA, value: cookieDeSesion() },
      ],
      opcionesDeCookie(PROPIA),
    );
    const { data } = await cliente.auth.getSession();
    expect(data.session?.user.email).toBe("persona@ejemplo.com");
  });

  it("el detector de la cabecera solo ve la cookie propia, sus trozos y su code-verifier", () => {
    expect(hayRastroDeAuth(`${PROPIA}=base64-eyJ`, PROPIA)).toBe(true);
    expect(hayRastroDeAuth(`_ga=1; ${PROPIA}.0=a; ${PROPIA}.1=b`, PROPIA)).toBe(true);
    expect(hayRastroDeAuth(`x=1;${PROPIA}-code-verifier=abc`, PROPIA)).toBe(true);
    // La de Privacy ya no es una sesión de esta app: no carga supabase-js.
    expect(hayRastroDeAuth(`${COOKIE_DE_LA_LIBRERIA}=base64-eyJ`, PROPIA)).toBe(false);
    expect(hayRastroDeAuth(`${PROPIA}-otra=1`, PROPIA)).toBe(false);
    expect(hayRastroDeAuth(`x=${PROPIA}`, PROPIA)).toBe(false);
  });

  it("los cuatro clientes de la app pasan por opcionesDeCookie (si uno no, leería otra cookie)", () => {
    const leer = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    expect(leer("./client.ts")).toContain("opcionesDeCookie(COOKIE_DE_SESION)");
    expect(leer("./server.ts").match(/\.\.\.opcionesDeCookie\(\)/g)).toHaveLength(2);
    expect(leer("./middleware.ts")).toContain("...opcionesDeCookie()");
  });

  it("no hay otro createServerClient/createBrowserClient en la app fuera de lib/supabase", () => {
    const WEB = fileURLToPath(new URL("../../", import.meta.url));
    const fuera: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
        const ruta = join(dir, e.name);
        if (e.isDirectory()) recorrer(ruta);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.")) {
          const rel = relative(WEB, ruta).split("\\").join("/");
          if (rel.startsWith("lib/supabase/")) continue;
          if (/create(Server|Browser)Client\s*\(/.test(readFileSync(ruta, "utf8"))) fuera.push(rel);
        }
      }
    };
    recorrer(WEB);
    expect(fuera).toEqual([]);
  });
});

describe("llave de servicio propia (BVSALA_SUPABASE_SECRET_KEY)", () => {
  it("apagado (hoy): la service_role de siempre", () => {
    expect(claveDeServicio({ SUPABASE_SERVICE_ROLE_KEY: "service-role" })).toBe("service-role");
    expect(claveDeServicio({ SUPABASE_SERVICE_ROLE_KEY: "service-role", BVSALA_SUPABASE_SECRET_KEY: "  " })).toBe("service-role");
    expect(claveDeServicio({})).toBeUndefined();
  });

  it("encendido: la propia manda", () => {
    expect(claveDeServicio({ SUPABASE_SERVICE_ROLE_KEY: "service-role", BVSALA_SUPABASE_SECRET_KEY: "sb_secret_propia" })).toBe("sb_secret_propia");
    expect(claveDeServicio({ BVSALA_SUPABASE_SECRET_KEY: "sb_secret_propia" })).toBe("sb_secret_propia");
  });

  it("un nombre genérico (SUPABASE_SECRET_KEY) NO la cambia: lo podría poner una integración sin que nadie lo decida", () => {
    expect(claveDeServicio({ SUPABASE_SERVICE_ROLE_KEY: "service-role", SUPABASE_SECRET_KEY: "otra" })).toBe("service-role");
  });
});
