// INTERNO: no se reexporta. Qué proveedor hay detrás de un id de modelo
// cualificado (`openai/gpt-4o-mini`), para dos cosas distintas:
//
//  · `otel`: el valor de `gen_ai.provider.name`. Son los valores «bien
//    conocidos» del registry de las GenAI semantic conventions v1.41.1, la
//    última versión PUBLICADA (2026‑05‑11):
//    https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml
//    (consultado el 2026‑09‑27). `google` va a `gcp.gen_ai` porque el registry
//    lo define como «Any Google generative AI endpoint … May be used when
//    specific backend is unknown»: con solo el prefijo no sabemos si es Vertex
//    o AI Studio.
//  · `nombre`: el `ServiceProviderName` de FOCUS, el nombre con el que el
//    proveedor aparece en la factura, para que estas filas se agrupen junto a
//    su gasto.
//
// Un prefijo que no está aquí sale TAL CUAL en OTel (es lo que el cliente
// escribió) y sin nombre en FOCUS (que no admite placeholders: el llamante
// tiene que decirlo).

interface Proveedor {
  otel: string;
  nombre: string;
}

const PROVEEDORES: Readonly<Record<string, Proveedor>> = {
  openai: { otel: "openai", nombre: "OpenAI" },
  anthropic: { otel: "anthropic", nombre: "Anthropic" },
  google: { otel: "gcp.gen_ai", nombre: "Google" },
  mistral: { otel: "mistral_ai", nombre: "Mistral AI" },
  deepseek: { otel: "deepseek", nombre: "DeepSeek" },
  groq: { otel: "groq", nombre: "Groq" },
  xai: { otel: "x_ai", nombre: "xAI" },
  cohere: { otel: "cohere", nombre: "Cohere" },
  perplexity: { otel: "perplexity", nombre: "Perplexity" },
};

/** El prefijo de proveedor de un id (`openai` en `openai/gpt-4o-mini`), si lo tiene. */
export function prefijoDe(model: string): string | undefined {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : undefined;
}

function conocido(model: string): Proveedor | undefined {
  const p = prefijoDe(model)?.toLowerCase();
  // `Object.hasOwn`: un prefijo `constructor/` o `__proto__/` no es un proveedor
  // aunque el objeto de la tabla herede esas claves.
  return p !== undefined && Object.hasOwn(PROVEEDORES, p) ? PROVEEDORES[p] : undefined;
}

/** `gen_ai.provider.name`: la tabla, o el prefijo tal cual; undefined sin prefijo. */
export function proveedorOtel(model: string): string | undefined {
  return conocido(model)?.otel ?? prefijoDe(model);
}

/** El `ServiceProviderName` de FOCUS, solo para prefijos conocidos. */
export function nombreDeProveedor(model: string): string | undefined {
  return conocido(model)?.nombre;
}

/**
 * El id sin el prefijo cuando el prefijo es CONOCIDO: es el que recibe el
 * proveedor (ver `quitarPrefijoDeProveedor`) y el que casa con las tablas de
 * precio de las herramientas de observabilidad. Con un prefijo desconocido
 * (`meta-llama/…`, una pasarela) el id completo es el nombre del modelo.
 */
export function sinPrefijoConocido(model: string): string {
  return conocido(model) ? model.slice(model.indexOf("/") + 1) : model;
}
