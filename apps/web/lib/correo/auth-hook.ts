import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * EL «SEND EMAIL HOOK» DE SUPABASE — la mitad de fontanería.
 *
 * POR QUÉ EXISTE. El proyecto de Supabase es COMPARTIDO por tres productos
 * (GPOS en app.bivelio.com, el privacy gateway y esta app), y Supabase solo
 * admite UNA plantilla de correo por proyecto. La que hay es 100 % GPOS, solo
 * en español, y construye el enlace pegando `&token_hash=…` al `redirect_to`
 * — un contrato que funciona únicamente si cada app recuerda meter un `?` en
 * su `emailRedirectTo`, y que cae en un enlace MUERTO cuando el origen no está
 * en la allow list (GoTrue lo sustituye por el site_url pelado, sin `?`).
 *
 * Con el hook, Supabase deja de mandar los correos: nos llama a nosotros con
 * los datos (destinatario, token_hash, redirect_to, tipo de acción) y esta
 * capa decide PRODUCTO por el dominio del redirect, IDIOMA por el locale que
 * viaja en él, construye el enlace con URL de verdad —el `?`/`&` deja de ser
 * responsabilidad de nadie— y envía por Resend con la plantilla del producto.
 *
 * La firma es del estándar «Standard Webhooks», que es lo que Supabase usa
 * para los hooks HTTP: HMAC-SHA256 en base64 sobre `{id}.{timestamp}.{cuerpo}`
 * con el secreto compartido, cabeceras webhook-id / webhook-timestamp /
 * webhook-signature (esta última admite varias firmas separadas por espacio).
 */

export type Producto = "savings" | "privacy" | "gpos";

/** Los tipos de acción que emite GoTrue en email_data.email_action_type. */
export type AccionAuth =
  | "signup"
  | "recovery"
  | "magiclink"
  | "invite"
  | "email_change"
  | "email"
  | "reauthentication"
  | (string & {});

export interface CabecerasFirma {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type Veredicto = { ok: true } | { ok: false; motivo: string };

/** Tolerancia de reloj: 5 minutos, como recomienda el estándar. */
const TOLERANCIA_S = 300;

/**
 * Verifica la firma Standard Webhooks. El secreto llega como lo entrega
 * Supabase (`v1,whsec_<base64>`); se aceptan también las variantes sin
 * prefijo por si alguien lo pega recortado.
 */
export function verificarFirma(
  cuerpo: string,
  cab: CabecerasFirma,
  secreto: string,
  ahoraMs: number = Date.now(),
): Veredicto {
  if (!cab.id || !cab.timestamp || !cab.signature) return { ok: false, motivo: "cabeceras" };

  const ts = Number(cab.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, motivo: "timestamp" };
  if (Math.abs(ahoraMs / 1000 - ts) > TOLERANCIA_S) return { ok: false, motivo: "reloj" };

  const clave = Buffer.from(secreto.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  if (clave.length === 0) return { ok: false, motivo: "secreto" };
  const esperada = createHmac("sha256", clave)
    .update(`${cab.id}.${cab.timestamp}.${cuerpo}`)
    .digest("base64");
  const esperadaBuf = Buffer.from(esperada);

  // Varias firmas separadas por espacio, cada una `v1,<base64>`.
  for (const parte of cab.signature.split(" ")) {
    const coma = parte.indexOf(",");
    if (coma < 0) continue;
    if (parte.slice(0, coma) !== "v1") continue;
    const firma = Buffer.from(parte.slice(coma + 1));
    if (firma.length === esperadaBuf.length && timingSafeEqual(firma, esperadaBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, motivo: "firma" };
}

/**
 * ¿De qué producto es este correo? Por el dominio del redirect que mandó la
 * app. Los previews de Vercel también se reconocen (bivelio-savings-…,
 * bivelio-privacy-…): un alta desde un preview recibe el correo del producto
 * correcto aunque GoTrue haya degradado el redirect al site_url.
 *
 * shield.bivelio.com (y sus previews bivelio-shield-…) es el MISMO producto
 * que privacy.bivelio.com con su nombre nuevo, BiVelio Shield (decisión del
 * dueño, 2026-11-15: la web se muda a shield y privacy no se apaga nunca).
 * Sin esta línea, el primer alta en shield caería en «cualquier cosa
 * desconocida» y recibiría el correo de GPOS con un enlace a app.bivelio.com.
 */
export function elegirProducto(redirectTo: string | null | undefined): Producto {
  const s = (redirectTo ?? "").toLowerCase();
  if (s.includes("savings.bivelio.com") || s.includes("bivelio-savings")) return "savings";
  if (s.includes("privacy.bivelio.com") || s.includes("bivelio-privacy")) return "privacy";
  if (s.includes("shield.bivelio.com") || s.includes("bivelio-shield")) return "privacy";
  // app.bivelio.com, el site_url de respaldo y cualquier cosa desconocida.
  return "gpos";
}

import { IDIOMAS, type Idioma } from "./invitacion";

/**
 * El idioma viaja dentro del redirect (p. ej. `…/auth/callback?next=/en/dashboard`
 * o `…?next=%2Fes%2F…`). Se busca el primer segmento que sea uno de los doce.
 * Sin pista → español, que es el idioma de la plataforma.
 */
export function idiomaDe(redirectTo: string | null | undefined): Idioma {
  let s = redirectTo ?? "";
  try {
    s = decodeURIComponent(s);
  } catch {
    /* un %-escape roto no impide buscar en la cadena tal cual */
  }
  const m = s.match(/(?:^|[/=])([a-z]{2})(?=[/&?#]|$)/g);
  for (const trozo of m ?? []) {
    const cand = trozo.replace(/^[/=]/, "");
    if ((IDIOMAS as string[]).includes(cand)) return cand as Idioma;
  }
  return "es";
}

/** El callback por defecto de cada producto, para cuando el redirect llega vacío o roto. */
const CALLBACK_POR_DEFECTO: Record<Producto, string> = {
  savings: "https://savings.bivelio.com/auth/callback",
  privacy: "https://privacy.bivelio.com/auth/callback",
  gpos: "https://app.bivelio.com/auth/callback",
};

/** Lo que leemos del entorno; `process.env` en producción, un objeto en los tests. */
export type Entorno = Readonly<Record<string, string | undefined>>;

/**
 * EL INTERRUPTOR DEL DÍA DEL CAMBIO DE DOMINIO. Vacía (hoy), el callback por
 * defecto de privacy sigue siendo privacy.bivelio.com; el día que la web pase
 * a shield.bivelio.com basta con poner aquí `https://shield.bivelio.com/auth/callback`
 * en Vercel y redesplegar — sin tocar código. Deshacer = borrarla.
 */
export const VAR_CALLBACK_PRIVACY = "BVSALA_CORREO_CALLBACK_PRIVACY";

/** Los únicos dominios donde vive el producto privacy (el nombre viejo y el nuevo). */
const HOSTS_PRIVACY: ReadonlySet<string> = new Set(["privacy.bivelio.com", "shield.bivelio.com"]);

/**
 * El callback por defecto del producto, con el de privacy configurable. Un
 * valor que no sea un https a uno de los dos dominios de privacy se IGNORA
 * (y se avisa en el registro): una errata en la variable no puede mandar
 * enlaces de sesión a otro sitio; como mucho deja el de siempre, que sigue
 * vivo porque privacy.bivelio.com no se apaga.
 */
export function callbackPorDefecto(producto: Producto, env: Entorno = process.env): string {
  const configurado = producto === "privacy" ? env[VAR_CALLBACK_PRIVACY]?.trim() : "";
  if (configurado) {
    try {
      const u = new URL(configurado);
      if (u.protocol === "https:" && HOSTS_PRIVACY.has(u.hostname) && !u.port && !u.username && !u.password) {
        return u.toString();
      }
    } catch {
      /* cae al aviso de abajo */
    }
    console.warn(`[auth/correo] ${VAR_CALLBACK_PRIVACY} no es un https a privacy/shield.bivelio.com: se usa el callback de siempre`);
  }
  return CALLBACK_POR_DEFECTO[producto];
}

/** Adónde lleva el enlace: el redirect de la app si es una URL, si no el callback por defecto. */
function destinoDelEnlace(producto: Producto, redirectTo: string | null | undefined, env: Entorno): URL {
  if (redirectTo) {
    try {
      return new URL(redirectTo);
    } catch {
      /* redirect roto: al callback del producto */
    }
  }
  return new URL(callbackPorDefecto(producto, env));
}

/**
 * Con qué NOMBRE se presenta el correo. Privacy y BiVelio Shield son el mismo
 * producto (misma cuenta, mismas licencias) con dos nombres mientras dura la
 * mudanza de dominio, y el correo lleva el nombre del dominio al que apunta
 * su enlace: un alta en privacy.bivelio.com recibe el correo de siempre; una
 * en shield.bivelio.com, el de BiVelio Shield. El día del cambio la web nueva
 * manda sus redirects a shield y los correos cambian de nombre solos.
 */
export type Marca = Producto | "shield";

export function elegirMarca(
  producto: Producto,
  redirectTo: string | null | undefined,
  env: Entorno = process.env,
): Marca {
  if (producto !== "privacy") return producto;
  const host = destinoDelEnlace(producto, redirectTo, env).hostname.toLowerCase();
  return host === "shield.bivelio.com" || host.startsWith("bivelio-shield") ? "shield" : "privacy";
}

/**
 * El enlace del correo, construido con URL de verdad. Aquí muere el contrato
 * frágil de la plantilla vieja: daba igual si el redirect traía `?` o no —
 * URLSearchParams pone `?` o `&` según toque, siempre bien.
 */
export function construirEnlace(
  producto: Producto,
  redirectTo: string | null | undefined,
  tokenHash: string,
  tipo: string,
  env: Entorno = process.env,
): string {
  const url = destinoDelEnlace(producto, redirectTo, env);
  // El site_url pelado («https://app.bivelio.com») no es un callback: se le da
  // la ruta que sus tres apps comparten.
  if (url.pathname === "/" && !url.search) url.pathname = "/auth/callback";
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", tipo);
  return url.toString();
}

/** La carga útil del hook, en lo que usamos de ella. */
export interface CargaHook {
  user?: { email?: string };
  email_data?: {
    token?: string;
    token_hash?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
  };
}
