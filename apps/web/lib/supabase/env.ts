// Public Supabase config. Hoy está atada al proyecto COMPARTIDO de BiVelio
// (rsxebsvguppssbociwiu): ahí viven también las cuentas de Privacy, y por eso un
// cliente entra con la misma cuenta en los dos productos. Para separar Savings
// basta con cambiar las variables de entorno (ver
// docs/RUNBOOK-INDEPENDENCIA-DE-PRIVACY.md): el código no necesita saber cuál es.
// El valor de respaldo de la URL se deja como estaba a propósito, para que con
// las variables de siempre todo se comporte igual que antes. The anon key is a
// publishable key (safe in the browser; access is governed by RLS) and is read
// from the environment.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://rsxebsvguppssbociwiu.supabase.co";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** True when auth is configured; lets the marketing site run without Supabase env. */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * EL NOMBRE DE LA COOKIE DE SESIÓN — un interruptor, APAGADO por defecto.
 *
 * POR QUÉ EXISTE. Sin nombre propio, `@supabase/ssr` llama a la cookie
 * `sb-<ref del proyecto>-auth-token`. Privacy usa el mismo proyecto, así que su
 * cookie se llama IGUAL, y Privacy la escribe en el dominio padre `.bivelio.com`
 * (su `NEXT_PUBLIC_COOKIE_DOMAIN`). El navegador se la manda también a
 * savings.bivelio.com, y esta app la lee como si fuera suya: ese es hoy el
 * «inicio de sesión único» entre los dos productos, y también la razón de que
 * puedan convivir dos cookies con el mismo nombre (la de Savings, solo del host,
 * y la de Privacy, del dominio padre).
 *
 * Con `NEXT_PUBLIC_BVSALA_COOKIE_SESION` puesta (p. ej. `bvsala-auth-token`),
 * los cuatro clientes de esta app (navegador, rutas, solo lectura y el
 * middleware) leen y escriben SOLO esa cookie: la de Privacy deja de contar.
 * Efecto aceptado al encenderlo: todo el mundo tiene que volver a entrar una
 * vez. Vacía (hoy) = el nombre de la librería, exactamente como antes.
 *
 * Es `NEXT_PUBLIC_` porque el cliente de navegador también escribe la cookie y
 * tiene que usar el mismo nombre; no es un secreto. Next la incrusta al
 * compilar: cambiarla pide redesplegar.
 */
export const VAR_COOKIE_DE_SESION = "NEXT_PUBLIC_BVSALA_COOKIE_SESION";

/** Letras, cifras, `-` y `_`: sin punto (los trozos son `<nombre>.0`, `.1`…) ni nada que rompa una cabecera. */
const NOMBRE_DE_COOKIE_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * El nombre configurado, o `undefined` (= el de la librería). Un valor que no
 * sea un nombre de cookie válido se IGNORA con un aviso: una errata en la
 * variable no puede dejar a nadie sin sesión de forma rara; como mucho deja el
 * comportamiento de siempre.
 */
export function nombreDeCookieDeSesion(valor: string | undefined): string | undefined {
  const v = valor?.trim();
  if (!v) return undefined;
  if (NOMBRE_DE_COOKIE_VALIDO.test(v)) return v;
  console.warn(`[supabase] ${VAR_COOKIE_DE_SESION} no es un nombre de cookie válido: se usa el de siempre`);
  return undefined;
}

// Literal, para que Next lo incruste también en el JS del navegador.
export const COOKIE_DE_SESION = nombreDeCookieDeSesion(process.env.NEXT_PUBLIC_BVSALA_COOKIE_SESION);

/**
 * Lo que se añade a las opciones de cada cliente de `@supabase/ssr`. Sin nombre
 * propio es un objeto VACÍO: las opciones quedan byte a byte como antes.
 */
export function opcionesDeCookie(nombre: string | undefined = COOKIE_DE_SESION): { cookieOptions?: { name: string } } {
  return nombre ? { cookieOptions: { name: nombre } } : {};
}
