import type { ComponentProps } from "react";
import type { Analytics, BeforeSendEvent } from "@vercel/analytics/react";

import { locales } from "@/i18n/config";

/**
 * MEDICIÓN DE LA WEB — de savings.bivelio.com, NUNCA del paquete.
 *
 * El SDK, el gateway y el cliente de Python no llevan telemetría y no la van a
 * llevar (lo promete el README). Lo que se mide aquí es el SITIO: cuánta gente
 * ve las páginas de instalación y cuánta copia el comando. Con Vercel Web
 * Analytics, que cuenta en agregado y sin cookies (app/components/MedicionWeb.tsx).
 *
 * Este fichero es la parte pura: qué evento, con qué propiedades y qué URL sale.
 * No toca el DOM ni la red; `medir.ts` lo conecta con `track()`. Las reglas que
 * fija `eventos.test.ts`:
 *
 *  - POCOS EVENTOS, con nombre estable (EVENTOS). Cambiar un nombre parte la
 *    serie en el panel de Vercel.
 *  - DOS PROPIEDADES COMO MUCHO por evento: es el límite del plan Pro de Vercel
 *    (con Web Analytics Plus serían ocho). Por eso «dónde» es un solo valor,
 *    `página/zona`.
 *  - NINGÚN VALOR SALE DE LO QUE ESCRIBE EL VISITANTE. Gestor, destino y plan son
 *    literales de este fichero; la página sale de la lista blanca RUTAS; la zona,
 *    de un atributo `data-medir-zona`, un `id` o un landmark escritos en el
 *    código. El texto copiado NUNCA viaja: solo se lee para saber con qué gestor
 *    se instala.
 *  - LA URL DE CADA VISTA Y EVENTO SALE SIN QUERY NI FRAGMENTO, con el token de
 *    las invitaciones tapado y las rutas desconocidas (las del 404, que pueden
 *    llevar cualquier cosa que alguien teclee) plegadas en `[...rest]`.
 */

/** Los nombres de los eventos, tal y como aparecen en el panel de Vercel. */
export const EVENTOS = {
  /** Copiar un comando de instalación (botón «Copiar» o selección + Ctrl/Cmd+C). */
  copia: "Install Command Copied",
  /** Clic hacia GitHub, npm o PyPI. */
  salida: "Outbound Click",
  /** Clic en un enlace a la página de alta de Savings Cloud. */
  alta: "Signup Started",
} as const;

/** El atributo con el que una sección se nombra a sí misma para la medición. */
export const ATRIBUTO_ZONA = "data-medir-zona";

/**
 * Las rutas del web de Vercel. Se fijan a mano y no se deja la ruta aleatoria
 * por build («Resilient Intake» de @vercel/analytics 2.x): esa ruta no es
 * conocida al escribir el `matcher` de middleware.ts, así que next-intl la
 * redirigiría a `/<idioma>/…` y no llegaría nada. `/_vercel/` ya está fuera del
 * middleware (middleware-matcher.test.ts) y es del mismo origen, así que la CSP
 * no necesita ningún host nuevo. Vercel sirve las dos rutas cuando Web
 * Analytics está activo en el proyecto.
 */
export const RUTAS_DE_VERCEL = {
  scriptSrc: "/_vercel/insights/script.js",
  viewEndpoint: "/_vercel/insights/view",
  eventEndpoint: "/_vercel/insights/event",
} as const;

export type Gestor = "npm" | "npx" | "pnpm" | "yarn" | "bun" | "pip" | "pipx" | "uv" | "poetry";
export type Destino = "github" | "npm" | "pypi";
export type Plan = "measure" | "pro" | "team";

/**
 * Las rutas de `app/[locale]` (sin el idioma), con sus segmentos dinámicos
 * tal cual. `eventos.test.ts` la compara con las carpetas que tienen
 * `page.tsx`: una página nueva que no se añada aquí se mediría como `other`.
 */
export const RUTAS = [
  "",
  "benchmarks",
  "captura-cuenta",
  "captura-estados",
  "captura-panel",
  "dashboard",
  "dashboard/account",
  "dashboard/extracto",
  "dashboard/how-it-works",
  "dashboard/install",
  "dashboard/proof",
  "dashboard/team",
  "dashboard/verify",
  "dashboard/your-bench",
  "how-it-works",
  "invitacion/[token]",
  "kit",
  "login",
  "migrate-to-0.5",
  "paper",
  "pricing",
  "privacy",
  "reset-password",
  "signup",
  "signup/success",
] as const;

const IDIOMAS: readonly string[] = locales;

/** El paquete de npm o el de PyPI: un comando que no los nombra no es «instalar BV-SALA». */
const PAQUETE = /@bivelio\/savings-layer|bivelio-savings-layer/;

/** Cada gestor con los verbos que instalan o ejecutan un paquete. El orden importa: `pipx` antes que `pip`. */
const GESTORES: readonly (readonly [RegExp, Gestor])[] = [
  [/^npx\s/, "npx"],
  [/^npm\s+(?:i|install|add)(?:\s|$)/, "npm"],
  [/^pnpm\s+(?:add|i|install|dlx)(?:\s|$)/, "pnpm"],
  [/^pnpx\s/, "pnpm"],
  [/^yarn\s+(?:add|dlx)(?:\s|$)/, "yarn"],
  [/^bunx\s/, "bun"],
  [/^bun\s+(?:add|i|install|x)(?:\s|$)/, "bun"],
  [/^pipx\s+(?:install|run)(?:\s|$)/, "pipx"],
  [/^(?:pip3?|python3?\s+-m\s+pip)\s+install(?:\s|$)/, "pip"],
  [/^uv\s+(?:add|pip\s+install|tool\s+install)(?:\s|$)/, "uv"],
  [/^poetry\s+add(?:\s|$)/, "poetry"],
];

/**
 * El gestor de paquetes del primer comando que instala BV-SALA en `texto`, o
 * `null` si no hay ninguno (un `bvsala claude`, un ejemplo de código, media
 * línea seleccionada). Se saltan los comentarios y el `$ ` de un prompt.
 */
export function gestorDelComando(texto: string): Gestor | null {
  for (const cruda of texto.split(/\r?\n/)) {
    const linea = cruda.trim().replace(/^\$\s+/, "");
    if (!PAQUETE.test(linea)) continue;
    for (const [patron, gestor] of GESTORES) if (patron.test(linea)) return gestor;
  }
  return null;
}

/** GitHub, npm o PyPI si el enlace sale hacia uno de ellos; `null` en cualquier otro caso. */
export function destinoExterno(href: string): Destino | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "github.com") return "github";
  if (host === "npmjs.com") return "npm";
  if (host === "pypi.org") return "pypi";
  return null;
}

/** Separa el idioma de la ruta y empareja el resto con RUTAS. */
function analizar(pathname: string): { idioma: string | null; ruta: string | null } {
  const trozos = pathname.split("/").filter(Boolean);
  const idioma = trozos.length > 0 && IDIOMAS.includes(trozos[0]!) ? trozos.shift()! : null;
  for (const ruta of RUTAS) {
    const patron = ruta ? ruta.split("/") : [];
    if (patron.length !== trozos.length) continue;
    if (patron.every((p, i) => p.startsWith("[") || p === trozos[i])) return { idioma, ruta };
  }
  return { idioma, ruta: null };
}

/**
 * El plan del alta si el enlace lleva a la página de alta de ESTE sitio; `null`
 * si no. El destino `next` de /pricing y de la portada (`/es/dashboard?plan=pro`
 * o `?plan=equipo`) dice el plan; sin él, el alta es la de Measure, el plan
 * gratuito.
 */
export function planDelAlta(href: string, origen: string): Plan | null {
  let url: URL;
  try {
    url = new URL(href, origen);
    if (url.origin !== new URL(origen).origin) return null;
  } catch {
    return null;
  }
  if (analizar(url.pathname).ruta !== "signup") return null;
  let plan: string | null = null;
  try {
    plan = new URL(url.searchParams.get("next") ?? "", url.origin).searchParams.get("plan");
  } catch {
    plan = null;
  }
  if (plan === "pro") return "pro";
  if (plan === "equipo" || plan === "team") return "team";
  return "measure";
}

/** El nombre de la página para «dónde»: `home`, `how-it-works`, `dashboard/install`, `invitacion`… u `other`. */
export function paginaDe(pathname: string): string {
  const { ruta } = analizar(pathname);
  if (ruta === null) return "other";
  if (ruta === "") return "home";
  return ruta.replace(/\/\[[^\]]+\]$/, "");
}

/**
 * La ruta limpia de una página, en las dos formas que pide Vercel: `path`
 * (`/es/invitacion/[token]`) y `route`, la plantilla de la ruta
 * (`/[locale]/invitacion/[token]`). Una ruta conocida conserva su plantilla;
 * una desconocida (un 404, que puede llevar cualquier cosa que alguien teclee:
 * un correo, un `k=v&z=1`) se pliega en `[...rest]`.
 *
 * Hay que dárselas hechas a `<Analytics>`: el componente de Next las calcula
 * con usePathname() + useParams(), y como Next codifica los parámetros pero no
 * la ruta, un 404 en `/es/alguien@example.com` salía como
 * `route: "/[locale]/alguien@example.com"`. `beforeSend` no llega a la ruta,
 * solo a la URL.
 */
export function rutaParaVercel(pathname: string): { route: string; path: string } {
  const { idioma, ruta } = analizar(pathname);
  const resto = ruta === null ? "/[...rest]" : ruta ? `/${ruta}` : "";
  return {
    route: `${idioma ? "/[locale]" : ""}${resto}` || "/",
    path: `${idioma ? `/${idioma}` : ""}${resto}` || "/",
  };
}

/**
 * La URL que se manda: origen más la ruta limpia de `rutaParaVercel`. Sin
 * query (ni `?code=`, ni `?next=`, ni el `gclid` de un anuncio) y sin
 * fragmento. `null` si no se puede leer: mejor no mandar nada que mandarla en
 * bruto.
 */
export function urlSinDatos(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return `${u.origin}${rutaParaVercel(u.pathname).path}`;
}

/** Toda vista y todo evento salen con la URL limpia; si no se puede limpiar, no salen. */
export function sinDatos(evento: BeforeSendEvent): BeforeSendEvent | null {
  const url = urlSinDatos(evento.url);
  return url ? { ...evento, url } : null;
}

/**
 * Las props de `<Analytics>` (el de `@vercel/analytics/react`) para una ruta:
 * el script y los envíos fijados, la ruta y el camino ya limpios y el
 * `beforeSend`. Es exactamente lo que pinta MedicionWeb, así que lo que prueba
 * eventos.test.ts es lo que sale.
 */
export function propsDeAnalytics(pathname: string) {
  return { ...RUTAS_DE_VERCEL, ...rutaParaVercel(pathname), beforeSend: sinDatos, framework: "next" } satisfies ComponentProps<typeof Analytics>;
}

/** Lo que `zonaDe` necesita de un elemento; un `Element` del DOM lo cumple. */
export interface NodoMedible {
  readonly tagName: string;
  readonly id: string;
  getAttribute(nombre: string): string | null;
  readonly parentElement: NodoMedible | null;
}

/** Un nombre de zona válido: minúsculas y guiones. Deja fuera ids generados (`«r3»-so`) y cualquier dato. */
const NOMBRE_DE_ZONA = /^[a-z]+(?:-[a-z]+)*$/;
const valida = (s: string | null): s is string => !!s && s.length <= 40 && NOMBRE_DE_ZONA.test(s);

/**
 * La zona de la página donde ocurrió algo, subiendo desde el elemento: la
 * primera `data-medir-zona` (la cabecera del sitio es `nav` y su pie,
 * `footer`, marcados en NavShell y Footer), el primer `id` con forma de
 * nombre, `main` al llegar a `<main>` y `page` si no hay nada de eso.
 *
 * No se mira la etiqueta `<header>`, `<nav>` ni `<footer>`: hay muchas dentro
 * de las páginas (la cabecera de cada página, un índice, el pie de una
 * tarjeta) y todas habrían salido como la cabecera o el pie del sitio.
 */
export function zonaDe(el: NodoMedible | null): string {
  for (let n = el; n; n = n.parentElement) {
    const marcada = n.getAttribute(ATRIBUTO_ZONA);
    if (valida(marcada)) return marcada;
    if (n.tagName.toLowerCase() === "main") return "main";
    if (valida(n.id)) return n.id;
  }
  return "page";
}

/** «Dónde», en un solo valor: `página/zona`. */
export function donde(pathname: string, el: NodoMedible | null): string {
  return `${paginaDe(pathname)}/${zonaDe(el)}`;
}
