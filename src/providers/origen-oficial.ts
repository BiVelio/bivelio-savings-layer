// ═══════════════════════════════════════════════════════════════════════════
// EL ORIGEN OFICIAL DE UN PROVEEDOR, POR LA URL Y SOLO POR LA URL.
// ═══════════════════════════════════════════════════════════════════════════
//
// El precio de lista del catálogo (`pricing/catalogo.ts`) solo es la factura
// cuando se habla con el API del PROPIO proveedor. Detrás de un proxy (LiteLLM),
// de un gateway, de Azure, Bedrock o Vertex, de un revendedor o de un modelo
// local sirviendo con un nombre del catálogo, lo que se paga es otra cosa —o
// nada—, y un contador leído allí no se puede valorar a precio de lista.
//
// Oficiales son EXACTAMENTE los orígenes cuyos precios tarifa el catálogo:
//
//   · https://api.anthropic.com                  → Anthropic (su tabla oficial);
//   · https://api.openai.com                     → OpenAI;
//   · https://generativelanguage.googleapis.com  → Google, el API de Gemini, que
//     es el que publica la página de precios que copia el catálogo
//     (ai.google.dev/gemini-api/docs/pricing). Lo hablan dos adaptadores: el
//     nativo (`GoogleProvider`, `generateContent`) y el compatible con OpenAI
//     (`/v1beta/openai/`); mismo origen y misma factura.
//
// Nada más. Un proveedor que el catálogo no tarifa (DeepSeek, Mistral, Groq…)
// no tiene precio de lista que defender aunque se le hable en su propio host, y
// su origen cuenta como no oficial: lo que valga lo dice `costModels`, que es
// del cliente.
//
// Se compara el ORIGEN entero, como hace el gateway (`esUpstreamOficial`,
// gateway/upstream.ts): https, host exacto y puerto por defecto. Un host oficial
// por http, o en otro puerto, no es el API oficial. Mayúsculas y un `:443`
// explícito no cambian nada (`URL` los normaliza), y la ruta no cuenta.
//
// DIFERENCIA CON EL GATEWAY, a propósito: el gateway solo conoce los orígenes de
// OpenAI y Anthropic porque solo habla esos dos dialectos (`--upstream openai |
// anthropic`); con `--upstream https://generativelanguage.googleapis.com` lo
// trataría como no oficial. Aquí Google sí es oficial porque el adaptador
// compatible con OpenAI habla con su endpoint y el catálogo tarifa Gemini.
//
// PURO Y SIN IMPORTS: lo usan los adaptadores de este paquete (el tier, el modo
// explícito de caché, los lotes y el atestado de origen de la referencia) y
// también los adaptadores de MARCOS, que van en otro bundle y solo pueden copiar
// módulos puros (`test/adaptadores/solo-superficie-publica.test.ts`). NO se
// reexporta por ningún barril.

/** El API oficial de un proveedor que el catálogo tarifa. */
export type ApiOficial = "anthropic" | "openai" | "google";

const HOSTS_OFICIALES: Readonly<Record<string, ApiOficial>> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "google",
};

/** El API oficial que es esta URL, o `null` (otro host, http, otro puerto o no es una URL). */
export function apiOficialDe(url: string | undefined): ApiOficial | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.port !== "") return null;
    return HOSTS_OFICIALES[u.hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

/**
 * Lo que un adaptador de este paquete ATESTIGUA sobre a quién habla. Ausente
 * (`undefined`) es DESCONOCIDO: un proveedor propio del cliente o un marco que no
 * enseña su base URL por una API pública.
 */
export type OrigenAtestiguado = "oficial" | "no-oficial";

/** El origen que atestigua una base URL conocida. */
export function origenDeLaUrl(url: string): OrigenAtestiguado {
  return apiOficialDe(url) !== null ? "oficial" : "no-oficial";
}

/**
 * EL CANAL DE LOS ADAPTADORES DE MARCOS. Van en OTRO bundle
 * (`dist/adapters/*.js`) y cargan el núcleo por el nombre del paquete, así que
 * no pueden escribir en el WeakMap del núcleo (`atestado-del-cable.ts`): su
 * copia sería otra instancia. El proveedor puente que crean
 * (`adapters/comun/puente.ts`) lleva, bajo esta clave del registro GLOBAL de
 * símbolos (la misma en los dos bundles), una función que devuelve el origen
 * de la llamada del marco EN CURSO.
 *
 * No está en ningún tipo publicado. Y no concede nada: solo `"no-oficial"`
 * cambia la regla (E0-bis de `pipeline/referencia.ts`), y lo que cambia es que
 * NO se escribe un registro de referencia. Quien la imite solo puede quitarse
 * comisión a sí mismo.
 */
export const CLAVE_DEL_ORIGEN: symbol = Symbol.for("@bivelio/savings-layer:provider-origin");
