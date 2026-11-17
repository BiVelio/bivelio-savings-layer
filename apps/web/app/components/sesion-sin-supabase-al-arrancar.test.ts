import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { hayRastroDeAuth, vigilarSesion, type AuthDelNavegador, type EntornoDeSesion } from "./useHaySesion";

/**
 * LAS PÁGINAS PÚBLICAS NO CARGAN SUPABASE-JS AL ARRANCAR (17-11-2026).
 *
 * Medido con red móvil lenta (150 ms, 1,6 Mbps, CPU 4x): /es descargaba antes
 * del LCP dos chunks con GoTrueClient (~250 KB sin comprimir, ~65 KB gzip)
 * porque `useHaySesion` —el botón «Iniciar sesión / Panel» de la cabecera—
 * importaba el cliente de navegador de forma estática. Para un visitante que
 * llega de un anuncio, sin sesión, eran bytes por delante del primer pintado
 * que no servían de nada.
 *
 * Ahora el cliente se carga con `import()` solo cuando el navegador guarda
 * una cookie de Auth. Este fichero fija las dos mitades: (1) el grafo de
 * imports ESTÁTICOS del lado cliente de las páginas públicas no llega a
 * `@supabase/*`; (2) el botón sigue enterándose de la sesión en los mismos
 * casos que antes.
 */

const WEB = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------------------
// (1) El grafo de imports del cliente
// ---------------------------------------------------------------------------

/**
 * Las entradas de las páginas públicas: todo fichero de ruta (page, layout,
 * not-found, error, loading, template) de `[locale]` menos el panel y las
 * galerías de desarrollo (`captura-*`, `kit`). Se DESCUBREN recorriendo la
 * carpeta, no se listan a mano: un layout nuevo (los de `MensajesCliente`) o una
 * página nueva entra en la verja sin que nadie se acuerde de añadirla.
 */
const FICHEROS_DE_RUTA = /^(page|layout|not-found|error|loading|template)\.tsx$/;
const FUERA = /^app\/\[locale\]\/(dashboard|captura-[^/]+|kit)\//;
function entradasPublicas(dir = join(WEB, "app/[locale]")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    const rel = relative(WEB, ruta).split("\\").join("/");
    if (e.isDirectory()) return FUERA.test(`${rel}/`) ? [] : entradasPublicas(ruta);
    return FICHEROS_DE_RUTA.test(e.name) ? [rel] : [];
  });
}
const ENTRADAS = entradasPublicas().sort();

const EXTENSIONES = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

function resolver(desde: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(WEB, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(desde), spec);
  else return null; // paquete: no se recorre por dentro
  for (const ext of EXTENSIONES) {
    const ruta = base + ext;
    if (existsSync(ruta) && statSync(ruta).isFile()) return /\.(tsx?|m?js)$/.test(ruta) ? ruta : null;
  }
  return null;
}

/**
 * Los imports que el bundler mete en el MISMO chunk: `import … from`,
 * `export … from` e `import "x"`. Fuera quedan `import type`, los imports con
 * todos sus nombres marcados `type` (TypeScript los borra) y los `import()`
 * dinámicos, que son justo la vía buena.
 */
function importsEstaticos(fuente: string): string[] {
  const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specs: string[] = [];
  const conFrom = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const m of sinComentarios.matchAll(conFrom)) {
    if (m[2]) continue;
    const llaves = m[3].match(/^\{([\s\S]*)\}$/);
    if (llaves) {
      const nombres = llaves[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (nombres.length > 0 && nombres.every((n) => n.startsWith("type "))) continue;
    }
    specs.push(m[4]);
  }
  for (const m of sinComentarios.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  return specs;
}

/** Recorre el grafo y devuelve las cadenas «entrada → … → @supabase/x» que acaban en el cliente. */
function caminosASupabaseEnCliente(entrada: string): string[] {
  const hallados: string[] = [];
  const vistos = new Set<string>();
  const visitar = (ruta: string, enCliente: boolean, camino: string[]) => {
    const clave = `${ruta}|${enCliente}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    const fuente = readFileSync(ruta, "utf8");
    const cliente = enCliente || /^\s*["']use client["']/.test(fuente);
    const aqui = [...camino, relative(WEB, ruta)];
    for (const spec of importsEstaticos(fuente)) {
      if (spec.startsWith("@supabase/")) {
        if (cliente) hallados.push([...aqui, spec].join(" → "));
        continue;
      }
      const destino = resolver(ruta, spec);
      if (destino) visitar(destino, cliente, aqui);
    }
  };
  visitar(join(WEB, entrada), false, []);
  return hallados;
}

describe("el JS inicial de las páginas públicas no trae supabase-js", () => {
  for (const entrada of ENTRADAS) {
    it(`${entrada}: ningún import estático del lado cliente llega a @supabase/*`, () => {
      expect(caminosASupabaseEnCliente(entrada)).toEqual([]);
    });
  }

  it("las entradas se descubren: están las páginas y los layouts de cada tramo, y no el panel", () => {
    for (const f of ["app/[locale]/layout.tsx", "app/[locale]/page.tsx", "app/[locale]/login/page.tsx", "app/[locale]/login/layout.tsx", "app/[locale]/invitacion/layout.tsx", "app/[locale]/invitacion/[token]/page.tsx", "app/[locale]/signup/success/page.tsx"]) {
      expect(ENTRADAS, f).toContain(f);
    }
    expect(ENTRADAS.filter((f) => /\/(dashboard|captura-|kit)\b/.test(f))).toEqual([]);
  });

  it("el recorrido SÍ ve un import estático de supabase en cliente (la verja no está ciega)", () => {
    // `lib/supabase/client.ts` es cliente e importa `@supabase/ssr`: si el
    // recorrido no lo encontrara, los tests de arriba pasarían por no mirar.
    expect(caminosASupabaseEnCliente("lib/supabase/client.ts")).toEqual([
      "lib/supabase/client.ts → @supabase/ssr",
    ]);
  });

  it("el hook de la cabecera carga el cliente con import(), no con un import estático", () => {
    const hook = readFileSync(join(WEB, "app/components/useHaySesion.ts"), "utf8");
    expect(importsEstaticos(hook)).not.toContain("@/lib/supabase/client");
    expect(hook).toMatch(/import\(\s*"@\/lib\/supabase\/client"\s*\)/);
  });

  it("el cliente de navegador avisa al crearse (la cabecera se suscribe a él)", () => {
    const cliente = readFileSync(join(WEB, "lib/supabase/client.ts"), "utf8");
    expect(cliente).toMatch(/avisarDeCliente\(cliente\)/);
    const aviso = readFileSync(join(WEB, "lib/supabase/aviso-del-cliente.ts"), "utf8");
    expect(importsEstaticos(aviso)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) El botón se entera de la sesión en los mismos casos que antes
// ---------------------------------------------------------------------------

const COOKIE = "sb-rsxebsvguppssbociwiu-auth-token";

describe("hayRastroDeAuth", () => {
  it.each([
    [`${COOKIE}=base64-eyJ`, true],
    [`_ga=GA1.1; ${COOKIE}.0=base64-eyJ; ${COOKIE}.1=abc`, true],
    [`otra=1;${COOKIE}-code-verifier=xyz`, true],
    ["", false],
    ["_ga=GA1.1; _gcl_au=1.1.1", false],
    ["NEXT_LOCALE=es; sb-algo=1", false],
    [`x=${COOKIE}`, false], // el nombre en el VALOR de otra cookie no cuenta
  ])("%s → %s", (cookies, esperado) => {
    expect(hayRastroDeAuth(cookies)).toBe(esperado);
  });
});

function clienteFalso(sesionInicial: unknown) {
  let oyente: ((evento: string, sesion: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const cliente: AuthDelNavegador = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sesionInicial } })),
      onAuthStateChange: vi.fn((cb) => {
        oyente = cb;
        return { data: { subscription: { unsubscribe } } };
      }),
    },
  };
  return { cliente, unsubscribe, emitir: (evento: string, sesion: unknown) => oyente?.(evento, sesion) };
}

function entornoFalso(cookies: string, cliente: AuthDelNavegador) {
  const avisos = new Set<(c: AuthDelNavegador) => void>();
  let regreso: (() => void) | null = null;
  const estado = { cookies, valores: [] as boolean[] };
  const entorno: EntornoDeSesion = {
    leerCookies: () => estado.cookies,
    cargarCliente: vi.fn(async () => cliente),
    alCrearseElCliente: (o) => {
      avisos.add(o);
      return () => avisos.delete(o);
    },
    alVolverALaPagina: (c) => {
      regreso = c;
      return () => {
        regreso = null;
      };
    },
    alCambiar: (v) => estado.valores.push(v),
  };
  return {
    entorno,
    estado,
    crearOtro: () => [...avisos].forEach((o) => o(cliente)),
    volver: () => regreso?.(),
    get oyentes() {
      return avisos.size + (regreso ? 1 : 0);
    },
  };
}

const esperar = () => new Promise((r) => setTimeout(r, 0));

describe("vigilarSesion", () => {
  it("sin cookie de Auth no carga el cliente y se queda como invitado", async () => {
    const { cliente } = clienteFalso(null);
    const e = entornoFalso("_ga=GA1.1", cliente);
    vigilarSesion(e.entorno);
    await esperar();
    expect(e.entorno.cargarCliente).not.toHaveBeenCalled();
    expect(e.estado.valores).toEqual([]);
  });

  it("con cookie de Auth carga el cliente, lee la sesión y sigue sus cambios", async () => {
    const f = clienteFalso({ user: { id: "u" } });
    const e = entornoFalso(`${COOKIE}=x`, f.cliente);
    const limpiar = vigilarSesion(e.entorno);
    await esperar();
    expect(e.entorno.cargarCliente).toHaveBeenCalledTimes(1);
    expect(f.cliente.auth.getSession).toHaveBeenCalledTimes(1);
    expect(e.estado.valores).toEqual([true]);
    f.emitir("SIGNED_OUT", null);
    expect(e.estado.valores).toEqual([true, false]);
    limpiar();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("sin cookie, si otro componente de la pestaña crea el cliente y entra, el botón lo ve", async () => {
    const f = clienteFalso(null);
    const e = entornoFalso("", f.cliente);
    vigilarSesion(e.entorno);
    e.crearOtro(); // p. ej. AceptarInvitacion: createClient().auth.signInWithPassword(…)
    await esperar();
    expect(e.entorno.cargarCliente).not.toHaveBeenCalled();
    expect(f.cliente.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
    f.emitir("SIGNED_IN", { user: { id: "u" } });
    expect(e.estado.valores.at(-1)).toBe(true);
  });

  it("sin cookie al montar, si se entra en otra pestaña, lo ve al volver a esta", async () => {
    const f = clienteFalso({ user: { id: "u" } });
    const e = entornoFalso("", f.cliente);
    vigilarSesion(e.entorno);
    e.volver();
    await esperar();
    expect(e.entorno.cargarCliente).not.toHaveBeenCalled();
    e.estado.cookies = `${COOKIE}.0=x`;
    e.volver();
    await esperar();
    expect(e.entorno.cargarCliente).toHaveBeenCalledTimes(1);
    expect(e.estado.valores).toEqual([true]);
  });

  it("un `null` tardío de getSession() no pisa un SIGNED_IN que llegó antes", async () => {
    // La invitación: la barra se suscribe al aviso de createClient() y, acto
    // seguido, el componente llama a signInWithPassword. Si la foto de
    // getSession() (sin sesión) resuelve DESPUÉS del evento, manda el evento.
    let resolverFoto: (v: { data: { session: unknown } }) => void = () => {};
    const f = clienteFalso(null);
    vi.mocked(f.cliente.auth.getSession).mockImplementationOnce(() => new Promise((r) => (resolverFoto = r)));
    const e = entornoFalso("", f.cliente);
    vigilarSesion(e.entorno);
    e.crearOtro();
    f.emitir("SIGNED_IN", { user: { id: "u" } });
    resolverFoto({ data: { session: null } });
    await esperar();
    expect(e.estado.valores).toEqual([true]);
  });

  it("se suscribe UNA sola vez aunque coincidan carga propia, aviso y regreso", async () => {
    const f = clienteFalso(null);
    const e = entornoFalso(`${COOKIE}=x`, f.cliente);
    vigilarSesion(e.entorno);
    e.crearOtro();
    e.volver();
    await esperar();
    e.crearOtro();
    e.volver();
    await esperar();
    expect(f.cliente.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(e.oyentes).toBe(0); // ya suscrito: sin oyentes de aviso ni de regreso
  });

  it("al desmontar suelta los oyentes y no pinta lo que llegue tarde", async () => {
    const f = clienteFalso({ user: { id: "u" } });
    const e = entornoFalso(`${COOKIE}=x`, f.cliente);
    const limpiar = vigilarSesion(e.entorno);
    limpiar(); // antes de que resuelva el import()
    await esperar();
    expect(e.oyentes).toBe(0);
    expect(f.cliente.auth.onAuthStateChange).not.toHaveBeenCalled();
    expect(e.estado.valores).toEqual([]);
  });

  it("si el chunk no llega, se queda como invitado y reintenta al volver", async () => {
    const f = clienteFalso({ user: { id: "u" } });
    const e = entornoFalso(`${COOKIE}=x`, f.cliente);
    vi.mocked(e.entorno.cargarCliente).mockRejectedValueOnce(new Error("ChunkLoadError"));
    vigilarSesion(e.entorno);
    await esperar();
    expect(e.estado.valores).toEqual([]);
    e.volver();
    await esperar();
    expect(e.estado.valores).toEqual([true]);
  });
});
